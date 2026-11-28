import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { env } from '../config/env.js';
import {
  catalogueDrift, reconcileAllTenantSystemRoles, seedPermissionCatalogue, seedPlatformAuthz,
} from '../modules/authz/seed.js';
import { STANDARD_PLANS, ensureStandardPlans } from '../modules/platform/planCatalogue.js';

/**
 * Global seed. Runs as katkitchen_owner on every deploy, before the application
 * starts: the catalogues, the plans, and every existing tenant's SYSTEM roles
 * re-applied from the constant (custom roles untouched). Without that last step a
 * new permission key reached only tenants provisioned after the deploy that
 * added it -- the gap `pnpm reconcile:roles` was written to close by hand.
 */
async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: env.ownerDatabaseUrl() });
  await client.connect();

  try {
    await client.query('BEGIN');
    const result = await seedPermissionCatalogue(client);
    const platform = await seedPlatformAuthz(client);
    // The plans that are sold. Created once, never re-priced here: after the
    // first version the price is data a Super Admin publishes.
    const plans = await ensureStandardPlans(client, null);
    await client.query('COMMIT');

    console.log(
      `platform catalogue: ${platform.permissionsInserted} inserted; ` +
        `roles ${platform.rolesSeeded.join(', ')}; ` +
        `grants +${platform.grantsAdded}/-${platform.grantsRemoved}`,
    );

    console.log(
      `permission catalogue: ${result.inserted.length} inserted, ${result.updated.length} updated`,
    );
    if (result.inserted.length > 0) {
      console.log(`  new keys (deny by default until granted): ${result.inserted.join(', ')}`);
    }
    if (result.orphaned.length > 0) {
      // Not an error and never auto-deleted: role_permission references these
      // ON DELETE RESTRICT, and a key vanishing from the constant is more likely
      // a bad merge than an intent to revoke it from everyone holding it.
      console.warn(`  orphaned keys still in the table: ${result.orphaned.join(', ')}`);
    }

    const missingPlans = STANDARD_PLANS.map((plan) => plan.key).filter((key) => !plans.has(key));
    console.log(`plans: ${[...plans.keys()].join(', ')}`);
    if (missingPlans.length > 0) {
      console.error(`plans missing a published version: ${missingPlans.join(', ')}`);
      process.exitCode = 1;
    }

    const drift = await catalogueDrift(client);
    if (drift.length > 0 && result.orphaned.length === 0) {
      console.error(`catalogue did not converge:\n  ${drift.join('\n  ')}`);
      process.exitCode = 1;
    }

    const reconciled = await reconcileAllTenantSystemRoles(client);
    const moved = reconciled.filter((t) => t.result !== null && t.result.grantsAdded + t.result.grantsRemoved > 0);
    console.log(`system roles: ${reconciled.length} tenant(s) checked, ${moved.length} changed`);
    for (const t of moved) console.log(`  ${t.slug} +${t.result!.grantsAdded} -${t.result!.grantsRemoved}`);
    for (const t of reconciled.filter((x) => x.result === null)) {
      console.error(`  FAILED ${t.slug}: ${t.error}`);
      process.exitCode = 1;
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
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
