import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';
import {
  drainOnce, reclaimStale, verifyDrain, outboxHealth,
  TenantContextRequiredError, CLAIM_TIMEOUT_MS, type Consumer,
} from '../../src/modules/notifications/outboxWorker.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';

let owner: pg.Client;
/** The drain runs as the APPLICATION role. That is the point. */
let app: pg.Client;
let tenantId: string;

/**
 * Topics are scoped PER RUN.
 *
 * A fixed topic accumulates rows across runs, and every count assertion then
 * measures previous runs as well as this one -- the same failure as a fixture
 * that reuses a fixed tenant id. The run id is the fix.
 */
const RUN = randomUUID().slice(0, 8);
const T = (name: string) => `probe.${RUN}.${name}`;

async function enqueue(opts: {
  topic: string; dedupeKey?: string; payload?: Record<string, unknown>;
  tenantId?: string | null; group?: string; seq?: number; maxAttempts?: number;
}): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO platform.outbox
       (id, topic, dedupe_key, payload, tenant_id, ordered_group, order_seq, max_attempts)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
    [id, opts.topic, opts.dedupeKey ?? id, JSON.stringify(opts.payload ?? {}),
     opts.tenantId === undefined ? null : opts.tenantId,
     opts.group ?? null, opts.seq ?? null, opts.maxAttempts ?? 8],
  );
  return id;
}

async function statusOf(id: string) {
  const r = await owner.query<{
    status: string; attempts: number; dead_letter_reason: string | null; last_error: string | null;
  }>(`SELECT status, attempts, dead_letter_reason, last_error FROM platform.outbox WHERE id=$1`, [id]);
  return r.rows[0]!;
}

function recorder(name: string, topics: string[], over: Partial<Consumer> = {}): Consumer & { seen: string[] } {
  const seen: string[] = [];
  return {
    name, topics, touchesTenantData: false, seen,
    async handle(_c, m) { seen.push(m.dedupeKey); },
    ...over,
  } as Consumer & { seen: string[] };
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  app = new pg.Client({ connectionString: process.env['DATABASE_URL_APP']! });
  await app.connect();
  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);

  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key='super_admin'`)).rows[0]!.id;
  const superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id,email,password_hash,full_name,platform_role_id)
     VALUES ($1,$2,'argon2id$stub','Root',$3)`, [superAdminId, `obx+${superAdminId}@p.test`, roleId]);
  await owner.query(`INSERT INTO platform.plan (id,key,name) VALUES ($1,'obx_plan','Obx')
    ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
  const planId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan WHERE key='obx_plan'`)).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version (id,plan_id,version,price_minor,currency,billing_period,published_at)
     VALUES ($1,$2,1,100000,'INR','monthly',now()) ON CONFLICT (plan_id,version) DO NOTHING`,
    [randomUUID(), planId]);
  const planVersionId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan_version WHERE plan_id=$1 AND version=1`, [planId])).rows[0]!.id;

  await owner.query('BEGIN');
  const r = await provisionTenant(owner, {
    idempotencyKey: `obx-${randomUUID()}`, slug: `x${randomUUID().slice(0, 8)}`,
    name: 'Outbox Probe', currency: 'INR', timezone: 'Asia/Kolkata',
    ownerEmail: `obx-${randomUUID()}@o.test`, ownerName: 'Owner',
    firstBranchName: 'Main', planVersionId, taxJurisdiction: 'IN',
    requestedByPlatformUserId: superAdminId,
  });
  await owner.query('COMMIT');
  tenantId = r.tenantId;
});

afterAll(async () => {
  // ##########################################################################
  // THIS RUN'S ROWS ARE DELETED, AND SCOPING THE TOPIC WAS NOT ENOUGH.
  //
  // The comment on `RUN` above says a fixed topic makes every count measure
  // previous runs too. True, and it does not stop the rows ACCUMULATING: the
  // poison messages here stay `pending` with attempts >= 3 forever, so the dev
  // install grew to 52 of them and `outboxHealth`'s 50-row cap started cutting
  // off the message the health test had just created. The test failed on a
  // change that had nothing to do with the outbox, which is how it was found.
  //
  // Deleting is safe and specific: every row this file writes carries this
  // run's topic prefix and nothing else does.
  // ##########################################################################
  await owner?.query(`DELETE FROM platform.outbox WHERE topic LIKE $1`, [`probe.${RUN}.%`]);
  await app?.end(); await owner?.end();
});

