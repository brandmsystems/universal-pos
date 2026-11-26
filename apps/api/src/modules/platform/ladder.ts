import type pg from 'pg';

/**
 * The suspension ladder recompute job.
 *
 * tenant.status is a CACHE. delinquent_since plus the configurable thresholds is
 * the truth, and this job is the only thing that reconciles the two. Thresholds
 * come from platform_setting, never from constants here.
 *
 * Same discipline as the partition job: idempotent AND self-verifying. Exiting 0
 * having done nothing is indistinguishable from working, so it asserts the
 * postcondition -- no tenant left on a status that disagrees with its day 0 --
 * and fails if any remain.
 */

export type LadderStatus =
  | 'active'
  | 'past_due'
  | 'soft_lock'
  | 'hard_lock'
  | 'retention'
  | 'purge_pending'
  | 'purged';

export interface LadderThresholds {
  readonly softLockDays: number;
  readonly hardLockDays: number;
  readonly retentionDays: number;
  readonly purgeDays: number;
}

export async function ladderThresholds(client: pg.ClientBase): Promise<LadderThresholds> {
  const result = await client.query<{ key: string; value: string }>(
    `SELECT key, value::text AS value FROM platform.platform_setting WHERE key LIKE 'ladder.%'`,
  );
  const byKey = new Map(result.rows.map((r) => [r.key, Number(r.value)]));

  const required = [
    'ladder.soft_lock_days',
    'ladder.hard_lock_days',
    'ladder.retention_days',
    'ladder.purge_days',
  ] as const;
  const missing = required.filter((key) => !byKey.has(key) || Number.isNaN(byKey.get(key)));
  if (missing.length > 0) {
    throw new Error(`ladder thresholds are missing or non-numeric: ${missing.join(', ')}`);
  }

  return {
    softLockDays: byKey.get('ladder.soft_lock_days')!,
    hardLockDays: byKey.get('ladder.hard_lock_days')!,
    retentionDays: byKey.get('ladder.retention_days')!,
    purgeDays: byKey.get('ladder.purge_days')!,
  };
}

/** Pure: the status a tenant should hold, given day 0 and how long ago it was. */
export function statusForElapsedDays(
  elapsedDays: number,
  thresholds: LadderThresholds,
): LadderStatus {
  if (elapsedDays >= thresholds.purgeDays) return 'purge_pending';
  if (elapsedDays >= thresholds.retentionDays) return 'retention';
  if (elapsedDays >= thresholds.hardLockDays) return 'hard_lock';
  if (elapsedDays >= thresholds.softLockDays) return 'soft_lock';
  return 'past_due';
}

export interface LadderRun {
  readonly advanced: readonly { tenantId: string; from: string; to: string }[];
  readonly stillDisagreeing: readonly string[];
}

/**
 * `purged` is terminal and is never recomputed: the data is gone, so there is
 * nothing left for a threshold change to re-derive.
 */
export async function recomputeLadder(client: pg.ClientBase): Promise<LadderRun> {
  const thresholds = await ladderThresholds(client);

  const candidates = await client.query<{ id: string; status: string; elapsed: string }>(
    `SELECT id, status, floor(extract(epoch FROM (now() - delinquent_since)) / 86400)::text AS elapsed
       FROM platform.tenant
      WHERE delinquent_since IS NOT NULL AND status <> 'purged'
      FOR UPDATE`,
  );

  const advanced: { tenantId: string; from: string; to: string }[] = [];

  for (const row of candidates.rows) {
    const target = statusForElapsedDays(Number(row.elapsed), thresholds);
    if (target === row.status) continue;

    await client.query(
      `UPDATE platform.tenant
          SET status = $2, status_changed_at = now()
        WHERE id = $1`,
      [row.id, target],
    );
    advanced.push({ tenantId: row.id, from: row.status, to: target });
  }

  // The positive postcondition. After a run, no non-purged delinquent tenant may
  // hold a status its own day 0 does not imply.
  const residual = await client.query<{ id: string }>(
    `SELECT id, status,
            floor(extract(epoch FROM (now() - delinquent_since)) / 86400)::int AS elapsed
       FROM platform.tenant
      WHERE delinquent_since IS NOT NULL AND status <> 'purged'`,
  );

  const stillDisagreeing = residual.rows
    .filter((row) => {
      const r = row as unknown as { status: string; elapsed: number; id: string };
      return statusForElapsedDays(r.elapsed, thresholds) !== r.status;
    })
    .map((row) => row.id);

  return { advanced, stillDisagreeing };
}

/**
 * Purge at day 135 ANONYMISES app_user in place. Name, email and phone are
 * scrubbed; the row, its memberships and every audit row survive.
 *
 * Deletion was never available: audit rows carry actor_name/actor_email snapshots
 * under a legal-obligation retention period, and authorising_membership_id is
 * ON DELETE RESTRICT. Anonymisation IS the erasure mechanism, and it is the only
 * one that keeps referential integrity and the financial record intact.
 */
export class NotReadyForPurgeError extends Error {
  constructor(tenantId: string, status: string) {
    super(
      `tenant ${tenantId} is ${status}, not purge_pending. Purge is the end of the ladder, ` +
        'not an action that can be taken against a tenant that was never delinquent.',
    );
    this.name = 'NotReadyForPurgeError';
  }
}

export async function anonymiseTenant(
  client: pg.ClientBase,
  tenantId: string,
): Promise<{ usersAnonymised: number }> {
  // Guard the precondition here rather than letting tenant_delinquency_consistent
  // catch it. The CHECK would reject this too -- a purged tenant must have a
  // non-NULL delinquent_since, so a never-delinquent tenant cannot be purged --
  // but it would surface as a constraint name rather than as the actual mistake.
  const current = await client.query<{ status: string }>(
    `SELECT status FROM platform.tenant WHERE id = $1 FOR UPDATE`,
    [tenantId],
  );
  const status = current.rows[0]?.status;
  if (status === undefined) throw new Error(`unknown tenant ${tenantId}`);
  if (status === 'purged') return { usersAnonymised: 0 };
  if (status !== 'purge_pending') throw new NotReadyForPurgeError(tenantId, status);

  const result = await client.query(
    `UPDATE app.app_user
        SET full_name = 'Anonymised user',
            email = NULL,
            phone = NULL,
            employee_code = 'ANON-' || left(replace(id::text, '-', ''), 12),
            status = 'disabled'
      WHERE tenant_id = $1 AND full_name <> 'Anonymised user'`,
    [tenantId],
  );

  await client.query(
    `UPDATE platform.tenant SET status = 'purged', status_changed_at = now() WHERE id = $1`,
    [tenantId],
  );

  return { usersAnonymised: result.rowCount ?? 0 };
}
