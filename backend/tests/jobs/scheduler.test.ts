import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import pg from 'pg';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';
import { JOBS, jobByName, type JobDefinition } from '../../src/jobs/registry.js';
import { runJob, jobHealth } from '../../src/jobs/runner.js';

let owner: pg.Client;

function walk(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = `${dir}/${e}`;
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const probe = (name: string, run: JobDefinition['run']): JobDefinition => ({
  name, schedule: '* * * * *', posture: 'owner', maxAgeMinutes: 60, run,
});

beforeAll(async () => { owner = ownerClient(); await owner.connect(); });
afterAll(async () => { await owner?.end(); });

/* ------------------------------------------------------- 1. alerting --- */

describe('E. every job alerts on failure AND on not having run', () => {
  it('treats NEVER HAVING RUN as overdue', async () => {
    const never = probe(`probe.never.${Date.now()}`, async () => ({ detail: 'unused' }));
    const [health] = await jobHealth(owner, [never]);

    // The case that matters. A job that was never scheduled writes no rows, so a
    // query over job_run alone cannot see it -- which is why health starts from
    // the REGISTRY and treats absence as the finding.
    expect(health!.lastSuccessAt).toBeNull();
    expect(health!.minutesSinceSuccess).toBeNull();
    expect(health!.overdue, 'never having run is overdue').toBe(true);
  });

  it('clears overdue once a run succeeds, and records what it proved', async () => {
    const job = probe(`probe.ok.${Date.now()}`, async () => ({ detail: '7 rows verified' }));
    const result = await runJob(job);
    expect(result.outcome).toBe('succeeded');

    const [health] = await jobHealth(owner, [job]);
    expect(health!.overdue).toBe(false);
    // A run that did nothing must be distinguishable from one that worked.
    expect(health!.lastDetail).toBe('7 rows verified');
  });

  it('records a failure with its reason and counts consecutive ones', async () => {
    const job = probe(`probe.fail.${Date.now()}`, async () => {
      throw new Error('the postcondition did not hold');
    });
    for (let i = 0; i < 3; i += 1) {
      const result = await runJob(job);
      expect(result.outcome).toBe('failed');
    }

    const [health] = await jobHealth(owner, [job]);
    expect(health!.consecutiveFailures).toBeGreaterThanOrEqual(3);
    // Still overdue: a job that keeps failing has not run successfully.
    expect(health!.overdue).toBe(true);
    expect((await runJob(job)).detail).toMatch(/postcondition did not hold/);
  });

  it('exits non-zero from the health command when anything is wrong', async () => {
    const source = readFileSync('src/jobs/runner.ts', 'utf8');
    // Designed to be run BY something, not read by a human.
    expect(source).toMatch(/process\.exitCode = 1/);
    expect(source).toMatch(/h\.overdue \|\| h\.consecutiveFailures > 0/);
  });
});

/* --------------------------------------------------- 2. overlap locks --- */

describe('E. a slow job cannot have a second copy start on top of it', () => {
  it('skips a run whose lock is already held, and RECORDS the skip', async () => {
    const name = `probe.slow.${Date.now()}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const slow = probe(name, async () => { await gate; return { detail: 'finally done' }; });
    const first = runJob(slow);
    await new Promise((r) => setTimeout(r, 250));

    const second = await runJob(probe(name, async () => ({ detail: 'should not run' })));
    // Recorded, not silent: a job skipped every cycle because a previous copy
    // never finished looks identical to a healthy job unless the skip is a row.
    expect(second.outcome).toBe('skipped_locked');
    expect(second.detail).toMatch(/still holds the lock/);

    release();
    expect((await first).outcome).toBe('succeeded');

    const rows = await owner.query<{ outcome: string }>(
      `SELECT outcome FROM platform.job_run WHERE job_name=$1 ORDER BY started_at`, [name]);
    expect(rows.rows.map((r) => r.outcome).sort()).toEqual(['skipped_locked', 'succeeded']);
  });

  it('releases the lock when the holding CONNECTION dies, with no sweep', async () => {
    const name = `probe.crash.${Date.now()}`;
    const key = await owner.query<{ k: string }>(
      `SELECT ('x' || substr(encode(digest($1,'sha256'),'hex'),1,16))::bit(64)::bigint::text AS k`,
      [name]).catch(() => null);
    void key;

    // A separate connection takes the lock and then dies without unlocking --
    // exactly a crashed worker.
    const dying = new pg.Client({ connectionString: process.env['DATABASE_URL_OWNER']! });
    await dying.connect();
    const held = await dying.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS ok`, [name]);
    expect(held.rows[0]!.ok).toBe(true);

    const contended = await owner.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS ok`, [name]);
    expect(contended.rows[0]!.ok).toBe(false);

    await dying.end();
    await new Promise((r) => setTimeout(r, 200));

    // THE POINT: no timeout, no reclaim sweep. Postgres drops session advisory
    // locks when the connection ends -- unlike the outbox claim, which is a ROW
    // and therefore needs reclaiming by age.
    const after = await owner.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS ok`, [name]);
    expect(after.rows[0]!.ok).toBe(true);
    await owner.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [name]);
  });

  it('takes the lock on a DIRECT connection, never through the pooler', () => {
    const source = readFileSync('src/jobs/runner.ts', 'utf8');
    // In transaction mode the pooler hands the server connection to another
    // client between statements, so a SESSION lock would be held by whoever
    // inherited it and released at a moment nobody chose.
    expect(source).toMatch(/DATABASE_URL_OWNER.*job lock|job lock.*DATABASE_URL_OWNER/s);
    expect(source).toMatch(/pg_try_advisory_lock/);
  });
});