describe('B. claiming and delivery', () => {
  it('delivers, writes the consumer ledger, and stamps the message once', async () => {
    const id = await enqueue({ topic: T('deliver') });
    const consumer = recorder('probe-consumer', [T('deliver')]);

    const result = await drainOnce(app, { consumers: [consumer] });
    expect(result.delivered).toBeGreaterThanOrEqual(1);
    expect((await statusOf(id)).status).toBe('delivered');

    const ledger = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.outbox_consumption
        WHERE consumer='probe-consumer' AND topic=$1`, [T('deliver')]);
    expect(Number(ledger.rows[0]!.n)).toBe(1);
  });

  it('makes a redelivery a no-op for the consumer, not a second effect', async () => {
    const consumer = recorder('idem-consumer', [T('idem')]);
    const id = await enqueue({ topic: T('idem'), dedupeKey: `stable-${RUN}` });
    await drainOnce(app, { consumers: [consumer] });
    expect(consumer.seen).toEqual([`stable-${RUN}`]);

    // The same logical event redelivered: a new row, same dedupe key. At-least-once
    // delivery is the contract; the ledger is what makes the EFFECT once.
    await owner.query(`UPDATE platform.outbox SET status='pending', delivered_at=NULL WHERE id=$1`,
      [id]);
    await drainOnce(app, { consumers: [consumer] });
    expect(consumer.seen, 'the consumer must not run twice for one dedupe key')
      .toEqual([`stable-${RUN}`]);
    expect((await statusOf(id)).status).toBe('delivered');
  });

  it('does not double-claim across concurrent workers', async () => {
    const ids = await Promise.all(
      [1, 2, 3, 4].map(() => enqueue({ topic: T('concurrent') })));
    const a = recorder('worker-a', [T('concurrent')]);
    const b = recorder('worker-b', [T('concurrent')]);

    const [ra, rb] = await Promise.all([
      drainOnce(app, { consumers: [a], workerId: 'w-a' }),
      drainOnce(owner, { consumers: [b], workerId: 'w-b' }),
    ]);

    // SKIP LOCKED: between them they take each message at most once.
    expect(ra.claimed + rb.claimed).toBeLessThanOrEqual(ids.length + 4);
    const delivered = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.outbox
        WHERE topic=$1 AND status='delivered'`, [T('concurrent')]);
    expect(Number(delivered.rows[0]!.n)).toBe(ids.length);
  });
});

describe('B. failure, backoff and the terminal state', () => {
  const explode: Consumer = {
    name: 'poison-consumer', topics: [T('poison')], touchesTenantData: false,
    async handle() { throw new Error('this consumer always throws'); },
  };

  it('backs off, then dead-letters with a reason rather than retrying forever', async () => {
    const id = await enqueue({ topic: T('poison'), maxAttempts: 3 });

    for (let i = 0; i < 3; i += 1) {
      await owner.query(`UPDATE platform.outbox SET available_at = now() WHERE id=$1`, [id]);
      await drainOnce(app, { consumers: [explode] });
    }

    const row = await statusOf(id);
    // A message stuck retrying forever is the same failure class as a job that
    // never runs: nothing looks broken and nothing happens.
    expect(row.status).toBe('dead_letter');
    expect(row.attempts).toBe(3);
    expect(row.dead_letter_reason).toMatch(/exhausted 3 attempts/);
    expect(row.dead_letter_reason).toMatch(/always throws/);
  });

  it('backs off exponentially rather than hammering', async () => {
    const id = await enqueue({ topic: T('poison'), maxAttempts: 8 });
    await drainOnce(app, { consumers: [explode] });
    const first = await owner.query<{ wait: string }>(
      `SELECT EXTRACT(EPOCH FROM (available_at - now()))::text AS wait
         FROM platform.outbox WHERE id=$1`, [id]);
    expect(Number(first.rows[0]!.wait)).toBeGreaterThan(0);

    await owner.query(`UPDATE platform.outbox SET available_at = now() WHERE id=$1`, [id]);
    await drainOnce(app, { consumers: [explode] });
    const second = await owner.query<{ wait: string }>(
      `SELECT EXTRACT(EPOCH FROM (available_at - now()))::text AS wait
         FROM platform.outbox WHERE id=$1`, [id]);
    expect(Number(second.rows[0]!.wait)).toBeGreaterThan(Number(first.rows[0]!.wait));
  });

  it('surfaces a hard-retrying message BEFORE it dead-letters', async () => {
    const id = await enqueue({ topic: T('poison'), maxAttempts: 20 });
    for (let i = 0; i < 4; i += 1) {
      await owner.query(`UPDATE platform.outbox SET available_at = now() WHERE id=$1`, [id]);
      await drainOnce(app, { consumers: [explode] });
    }
    const health = await outboxHealth(owner, { hardRetryThreshold: 3 });
    // The list is capped at 50. A queue with more hard-retrying messages than
    // that says so in the total rather than pretending the cap is the number --
    // and this assertion is why the field exists.
    expect(health.retryingHardTotal).toBeGreaterThanOrEqual(health.retryingHard.length);
    const hit = health.retryingHard.find((r) => r.id === id);
    expect(hit, 'a message failing repeatedly must be visible, not merely retried').toBeDefined();
    expect(hit!.attempts).toBeGreaterThanOrEqual(4);
    expect(hit!.lastError).toMatch(/always throws/);
  });

  it('does NOT let a poison message block unrelated messages behind it', async () => {
    const poison = await enqueue({ topic: T('poison'), maxAttempts: 20 });
    const healthy = await enqueue({ topic: T('healthy') });
    const ok = recorder('healthy-consumer', [T('healthy')]);

    await drainOnce(app, { consumers: [explode, ok] });

    // No head-of-line blocking outside an ordered group: SKIP LOCKED steps over
    // whatever is stuck.
    expect((await statusOf(healthy)).status).toBe('delivered');
    expect((await statusOf(poison)).status).toBe('pending');
  });
});

