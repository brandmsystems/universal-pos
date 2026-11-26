import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ladderThresholds } from '../platform/ladder.js';
import { publishEntitlement } from '../platform/entitlements.js';

/**
 * Dunning.
 *
 * ###########################################################################
 * DUNNING NEVER SUSPENDS. THE LADDER DOES.
 *
 * Nothing here writes tenant.status or tenant.delinquent_since directly, and
 * nothing here holds a threshold. Exhausting retries does not suspend a tenant; it
 * simply stops retrying. The ladder job, reading the one configurable set of
 * thresholds from delinquent_since, decides access.
 *
 * That separation is the whole protection: a gateway outage produces a burst of
 * declines, and if declines could suspend directly, the outage would lock every
 * restaurant on the platform out mid-service.
 * ###########################################################################
 */

export interface DunningConfig {
  readonly retryOffsetDays: readonly number[];
  readonly maxAttempts: number;
}

export async function dunningConfig(client: pg.ClientBase): Promise<DunningConfig> {
  const r = await client.query<{ key: string; value: string }>(
    `SELECT key, value::text AS value FROM platform.platform_setting
      WHERE key IN ('dunning.retry_offset_days', 'dunning.max_attempts')`,
  );
  const byKey = new Map(r.rows.map((x) => [x.key, x.value]));
  const offsets = JSON.parse(byKey.get('dunning.retry_offset_days') ?? 'null');
  const max = Number(JSON.parse(byKey.get('dunning.max_attempts') ?? 'null'));
  if (!Array.isArray(offsets) || !Number.isFinite(max)) {
    throw new Error('dunning settings are missing or malformed');
  }
  return { retryOffsetDays: offsets as number[], maxAttempts: max };
}

/**
 * Backoff, because a first failure is usually a bank decline rather than a
 * delinquent customer. Retrying an expired card four times in an hour annoys a
 * paying customer and teaches the gateway to rate-limit us.
 */
export function nextAttemptAt(
  attemptNo: number, from: Date, config: DunningConfig,
): Date | null {
  if (attemptNo >= config.maxAttempts) return null;
  const offset = config.retryOffsetDays[attemptNo - 1]
    ?? config.retryOffsetDays[config.retryOffsetDays.length - 1]
    ?? 1;
  const next = new Date(from);
  next.setUTCDate(next.getUTCDate() + offset);
  return next;
}

export async function scheduleFirstAttempt(
  client: pg.ClientBase,
  params: { tenantId: string; invoiceId: string; at: Date },
): Promise<{ attemptId: string }> {
  const attemptId = randomUUID();
  await client.query(
    `INSERT INTO platform.dunning_attempt
       (id, tenant_id, invoice_id, attempt_no, scheduled_at)
     VALUES ($1,$2,$3,1,$4)
     ON CONFLICT (invoice_id, attempt_no) DO NOTHING`,
    [attemptId, params.tenantId, params.invoiceId, params.at],
  );
  return { attemptId };
}

export type AttemptOutcome = 'succeeded' | 'declined' | 'error' | 'abandoned';

/**
 * Records the result and schedules the next attempt. Marks the tenant delinquent
 * on the FIRST failure -- which starts the ladder clock without suspending
 * anything, because day 0 is `past_due` and `past_due` is banner-only.
 *
 * delinquent_since is set once and never touched by intermediate transitions,
 * per the Phase 0 biconditional. Setting it here rather than in the ladder job is
 * correct: the ladder derives status FROM day 0, so something has to establish
 * day 0, and the failed payment is the event that does.
 */
export async function recordAttempt(
  client: pg.ClientBase,
  params: {
    tenantId: string; invoiceId: string; attemptNo: number;
    outcome: AttemptOutcome; gatewayErrorCode?: string | null;
    gatewayPaymentId?: string | null; at: Date;
  },
): Promise<{ nextAttemptAt: Date | null }> {
  await client.query(
    `UPDATE platform.dunning_attempt
        SET attempted_at = $4, outcome = $5, gateway_error_code = $6, gateway_payment_id = $7
      WHERE invoice_id = $1 AND attempt_no = $2 AND tenant_id = $3`,
    [params.invoiceId, params.attemptNo, params.tenantId, params.at,
     params.outcome, params.gatewayErrorCode ?? null, params.gatewayPaymentId ?? null],
  );

  if (params.outcome === 'succeeded') {
    // ####################################################################
    // RECOVERY IS IMMEDIATE AND COMPLETE, OR IT IS NOT RECOVERY.
    //
    // A tenant who has just paid and is still read-only will phone within the
    // minute. All four steps happen here, in ONE transaction:
    //   1. status recomputes to active and day 0 clears
    //   2. the entitlement document republishes with a new version
    //   3. the invalidation goes to the outbox for the tenant plane's cache
    // Step 3 is a message rather than a call because the control plane never
    // reaches into the tenant plane synchronously.
    //
    // delinquent_since clears ONLY here, on return to active, per the Phase 0
    // biconditional -- `(status = 'active') = (delinquent_since IS NULL)`. The
    // ladder job recomputing afterwards must find nothing left to do.
    //
    // Keyed on day 0, not on `status <> 'active'`: a DEACTIVATED tenant has
    // no day 0 either, and a payment arriving must not switch back on a
    // restaurant a Super Admin switched off. Likewise the failure arm below
    // only starts a ladder from `active` -- deactivation is not a rung.
    // ####################################################################
    await client.query(
      `UPDATE platform.tenant
          SET status = 'active', delinquent_since = NULL, status_changed_at = now()
        WHERE id = $1 AND delinquent_since IS NOT NULL`,
      [params.tenantId],
    );
    const document = await publishEntitlement(
      client, params.tenantId, 'payment recovered; delinquency cleared');
    await client.query(
      `INSERT INTO platform.outbox (id, topic, dedupe_key, payload)
       VALUES ($1, 'entitlement.invalidate', $2, $3::jsonb)
       ON CONFLICT (topic, dedupe_key) DO NOTHING`,
      [randomUUID(), `${params.tenantId}:${document.version}`,
       JSON.stringify({ tenantId: params.tenantId, version: document.version })],
    );
    return { nextAttemptAt: null };
  }

  await client.query(
    `UPDATE platform.tenant
        SET status = 'past_due', delinquent_since = $2, status_changed_at = now()
      WHERE id = $1 AND delinquent_since IS NULL AND status = 'active'`,
    [params.tenantId, params.at],
  );

  const config = await dunningConfig(client);
  const next = nextAttemptAt(params.attemptNo, params.at, config);
  if (next) {
    await client.query(
      `INSERT INTO platform.dunning_attempt
         (id, tenant_id, invoice_id, attempt_no, scheduled_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (invoice_id, attempt_no) DO NOTHING`,
      [randomUUID(), params.tenantId, params.invoiceId, params.attemptNo + 1, next],
    );
  }

  return { nextAttemptAt: next };
}

