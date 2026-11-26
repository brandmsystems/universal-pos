import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import pg from 'pg';
import { JOBS, jobByName, type JobDefinition, type JobPosture } from './registry.js';

/**
 * The job runner.
 *
 * ###########################################################################
 * THE ROLE COMES FROM THE REGISTRY, NEVER FROM THE CALLER.
 *
 * There is no parameter here for a connection string and no way to override a
 * job's posture. A scheduler that could choose would eventually run a
 * tenant-touching job as the owner -- exempt from RLS -- and a predicate bug
 * would then merge two tenants into one answer instead of returning nothing.
 * ###########################################################################
 */
function connectionFor(posture: JobPosture): string {
  const url = posture === 'app'
    ? process.env['DATABASE_URL_APP']
    : process.env['DATABASE_URL_OWNER'];
  if (!url) {
    throw new Error(
      `job posture '${posture}' needs ` +
        `${posture === 'app' ? 'DATABASE_URL_APP' : 'DATABASE_URL_OWNER'}`,
    );
  }
  return url;
}

/** 64-bit key from the job name, so two schedulers agree without a shared table. */
function lockKey(name: string): bigint {
  const digest = createHash('sha256').update(name).digest();
  return digest.readBigInt64BE(0);
}

export type RunOutcome = 'succeeded' | 'failed' | 'skipped_locked';

export interface RunResult {
  readonly job: string;
  readonly outcome: RunOutcome;
  readonly detail: string;
  readonly durationMs: number;
}

/**
 * ###########################################################################
 * OVERLAP PREVENTION, AND WHY A STALE LOCK CANNOT HAPPEN HERE.
 *
 * A slow drain must not have a second copy start on top of it. The mechanism is
 * a SESSION-level advisory lock, and the reason it is the right one is what
 * happens when the holder dies: Postgres releases session advisory locks when
 * the connection ends, including when the backend notices a dead TCP peer. There
 * is no timeout to tune and no sweep to write -- unlike the outbox claim, which
 * is a ROW and therefore needs reclaiming by age.
 *
 * That is also why the lock is taken on a DIRECT connection and never through
 * PgBouncer. In transaction mode the pooler hands the server connection to
 * someone else between statements, so a session lock would be held by whichever
 * client happened to inherit it -- and released at a moment nobody chose. The
 * lock connection is always the direct owner URL; the job's own work may still
 * go through the pooler.
 * ###########################################################################
 */
