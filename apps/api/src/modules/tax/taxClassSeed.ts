import type pg from 'pg';
import { defaultTaxClassesFor } from './taxClasses.js';

/**
 * Owner-role seeding with the tenant named explicitly, exactly as
 * `adjustmentReasonSeed.ts` is and for the same reason: it runs inside the
 * provisioning transaction, before the tenant has any session, so there is no
 * tenant context for a repository to read.
 *
 * Idempotent on `(tenant_id, key)`, and the conflict does NOTHING rather than
 * updating -- an owner who has renamed "GST 5% (restaurant)" or corrected its
 * rate must not have that undone by a re-run. Same rule the reason seed
 * follows, and the reason `pnpm backfill:tax-classes` is safe to run twice.
 */
export async function seedTaxClasses(
  client: pg.ClientBase,
  tenantId: string,
  jurisdictionCode = 'IN',
): Promise<readonly string[]> {
  const created: string[] = [];
  for (const cls of defaultTaxClassesFor(jurisdictionCode)) {
    const inserted = await client.query<{ key: string }>(
      `INSERT INTO app.tax_class (id, tenant_id, key, name, rate_bps)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)
       ON CONFLICT (tenant_id, key) DO NOTHING
       RETURNING key`,
      [tenantId, cls.key, cls.name, cls.rateBps],
    );
    const row = inserted.rows[0];
    if (row) created.push(row.key);
  }
  return created;
}