export interface DunningQueueRow {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly totalMinor: number;
  readonly dueDate: string;
  readonly attemptsMade: number;
  readonly nextAttemptAt: string | null;
  readonly delinquentSince: string | null;
  /** Negative once the threshold has passed. The number an operator acts on. */
  readonly daysUntilSoftLock: number | null;
  readonly lastOutreachAt: string | null;
}

/**
 * The queue screen from the Phase 1 spec.
 *
 * `daysUntilSoftLock` is computed from the SAME configurable thresholds the
 * ladder uses -- read here, never redefined. A second copy of the numbers would
 * drift and the screen would confidently show a date the ladder disagrees with.
 */
export async function dunningQueue(
  client: pg.ClientBase,
  params: { now: Date; provisionedByPlatformUserId?: string | undefined },
): Promise<readonly DunningQueueRow[]> {
  const thresholds = await ladderThresholds(client);

  const r = await client.query<{
    tenant_id: string; tenant_name: string; invoice_id: string; number: string;
    total_minor: string; due_date: string; attempts_made: string;
    next_attempt_at: string | null; delinquent_since: string | null;
    last_outreach_at: string | null;
  }>(
    `SELECT t.id AS tenant_id, t.name AS tenant_name, i.id AS invoice_id, i.number,
            i.total_minor::text, i.due_date::text,
            (SELECT count(*) FROM platform.dunning_attempt a
              WHERE a.invoice_id = i.id AND a.attempted_at IS NOT NULL)::text AS attempts_made,
            (SELECT min(a.scheduled_at)::text FROM platform.dunning_attempt a
              WHERE a.invoice_id = i.id AND a.attempted_at IS NULL) AS next_attempt_at,
            t.delinquent_since::text,
            (SELECT max(o.created_at)::text FROM platform.dunning_outreach o
              WHERE o.tenant_id = t.id) AS last_outreach_at
       FROM platform.invoice i
       JOIN platform.tenant t ON t.id = i.tenant_id
      WHERE i.status = 'issued' AND i.due_date < $1::date
        AND ($2::uuid IS NULL OR EXISTS (
              SELECT 1 FROM platform.provisioning_request pr
               WHERE pr.tenant_id = t.id AND pr.requested_by_platform_user_id = $2::uuid))
      ORDER BY t.delinquent_since NULLS LAST, i.due_date`,
    [params.now.toISOString().slice(0, 10), params.provisionedByPlatformUserId ?? null],
  );

  return r.rows.map((row) => {
    let daysUntilSoftLock: number | null = null;
    if (row.delinquent_since) {
      const elapsed =
        (params.now.getTime() - new Date(row.delinquent_since).getTime()) / 86_400_000;
      daysUntilSoftLock = Math.ceil(thresholds.softLockDays - elapsed);
    }
    return {
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      invoiceId: row.invoice_id,
      invoiceNumber: row.number,
      totalMinor: Number(row.total_minor),
      dueDate: row.due_date,
      attemptsMade: Number(row.attempts_made),
      nextAttemptAt: row.next_attempt_at,
      delinquentSince: row.delinquent_since,
      daysUntilSoftLock,
      lastOutreachAt: row.last_outreach_at,
    };
  });
}

/**
 * One-click contact-owner. It LOGS, because an outreach nobody recorded is one
 * the next person repeats, and a tenant chased four times in a day leaves.
 */
export async function recordOutreach(
  client: pg.ClientBase,
  params: {
    tenantId: string; invoiceId?: string | null;
    channel: 'email' | 'phone' | 'in_app';
    byPlatformUserId: string; note?: string | null;
  },
): Promise<{ outreachId: string }> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO platform.dunning_outreach
       (id, tenant_id, invoice_id, channel, contacted_by_platform_user_id, note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, params.tenantId, params.invoiceId ?? null, params.channel,
     params.byPlatformUserId, params.note ?? null],
  );
  // The email itself goes through the outbox, never inline.
  await client.query(
    `INSERT INTO platform.outbox (id, topic, dedupe_key, payload)
     VALUES ($1, 'billing.dunning_outreach', $2, $3::jsonb)`,
    [randomUUID(), id,
     JSON.stringify({ outreachId: id, tenantId: params.tenantId, channel: params.channel })],
  );
  return { outreachId: id };
}