async function withJobLock<T>(
  jobName: string,
  fn: () => Promise<T>,
): Promise<T | 'locked'> {
  const direct = process.env['DATABASE_URL_OWNER'];
  if (!direct) throw new Error('DATABASE_URL_OWNER is required for the job lock');

  const lockClient = new pg.Client({ connectionString: direct });
  await lockClient.connect();
  try {
    const acquired = await lockClient.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock($1::bigint) AS ok`, [lockKey(jobName).toString()],
    );
    if (!acquired.rows[0]!.ok) return 'locked';
    return await fn();
  } finally {
    // Explicit release for the ordinary path; the disconnect below is what makes
    // the crash path safe.
    await lockClient.query(`SELECT pg_advisory_unlock($1::bigint)`, [lockKey(jobName).toString()])
      .catch(() => undefined);
    await lockClient.end().catch(() => undefined);
  }
}

export async function runJob(job: JobDefinition): Promise<RunResult> {
  const runId = randomUUID();
  const startedAt = Date.now();
  const ranBy = `${hostname()}:${process.pid}`;

  const record = async (
    outcome: RunOutcome, detail: string,
  ): Promise<RunResult> => {
    const durationMs = Date.now() - startedAt;
    // The ledger is written as the OWNER regardless of the job's posture: it is a
    // control-plane table, and a tenant-posture job must not need a grant on it.
    const ledger = new pg.Client({ connectionString: process.env['DATABASE_URL_OWNER']! });
    await ledger.connect();
    try {
      await ledger.query(
        `INSERT INTO platform.job_run
           (id, job_name, started_at, finished_at, outcome, detail, duration_ms, ran_by)
         VALUES ($1,$2,to_timestamp($3/1000.0),now(),$4,$5,$6,$7)`,
        [runId, job.name, startedAt, outcome, detail.slice(0, 4000), durationMs, ranBy],
      );
    } finally {
      await ledger.end().catch(() => undefined);
    }
    return { job: job.name, outcome, detail, durationMs };
  };

  const result = await withJobLock(job.name, async (): Promise<RunResult> => {
    const client = new pg.Client({ connectionString: connectionFor(job.posture) });
    await client.connect();
    try {
      const outcome = await job.run(client);
      return await record('succeeded', outcome.detail);
    } catch (error) {
      return await record('failed', error instanceof Error ? error.message : String(error));
    } finally {
      await client.end().catch(() => undefined);
    }
  });

  if (result === 'locked') {
    // Recorded, not silent: a job skipped every cycle because a previous copy
    // never finished looks identical to a healthy job unless the skip is a row.
    return record('skipped_locked', 'a previous run of this job still holds the lock');
  }
  return result;
}

/* -------------------------------------------------------------- health --- */

export interface JobHealth {
  readonly job: string;
  readonly schedule: string;
  readonly lastSuccessAt: string | null;
  readonly minutesSinceSuccess: number | null;
  readonly maxAgeMinutes: number;
  /** No successful run inside its window. NEVER HAVING RUN counts. */
  readonly overdue: boolean;
  readonly consecutiveFailures: number;
  readonly lastDetail: string | null;
  readonly inFlightSince: string | null;
}

/**
 * Health is computed from the REGISTRY against the ledger, not from the ledger
 * alone.
 *
 * A job that was never scheduled writes no rows at all, so a query over job_run
 * cannot see it. Starting from the registry is what makes "never ran" visible --
 * and it is the case that matters, because the failure is silent and the systems
 * these jobs protect degrade slowly.
 */
export async function jobHealth(
  client: pg.ClientBase,
  jobs: readonly JobDefinition[] = JOBS,
): Promise<readonly JobHealth[]> {
  const rows = await client.query<{
    job_name: string; last_success: string | null; minutes: string | null;
    last_detail: string | null; in_flight: string | null; consecutive_failures: string;
  }>(
    `WITH last_success AS (
       SELECT DISTINCT ON (job_name) job_name, finished_at, detail
         FROM platform.job_run WHERE outcome = 'succeeded'
        ORDER BY job_name, finished_at DESC
     ),
     in_flight AS (
       SELECT DISTINCT ON (job_name) job_name, started_at
         FROM platform.job_run WHERE finished_at IS NULL
        ORDER BY job_name, started_at DESC
     ),
     recent AS (
       SELECT job_name, outcome,
              row_number() OVER (PARTITION BY job_name ORDER BY started_at DESC) AS rn
         FROM platform.job_run WHERE outcome IS NOT NULL
     )
     SELECT j.job_name,
            s.finished_at::text                                   AS last_success,
            EXTRACT(EPOCH FROM (now() - s.finished_at))::text      AS minutes,
            s.detail                                              AS last_detail,
            f.started_at::text                                    AS in_flight,
            COALESCE((SELECT count(*) FROM recent r
                       WHERE r.job_name = j.job_name AND r.outcome = 'failed'
                         AND r.rn <= (SELECT COALESCE(min(rn), 999) FROM recent ok
                                       WHERE ok.job_name = j.job_name
                                         AND ok.outcome = 'succeeded')), 0)::text
                                                                  AS consecutive_failures
       FROM (SELECT unnest($1::text[]) AS job_name) j
       LEFT JOIN last_success s ON s.job_name = j.job_name
       LEFT JOIN in_flight f ON f.job_name = j.job_name`,
    [jobs.map((j) => j.name)],
  );

  const byName = new Map(rows.rows.map((r) => [r.job_name, r]));

  return jobs.map((job) => {
    const row = byName.get(job.name);
    const seconds = row?.minutes === null || row?.minutes === undefined
      ? null : Number(row.minutes);
    const minutesSinceSuccess = seconds === null ? null : Math.floor(seconds / 60);
    return {
      job: job.name,
      schedule: job.schedule,
      lastSuccessAt: row?.last_success ?? null,
      minutesSinceSuccess,
      maxAgeMinutes: job.maxAgeMinutes,
      // Never having run is overdue. That is the whole point of starting from
      // the registry rather than from the rows.
      overdue: minutesSinceSuccess === null || minutesSinceSuccess > job.maxAgeMinutes,
      consecutiveFailures: Number(row?.consecutive_failures ?? '0'),
      lastDetail: row?.last_detail ?? null,
      inFlightSince: row?.in_flight ?? null,
    };
  });
}

export async function main(): Promise<void> {
  const name = process.argv[2];

  if (!name || name === '--health') {
    const client = new pg.Client({ connectionString: process.env['DATABASE_URL_OWNER']! });
    await client.connect();
    try {
      const health = await jobHealth(client);
      for (const h of health) {
        const age = h.minutesSinceSuccess === null ? 'never' : `${h.minutesSinceSuccess}m ago`;
        console.log(
          `${h.overdue ? 'OVERDUE' : 'ok     '} ${h.job.padEnd(26)} ${age.padStart(10)}` +
            `  (window ${h.maxAgeMinutes}m)${h.consecutiveFailures > 0 ? ` failures=${h.consecutiveFailures}` : ''}`,
        );
      }
      if (health.some((h) => h.overdue || h.consecutiveFailures > 0)) process.exitCode = 1;
    } finally {
      await client.end();
    }
    return;
  }

  const job = jobByName(name);
  if (!job) {
    console.error(`unknown job '${name}'. Known: ${JOBS.map((j) => j.name).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const result = await runJob(job);
  console.log(`${result.job}: ${result.outcome} in ${result.durationMs}ms -- ${result.detail}`);
  if (result.outcome === 'failed') process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