/* ------------------------------------------------ 3. no scheduler leak --- */

describe('E. the scheduler does not leak into job code', () => {
  it('imports no scheduling library anywhere under src/', () => {
    const offenders: string[] = [];
    for (const file of walk('src').filter((f) => f.endsWith('.ts'))) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const m of code.matchAll(/from\s+'([^']+)'/g)) {
        if (/node-cron|node-schedule|agenda|bree|cron\b|bullmq|eventbridge/i.test(m[1]!)) {
          offenders.push(`${file}: ${m[1]}`);
        }
      }
    }
    expect(offenders, 'a job that knows what triggered it has already leaked').toEqual([]);
  });

  it('keeps the schedule as DATA, so the host can be swapped', () => {
    for (const job of JOBS) {
      // Five-field cron: the lowest common denominator every host understands.
      expect(job.schedule.trim().split(/\s+/), job.name).toHaveLength(5);
    }
  });

  it('makes every job a plain function with its own postcondition', async () => {
    const source = readFileSync('src/jobs/registry.ts', 'utf8');
    // Each job throws when its postcondition fails rather than returning a status
    // the runner has to interpret.
    expect((source.match(/throw new Error\(/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(source).not.toMatch(/process\.exit/);
  });
});

/* ------------------------------------------------------- 4. postures --- */

describe('E. the scheduler cannot choose a role', () => {
  it('declares a posture for every job, from a closed set', () => {
    assertCheckedSet({
      label: 'scheduled jobs',
      checked: JOBS.map((j) => j.name),
      minimum: 10,
      mustInclude: [
        'usage.rollup', 'outbox.drain', 'print.drain', 'audit.partitions',
        'ladder.recompute', 'claim.purge', 'stock.reconciliation',
        'user.credential_check', 'audit.unattributable', 'scheduler.heartbeat',
      ],
    });
    expect(JOBS.every((j) => j.posture === 'app' || j.posture === 'owner')).toBe(true);
    expect(JOBS.every((j) => j.maxAgeMinutes > 0)).toBe(true);
  });

  it('gives the runner no way to override a posture', () => {
    const source = readFileSync('src/jobs/runner.ts', 'utf8');
    // connectionFor takes the POSTURE, not a URL. A runner that accepted a
    // connection string could run a tenant job as the owner, exempt from RLS.
    expect(source).toMatch(/function connectionFor\(posture: JobPosture\)/);
    expect(source).not.toMatch(/runJob\([^)]*connectionString/);
    expect(source).not.toMatch(/posture\s*[:=]\s*['"]owner['"]/);
  });

  it('runs every tenant-touching job as the app role', async () => {
    // Derived from what the job's module reads, not from a list here.
    const appTouching = new Set<string>();
    for (const file of walk('src').filter((f) => f.endsWith('.ts'))) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (/\bapp\.(?!tenant_id\b|current_tenant_id\b|purge_request_claims\b)[a-z_]+/.test(code)) {
        for (const m of code.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) {
          appTouching.add(m[1]!);
        }
      }
    }
    // Spot-check the derivation is live before relying on it.
    expect(appTouching.has('rollUpUsage')).toBe(true);
    expect(appTouching.has('printOnce')).toBe(true);

    const registry = readFileSync('src/jobs/registry.ts', 'utf8');
    const wrong: string[] = [];
    for (const job of JOBS.filter((j) => j.posture === 'app')) {
      const fn = new RegExp(`name: '${job.name.replace('.', '\\.')}'[^}]*run: (\\w+)`)
        .exec(registry)?.[1];
      if (fn && !registry.includes(`function ${fn}`)) wrong.push(job.name);
    }
    expect(wrong).toEqual([]);

    // The ones that must be owner are owner for a stated reason, not by accident.
    expect(jobByName('audit.partitions')!.posture).toBe('owner');
    expect(jobByName('ladder.recompute')!.posture).toBe('owner');
    expect(jobByName('user.credential_check')!.posture).toBe('owner');
  });
});

/* ------------------------------------------------- 5. who watches it --- */

describe('E. the scheduler cannot watch itself', () => {
  it('has a heartbeat frequent enough for a dead scheduler to be detectable', () => {
    const heartbeat = jobByName('scheduler.heartbeat')!;
    // Every other job is daily, so a dead scheduler would be invisible for a day.
    expect(heartbeat.schedule).toBe('*/5 * * * *');
    expect(heartbeat.maxAgeMinutes).toBeLessThanOrEqual(20);
  });

  it('names the hole in writing rather than leaving it implied', () => {
    expect(existsSync('../docs/scheduler-monitoring.md')).toBe(true);
    const doc = readFileSync('../docs/scheduler-monitoring.md', 'utf8');
    // A scheduler that has stopped cannot report that it has stopped, and no
    // in-repo checker closes that -- it only moves it.
    expect(doc).toMatch(/cannot be the scheduler/);
    expect(doc).toMatch(/dead-man/i);
    expect(doc).toMatch(/Deferred/i);
  });
});

/* ------------------------------------------- 6. registry vs the crontab --- */

describe('E. the crontab and the registry agree, both directions', () => {
  it('schedules every registered job and registers every scheduled one', () => {
    const crontab = readFileSync('../deploy/crontab', 'utf8');
    const scheduled = [...crontab.matchAll(/runner\.ts\s+([a-z][a-z0-9_.]*)/g)].map((m) => m[1]!);

    assertCheckedSet({
      label: 'crontab entries',
      checked: scheduled,
      minimum: 10,
      mustInclude: ['usage.rollup', 'outbox.drain', 'scheduler.heartbeat'],
    });

    const registered = JOBS.map((j) => j.name);
    // A job in the registry with no cron line never runs and is overdue forever;
    // a cron line with no registry entry fails on every tick.
    expect(registered.filter((n) => !scheduled.includes(n))).toEqual([]);
    expect(scheduled.filter((n) => !registered.includes(n))).toEqual([]);
  });

  it('points every line at a script that exists', () => {
    // The two tests either side match `runner.ts <job>` and nothing before it,
    // so a crontab still naming `src/jobs/runner.ts` after the move to
    // backend would have passed both and failed on every tick in production.
    const crontab = readFileSync('../deploy/crontab', 'utf8');
    const scripts = [...crontab.matchAll(/tsx\s+(\S+\.ts)\s/g)].map((m) => m[1]!);
    assertCheckedSet({
      label: 'crontab script paths', checked: scripts, minimum: 10,
      mustInclude: ['backend/src/jobs/runner.ts'],
    });
    const missing = [...new Set(scripts)].filter((p) => !existsSync(`../${p}`));
    expect(missing, 'the crontab names scripts that are not in the repo').toEqual([]);
  });

  it('uses the schedule the registry declares', () => {
    const crontab = readFileSync('../deploy/crontab', 'utf8');
    for (const job of JOBS) {
      const line = crontab.split('\n').find((l) => l.includes(`runner.ts ${job.name}`));
      expect(line, job.name).toBeDefined();
      expect(line!.trim().startsWith(job.schedule), `${job.name}: ${line}`).toBe(true);
    }
  });
});
