/**
 * Gives every EXISTING tenant the tax vocabulary.
 *
 * ###########################################################################
 * WHY THIS IS NOT OPTIONAL.
 *
 * `app.menu_item.tax_class_id` is NOT NULL with a foreign key to
 * `app.tax_class`. `provisionTenant` seeds three classes now; before migration
 * 0050 it seeded none and no route created one. So every tenant provisioned
 * before this ships has ZERO tax classes, and for them `POST /admin/menu/items`
 * cannot succeed -- there is no id to send, and the tax-rates screen would show
 * an empty list.
 *
 * That is the same gap `pnpm reconcile:roles` closes for permissions and
 * `pnpm backfill:reasons` closes for the adjustment vocabulary, and it is the
 * same reason all three are scripts rather than migrations: a migration would
 * restate the list in SQL, and two declarations of one vocabulary drift.
 *
 * Idempotent on `(tenant_id, key)`. The conflict does nothing, so an owner who
 * has renamed a class or corrected its rate keeps the change.
 *
 * Run it after any change to DEFAULT_TAX_CLASSES.
 *
 *   pnpm backfill:tax-classes
 * ###########################################################################
 */
import pg from 'pg';
import { seedTaxClasses } from '../apps/api/src/modules/tax/taxClassSeed.js';
import { env } from '../apps/api/src/config/env.js';

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: env.ownerDatabaseUrl() });
  await client.connect();
  try {
    const tenants = await client.query<{ id: string; slug: string; n: string; items: string }>(
      `SELECT t.id, t.slug,
              (SELECT count(*) FROM app.tax_class c WHERE c.tenant_id = t.id)::text AS n,
              (SELECT count(*) FROM app.menu_item m WHERE m.tenant_id = t.id)::text AS items
         FROM platform.tenant t ORDER BY t.created_at`,
    );

    let touched = 0;
    // Reported separately because it is the population this script exists for:
    // a tenant with no classes AND no dishes is a restaurant that was never
    // able to build a menu, not one that chose not to.
    let unbuildable = 0;
    for (const tenant of tenants.rows) {
      const before = Number(tenant.n);
      if (before === 0 && Number(tenant.items) === 0) unbuildable += 1;

      // One transaction per tenant: a failure on one must not deny the rest.
      await client.query('BEGIN');
      try {
        const created = await seedTaxClasses(client, tenant.id);
        await client.query('COMMIT');
        if (created.length > 0) touched += 1;
        console.log(
          `  ${tenant.slug.padEnd(24)} ${before} -> ${before + created.length}`
          + (created.length > 0 ? `  (${created.join(', ')})` : ''),
        );
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error(`  FAILED ${tenant.slug}: ${String(error)}`);
        process.exitCode = 1;
      }
    }

    console.log(`\n${tenants.rows.length} tenant(s) checked, ${touched} changed.`);
    if (unbuildable > 0) {
      console.log(
        `${unbuildable} of them had no tax class AND no menu item: until now those `
        + 'restaurants could not have added a dish if they had tried.',
      );
    }
  } finally {
    await client.end();
  }
}

await main();