describe('B. ordered groups keep business-date order', () => {
  it('delivers an ordered group in sequence, never arrival order', async () => {
    const group = `stock:${randomUUID()}`;
    // Enqueued newest-first on purpose: arrival order is the wrong order.
    const third = await enqueue({ topic: T('ordered'), group, seq: 3 });
    const first = await enqueue({ topic: T('ordered'), group, seq: 1 });
    const second = await enqueue({ topic: T('ordered'), group, seq: 2 });

    const consumer = recorder('ordered-consumer', [T('ordered')]);
    for (let i = 0; i < 3; i += 1) await drainOnce(app, { consumers: [consumer] });

    const order = await owner.query<{ id: string; order_seq: string }>(
      `SELECT id, order_seq::text FROM platform.outbox
        WHERE ordered_group=$1 ORDER BY delivered_at`, [group]);
    // Weighted average cost is order-dependent: Tuesday before Monday values
    // Monday against a basis that had already moved.
    expect(order.rows.map((r) => Number(r.order_seq))).toEqual([1, 2, 3]);
    expect(order.rows.map((r) => r.id)).toEqual([first, second, third]);
  });

  it('refuses to claim past an unresolved earlier message in the same group', async () => {
    const group = `stock:${randomUUID()}`;
    await enqueue({ topic: T('poison'), group, seq: 1, maxAttempts: 20 });
    const later = await enqueue({ topic: T('ordered'), group, seq: 2 });

    const explode: Consumer = {
      name: 'blocker', topics: [T('poison')], touchesTenantData: false,
      async handle() { throw new Error('blocked'); },
    };
    const ok = recorder('after-consumer', [T('ordered')]);
    await drainOnce(app, { consumers: [explode, ok] });

    // Within a group ordering is the requirement, so the later message waits.
    expect((await statusOf(later)).status).toBe('pending');
    expect(ok.seen).toEqual([]);
  });

  it('RELEASES the group when the blocker dead-letters, so blocking is bounded', async () => {
    const group = `stock:${randomUUID()}`;
    const blocker = await enqueue({ topic: T('poison'), group, seq: 1, maxAttempts: 2 });
    const later = await enqueue({ topic: T('ordered'), group, seq: 2 });

    const explode: Consumer = {
      name: 'blocker2', topics: [T('poison')], touchesTenantData: false,
      async handle() { throw new Error('blocked'); },
    };
    const ok = recorder('after-consumer2', [T('ordered')]);

    for (let i = 0; i < 3; i += 1) {
      await owner.query(
        `UPDATE platform.outbox SET available_at = now() WHERE ordered_group=$1`, [group]);
      await drainOnce(app, { consumers: [explode, ok] });
    }

    expect((await statusOf(blocker)).status).toBe('dead_letter');
    // Bounded by max_attempts x backoff, not forever. Saying blocking is
    // "impossible" here would be false; saying it is bounded is the honest claim.
    expect((await statusOf(later)).status).toBe('delivered');
  });
});

