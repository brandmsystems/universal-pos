import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

/**
 * The outbox drain worker.
 *
 * ###########################################################################
 * THE DRAIN IS GLOBAL AT THE CLAIM AND PER-TENANT AT THE DISPATCH.
 *
 * Iterating tenants would give the right RLS posture and reintroduce exactly the
 * problem the rollup had to avoid: one tenant with a stuck consumer delaying
 * every tenant behind it in the loop.
 *
 * So claiming is a single `FOR UPDATE SKIP LOCKED` across the whole table --
 * workers step over anything locked or blocked, and a tenant's position in no
 * list can starve another. The tenant GUC is then set PER MESSAGE, for the
 * duration of that one message's transaction, from `outbox.tenant_id`. A
 * consumer that touches app tables and is handed a message with no tenant is
 * refused rather than run without RLS.
 *
 * Same posture as the rollup: this runs as katkitchen_app, never the owner. An
 * owner-run consumer writing app rows would do so exempt from RLS, and a
 * consumer with a wrong predicate would write into the wrong tenant instead of
 * writing nothing.
 * ###########################################################################
 */

/** How long a claim may be held before another worker may take it back. */
export const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

export interface OutboxDelivery {
  readonly id: string;
  readonly topic: string;
  readonly dedupeKey: string;
  readonly payload: Record<string, unknown>;
  readonly tenantId: string | null;
  readonly attempts: number;
}

export interface Consumer {
  readonly name: string;
  readonly topics: readonly string[];
  /** Must touch app tables only when the message carries a tenant. */
  readonly touchesTenantData: boolean;
  handle(client: pg.ClientBase, message: OutboxDelivery): Promise<void>;
}

export class TenantContextRequiredError extends Error {
  readonly code = 'tenant_context_required';
  constructor(readonly consumer: string, readonly messageId: string) {
    super(
      `consumer '${consumer}' touches tenant data but message ${messageId} carries no ` +
        'tenant_id. Running it would write app rows with no RLS scope.',
    );
    this.name = 'TenantContextRequiredError';
  }
}

/**
 * Claims a batch.
 *
 * ORDERING: a message in an ordered group is claimable only when no EARLIER
 * message in its group is still unresolved. That is what makes business-date
 * order hold for stock deducts without serialising the whole queue -- everything
 * outside a group, and every other group, drains in parallel around it.
 */
async function claimBatch(
  client: pg.ClientBase,
  params: { workerId: string; batchSize: number; topics?: readonly string[] },
): Promise<readonly OutboxDelivery[]> {
  const result = await client.query<{
    id: string; topic: string; dedupe_key: string; payload: Record<string, unknown>;
    tenant_id: string | null; attempts: number;
  }>(
    `WITH claimable AS (
       SELECT o.id
         FROM platform.outbox o
        WHERE o.status = 'pending' AND o.available_at <= now()
          AND ($3::text[] IS NULL OR o.topic = ANY($3::text[]))
          AND (
            o.ordered_group IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM platform.outbox earlier
               WHERE earlier.ordered_group = o.ordered_group
                 AND earlier.order_seq < o.order_seq
                 AND earlier.status IN ('pending', 'claimed'))
          )
        ORDER BY o.available_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE platform.outbox o
        SET status = 'claimed', claimed_at = now(), claimed_by = $1
       FROM claimable c
      WHERE o.id = c.id
      RETURNING o.id, o.topic, o.dedupe_key, o.payload, o.tenant_id, o.attempts`,
    [params.workerId, params.batchSize, params.topics ?? null],
  );

  return result.rows.map((r) => ({
    id: r.id, topic: r.topic, dedupeKey: r.dedupe_key, payload: r.payload,
    tenantId: r.tenant_id, attempts: r.attempts,
  }));
}

/**
 * Returns claims to the queue.
 *
 * The claim is NOT a held database lock. Holding a transaction open across the
 * consumer's I/O would put a slow HTTP call in the critical path of the queue --
 * the same reason the print attempt is not inside the fire transaction. The cost
 * of releasing the lock is that a worker which dies mid-batch strands its
 * messages in `claimed`, so they are reclaimed by age instead.
 */
export async function reclaimStale(
  client: pg.ClientBase,
  params: { timeoutMs?: number } = {},
): Promise<number> {
  const result = await client.query(
    `UPDATE platform.outbox
        SET status = 'pending', claimed_at = NULL, claimed_by = NULL,
            last_error = COALESCE(last_error, 'claim expired; worker presumed dead')
      WHERE status = 'claimed'
        AND claimed_at < now() - ($1 || ' milliseconds')::interval`,
    [String(params.timeoutMs ?? CLAIM_TIMEOUT_MS)],
  );
  return result.rowCount ?? 0;
}

export interface DrainResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
  readonly deadLettered: number;
  readonly reclaimed: number;
}

