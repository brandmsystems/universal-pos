import type pg from 'pg';
import { DEFAULT_ADJUSTMENT_REASONS } from './adjustmentReasons.js';

/**
 * Owner-role seeding, outside RLS, with the tenant named explicitly -- the same
 * posture as `authz/seed.ts`, and here for the same reason: it runs inside the
 * provisioning transaction, before the tenant has any session, so there is no
 * tenant context for a repository to read.
 *
 * It is a separate module from the read for exactly that reason. Keeping both
 * in one file would have meant exempting the read's SQL from the tenant-predicate
 * gate too, to buy an exemption only the write needs.
 *
 * Idempotent on `(tenant_id, key)`: re-running it after an owner has renamed a
 * reason must not undo the rename, so the conflict does nothing rather than
 * updating the name.
 */
export async function seedAdjustmentReasons(
  client: pg.ClientBase,
  tenantId: string,
): Promise<void> {
  for (const reason of DEFAULT_ADJUSTMENT_REASONS) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO app.adjustment_reason (id, tenant_id, key, name)
       VALUES (gen_random_uuid(), $1, $2, $3)
       ON CONFLICT (tenant_id, key) DO NOTHING
       RETURNING id`,
      [tenantId, reason.key, reason.name],
    );
    const row = inserted.rows[0];
    if (!row) continue;
    for (const kind of reason.kinds) {
      await client.query(
        `INSERT INTO app.adjustment_reason_kind (tenant_id, reason_id, kind)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, reason_id, kind) DO NOTHING`,
        [tenantId, row.id, kind],
      );
    }
  }
}