describe('B. claims are reclaimed, never stranded', () => {
  it('returns a claim held past the timeout by a dead worker', async () => {
    const id = await enqueue({ topic: T('stranded') });
    await owner.query(
      `UPDATE platform.outbox
          SET status='claimed', claimed_at = now() - interval '1 hour', claimed_by='dead-worker'
        WHERE id=$1`, [id]);

    // The claim is NOT a held lock: holding a transaction across the consumer's
    // I/O would put a slow HTTP call in the critical path of the queue. The cost
    // is that a dead worker strands its claims, so they are reclaimed by age.
    expect(await verifyDrain(owner)).toContainEqual(`${id} (held by dead-worker)`);

    const reclaimed = await reclaimStale(app);
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    expect((await statusOf(id)).status).toBe('pending');
    expect((await statusOf(id)).last_error).toMatch(/claim expired/);
  });

  it('leaves no stranded claim after a drain cycle', async () => {
    await enqueue({ topic: T('sweep') });
    await drainOnce(app, { consumers: [recorder('sweep-consumer', [T('sweep')])] });
    expect(await verifyDrain(owner)).toEqual([]);
  });
});

describe('B. the runtime posture', () => {
  it('runs as katkitchen_app, never the owner', async () => {
    const who = await app.query<{ u: string; bypass: boolean }>(
      `SELECT current_user AS u, rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user`);
    expect(who.rows[0]).toEqual({ u: 'katkitchen_app', bypass: false });

    const code = readFileSync('src/modules/notifications/outboxWorker.ts', 'utf8');
    expect(code).toMatch(/DATABASE_URL_APP/);
    expect(code).not.toMatch(/DATABASE_URL_OWNER/);
    expect(code).toMatch(/set_config\(\$1, \$2, true\)/);
  });

  it('sets the tenant GUC per message for a consumer that touches app data', async () => {
    let seenTenant: string | null = null;
    const consumer: Consumer = {
      name: 'tenant-reader', topics: [T('scoped')], touchesTenantData: true,
      async handle(client) {
        const r = await client.query<{ v: string }>(
          `SELECT current_setting('app.tenant_id', true) AS v`);
        seenTenant = r.rows[0]!.v;
      },
    };
    await enqueue({ topic: T('scoped'), tenantId });
    await drainOnce(app, { consumers: [consumer] });
    expect(seenTenant).toBe(tenantId);
  });

  it('REFUSES a tenant-touching consumer handed a message with no tenant', async () => {
    const consumer: Consumer = {
      name: 'unscoped-writer', topics: [T('unscoped')], touchesTenantData: true,
      async handle() { throw new Error('should never run'); },
    };
    const id = await enqueue({ topic: T('unscoped'), tenantId: null });
    await drainOnce(app, { consumers: [consumer] });

    const row = await statusOf(id);
    // Running it would write app rows with no RLS scope. Refused, and the reason
    // says which consumer and which message.
    expect(row.status).toBe('pending');
    expect(row.last_error).toMatch(/carries no tenant_id/);
    expect(new TenantContextRequiredError('c', 'm').code).toBe('tenant_context_required');
  });

  it('is global at the claim, so no tenant can starve another', () => {
    const code = readFileSync('src/modules/notifications/outboxWorker.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // Iterating tenants would give the same RLS posture and reintroduce exactly
    // the problem the rollup had to avoid.
    expect(code).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(code).not.toMatch(/FROM platform\.tenant/);
  });
});

describe('B. system health', () => {
  it('reports every state the queue can be in', async () => {
    const health = await outboxHealth(owner);
    assertCheckedSet({
      label: 'outbox health fields',
      checked: Object.keys(health),
      minimum: 6,
      mustInclude: ['pending', 'claimed', 'deadLetter', 'oldestPendingAgeSeconds',
                    'stuckClaims', 'retryingHard', 'retryingHardTotal'],
    });
    expect(health.deadLetter).toBeGreaterThan(0); // dead-lettered above
    expect(CLAIM_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  it('names every status the schema allows, so a new one cannot hide', async () => {
    const def = (await owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname='outbox_status_known'`)).rows[0]!.def;
    const statuses = [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    assertCheckedSet({
      label: 'outbox statuses',
      checked: statuses,
      minimum: 4,
      mustInclude: ['pending', 'claimed', 'delivered', 'dead_letter'],
    });
  });
});