/**
 * One drain cycle.
 *
 * Each message gets its OWN transaction: the ledger write, the consumer's work
 * and the delivered stamp commit together, so a consumer that writes rows and
 * then fails cannot leave the message looking delivered. At-least-once delivery
 * plus the per-consumer ledger is what makes the EFFECT exactly-once.
 */
export async function drainOnce(
  client: pg.ClientBase,
  params: {
    consumers: readonly Consumer[];
    workerId?: string;
    batchSize?: number;
    claimTimeoutMs?: number;
    /** Restricts the claim to these topics. A dedicated worker per topic class
     *  keeps a large backlog of one topic from crowding out every other. */
    topics?: readonly string[];
  },
): Promise<DrainResult> {
  const workerId = params.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const reclaimed = await reclaimStale(
    client,
    params.claimTimeoutMs === undefined ? {} : { timeoutMs: params.claimTimeoutMs },
  );

  const byTopic = new Map<string, Consumer[]>();
  for (const consumer of params.consumers) {
    for (const topic of consumer.topics) {
      byTopic.set(topic, [...(byTopic.get(topic) ?? []), consumer]);
    }
  }

  const batch = await claimBatch(client, {
    workerId,
    batchSize: params.batchSize ?? 50,
    // Default to exactly the topics the registered consumers handle: claiming a
    // message nobody can handle would mark it delivered having done nothing.
    topics: params.topics ?? [...new Set(params.consumers.flatMap((c) => c.topics))],
  });
  let delivered = 0, failed = 0, deadLettered = 0;

  for (const message of batch) {
    const consumers = byTopic.get(message.topic) ?? [];

    await client.query('BEGIN');
    try {
      for (const consumer of consumers) {
        if (consumer.touchesTenantData) {
          if (!message.tenantId) throw new TenantContextRequiredError(consumer.name, message.id);
          await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', message.tenantId]);
        }

        // The ledger claims the work BEFORE it is done. A duplicate delivery
        // collides here and is skipped, which is where at-least-once becomes
        // exactly-once in effect rather than in hope.
        const claimed = await client.query(
          `INSERT INTO platform.outbox_consumption (consumer, topic, dedupe_key)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [consumer.name, message.topic, message.dedupeKey],
        );
        if (claimed.rowCount === 0) continue; // already consumed by this consumer

        await consumer.handle(client, message);
      }

      await client.query(
        `UPDATE platform.outbox
            SET status = 'delivered', delivered_at = now(), claimed_at = NULL, claimed_by = NULL
          WHERE id = $1`,
        [message.id],
      );
      await client.query('COMMIT');
      delivered += 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const detail = error instanceof Error ? error.message : String(error);
      const outcome = await recordFailure(client, message.id, detail);
      if (outcome === 'dead_letter') deadLettered += 1;
      else failed += 1;
    }
  }

  return { claimed: batch.length, delivered, failed, deadLettered, reclaimed };
}

/**
 * Backoff, then a terminal state.
 *
 * ###########################################################################
 * A MESSAGE STUCK RETRYING FOREVER IS THE SAME FAILURE CLASS AS A JOB THAT
 * NEVER RUNS: nothing is obviously broken and nothing is happening.
 *
 * So retries are bounded. On exhaustion the message becomes `dead_letter` with a
 * reason, which is visible in System health -- and, critically, RELEASES its
 * ordered group. A poisoned stock deduct therefore delays its branch's later
 * deducts by at most max_attempts x backoff, not forever.
 * ###########################################################################
 */
async function recordFailure(
  client: pg.ClientBase,
  id: string,
  detail: string,
): Promise<'retry' | 'dead_letter'> {
  const result = await client.query<{ status: string }>(
    `UPDATE platform.outbox
        SET attempts = attempts + 1,
            last_error = $2,
            claimed_at = NULL,
            claimed_by = NULL,
            status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead_letter' ELSE 'pending' END,
            dead_lettered_at =
              CASE WHEN attempts + 1 >= max_attempts THEN now() ELSE NULL END,
            dead_letter_reason =
              CASE WHEN attempts + 1 >= max_attempts
                   THEN 'exhausted ' || max_attempts || ' attempts; last error: ' || $2
                   ELSE NULL END,
            -- Exponential, capped. A first failure is usually transient; the
            -- twentieth is not, and hammering it helps nobody.
            available_at = now() + least(interval '1 hour',
                                         (interval '2 seconds' * power(2, attempts)))
      WHERE id = $1
      RETURNING status`,
    [id, detail.slice(0, 2000)],
  );
  return result.rows[0]?.status === 'dead_letter' ? 'dead_letter' : 'retry';
}

export interface OutboxHealth {
  readonly pending: number;
  readonly claimed: number;
  readonly deadLetter: number;
  readonly oldestPendingAgeSeconds: number | null;
  readonly stuckClaims: number;
  /** Retrying repeatedly without succeeding: visible before it dead-letters. */
  readonly retryingHard: readonly { id: string; topic: string; attempts: number; lastError: string | null }[];
  /**
   * How many messages are retrying hard IN TOTAL, which is not the length of
   * the list above.
   *
   * `retryingHard` is capped at 50 rows so a health read cannot return a
   * megabyte. Without this count that cap is INVISIBLE: a queue with 400
   * failing messages and one with 50 look identical, and the widget says
   * "50 retrying" forever while the real number grows. A test found exactly
   * that -- it looked for its own message in the list, the dev install had 52
   * hard-retrying rows, and the one it had just created was cut off.
   */
  readonly retryingHardTotal: number;
}

/** What the System health widget reads. */
export async function outboxHealth(
  client: pg.ClientBase,
  params: { claimTimeoutMs?: number; hardRetryThreshold?: number } = {},
): Promise<OutboxHealth> {
  const counts = await client.query<{
    pending: string; claimed: string; dead_letter: string;
    oldest_pending: string | null; stuck: string;
  }>(
    `SELECT count(*) FILTER (WHERE status = 'pending')::text      AS pending,
            count(*) FILTER (WHERE status = 'claimed')::text      AS claimed,
            count(*) FILTER (WHERE status = 'dead_letter')::text  AS dead_letter,
            EXTRACT(EPOCH FROM (
              now() - min(available_at) FILTER (WHERE status = 'pending')))::text
                                                                 AS oldest_pending,
            count(*) FILTER (
              WHERE status = 'claimed'
                AND claimed_at < now() - ($1 || ' milliseconds')::interval)::text AS stuck
       FROM platform.outbox`,
    [String(params.claimTimeoutMs ?? CLAIM_TIMEOUT_MS)],
  );

  const hard = await client.query<{
    id: string; topic: string; attempts: number; last_error: string | null;
    total: string;
  }>(
    // `attempts DESC, id` and not `attempts DESC` alone: ties were unordered, so
    // which 50 of 52 equally-failing messages came back changed between reads.
    // The total comes back on every row via a window function rather than a
    // second query, so the count and the sample cannot describe two different
    // instants.
    `SELECT id, topic, attempts, last_error, count(*) OVER ()::text AS total
       FROM platform.outbox
      WHERE status = 'pending' AND attempts >= $1
      ORDER BY attempts DESC, id
      LIMIT 50`,
    [params.hardRetryThreshold ?? 3],
  );

  const row = counts.rows[0]!;
  return {
    pending: Number(row.pending),
    claimed: Number(row.claimed),
    deadLetter: Number(row.dead_letter),
    oldestPendingAgeSeconds: row.oldest_pending === null ? null : Math.round(Number(row.oldest_pending)),
    stuckClaims: Number(row.stuck),
    retryingHard: hard.rows.map((r) => ({
      id: r.id, topic: r.topic, attempts: r.attempts, lastError: r.last_error,
    })),
    // The window count is on every returned row; zero rows means zero total.
    retryingHardTotal: Number(hard.rows[0]?.total ?? 0),
  };
}

/**
 * The postcondition, asserted against the database.
 *
 * After a cycle no claim may be older than the timeout: either the worker
 * resolved it, or the reclaim sweep at the head of the next cycle returned it.
 * A non-empty result means messages are stranded in `claimed` and nothing is
 * retrying them.
 */
export async function verifyDrain(
  client: pg.ClientBase,
  params: { claimTimeoutMs?: number } = {},
): Promise<readonly string[]> {
  const result = await client.query<{ id: string; claimed_by: string }>(
    `SELECT id, claimed_by FROM platform.outbox
      WHERE status = 'claimed'
        AND claimed_at < now() - ($1 || ' milliseconds')::interval
      ORDER BY claimed_at`,
    [String(params.claimTimeoutMs ?? CLAIM_TIMEOUT_MS)],
  );
  return result.rows.map((r) => `${r.id} (held by ${r.claimed_by})`);
}

export async function main(): Promise<void> {
  // The APP role, deliberately. A consumer writing app rows as the owner would
  // do so exempt from RLS.
  const url = process.env['DATABASE_URL_APP'];
  if (!url) throw new Error('DATABASE_URL_APP is required: the drain runs as katkitchen_app');

  const { CONSUMERS } = await import('./outboxConsumers.js');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await drainOnce(client, { consumers: CONSUMERS });
    console.log(
      `outbox drain: claimed ${result.claimed}, delivered ${result.delivered}, ` +
        `failed ${result.failed}, dead-lettered ${result.deadLettered}, ` +
        `reclaimed ${result.reclaimed}`,
    );

    const stranded = await verifyDrain(client);
    if (stranded.length > 0) {
      console.error(
        `${stranded.length} message(s) stranded in 'claimed' beyond the timeout: ` +
          `${stranded.slice(0, 5).join(', ')}`,
      );
      process.exitCode = 1;
      return;
    }

    const health = await outboxHealth(client);
    if (health.deadLetter > 0) {
      console.error(`${health.deadLetter} message(s) in dead_letter and needing a human`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
