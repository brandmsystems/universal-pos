/**
 * Gives every EXISTING tenant the adjustment vocabulary.
 *
 * ###########################################################################
 * WHY A SCRIPT AND NOT A MIGRATION.
 *
 * `provisionTenant` now seeds `app.adjustment_reason` for every new tenant, so
 * this is needed exactly once per environment: for the tenants that existed
 * before it did. Those tenants have no reasons at all, which means void, comp,
 * discount, recall and refund are refused for want of a `reasonId` -- the
 * picker opens, asks the server, and is correctly told there is nothing.
 *
 * A migration would have had to restate the thirteen reasons and their kinds in
 * SQL, and two declarations of one vocabulary is how the product ends up with a
 * default set that no longer matches the code. This runs the SAME function
 * provisioning runs, so there is one list.
 *
 * Idempotent, on `(tenant_id, key)`: safe to run repeatedly, and it will not
 * undo an owner's rename.
 *
 *   pnpm backfill:reasons
 * ###########################################################################
 */
import pg from 'pg';
import { seedAdjustmentReasons } from '../backend/src/modules/orders/adjustmentReasonSeed.js';
import { env } from '../backend/src/config/env.js';

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: env.ownerDatabaseUrl() });
  await client.connect();
  try {
    const tenants = await client.query<{ id: string; slug: string; n: string }>(
      `SELECT t.id, t.slug,
              (SELECT count(*) FROM app.adjustment_reason r WHERE r.tenant_id = t.id)::text AS n
         FROM platform.tenant t ORDER BY t.created_at`,
    );

    let touched = 0;
    for (const tenant of tenants.rows) {
      const before = Number(tenant.n);
      // One transaction per tenant: a failure on one must not deny the rest.
      await client.query('BEGIN');
      try {
        await seedAdjustmentReasons(client, tenant.id);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error(`  FAILED ${tenant.slug}: ${String(error)}`);
        process.exitCode = 1;
        continue;
      }
      const after = Number((await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM app.adjustment_reason WHERE tenant_id = $1`,
        [tenant.id])).rows[0]!.n);
      if (after !== before) touched += 1;
      console.log(`  ${tenant.slug.padEnd(24)} ${before} -> ${after}`);
    }

    console.log(`\n${tenants.rows.length} tenant(s) checked, ${touched} changed.`);
  } finally {
    await client.end();
  }
}

await main();
