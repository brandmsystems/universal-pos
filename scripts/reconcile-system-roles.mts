/**
 * Reconciles every EXISTING tenant's system roles against `SYSTEM_ROLES`.
 *
 * ###########################################################################
 * A NEW PERMISSION KEY REACHES NO TENANT THAT ALREADY EXISTS.
 *
 * `seedTenantSystemRoles` is idempotent reconciliation -- it upserts each system
 * role, adds the keys the constant lists and REVOKES the ones it no longer does
 * -- and it has exactly one caller: `provisionTenant`. So it runs once, when the
 * tenant is created, and never again.
 *
 * That is invisible and it is this repo's recurring defect exactly. Adding
 * `branch.gst.state` to `PERMISSIONS` put the key in the catalogue, gave the
 * route a key to check, and passed every test -- because every test provisions
 * its tenant AFTER the constant changed. In a real deployment the Owner of a
 * tenant created last month holds no such row in `app.role_permission`, so the
 * new route answers 403 to the one person it was built for, and nothing
 * anywhere reports it.
 *
 * `catalogueDrift` does not catch it: it compares the CONSTANT to
 * `platform.permission`, which `db:seed` keeps in step. The gap is between the
 * constant and each tenant's own `app.role_permission` rows, and there are as
 * many of those as there are tenants.
 *
 * So: run this after any change to `PERMISSIONS` or `SYSTEM_ROLES`. It runs the
 * SAME function provisioning runs, so there is one definition of what a system
 * role holds, and it reports per tenant what moved.
 *
 * It reconciles SYSTEM roles only. A custom role an owner authored is never
 * touched -- the DELETE inside `seedOneRole` is scoped to the role it just
 * upserted.
 *
 *   pnpm reconcile:roles
 * ###########################################################################
 */
import pg from 'pg';
import { seedPermissionCatalogue, reconcileAllTenantSystemRoles, catalogueDrift } from '../backend/src/modules/authz/seed.js';
import { env } from '../backend/src/config/env.js';

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: env.ownerDatabaseUrl() });
  await client.connect();
  try {
    // The catalogue first. A role_permission row references
    // `platform.permission(key)`, so reconciling a role before the key exists
    // is refused by the foreign key -- and the refusal would look like a bug in
    // the role rather than a missing seed step.
    const catalogue = await seedPermissionCatalogue(client);
    // `inserted` is the list of KEYS, not a count. Interpolating it directly
    // printed an empty string for the ordinary case of nothing new, which read
    // as "the catalogue step did nothing at all" -- the opposite of reassuring
    // on the one run where it matters.
    console.log(catalogue.inserted.length === 0
      ? 'catalogue: no new permissions (already up to date)'
      : `catalogue: inserted ${catalogue.inserted.join(', ')}`);
    if (catalogue.orphaned.length > 0) {
      // In the table and no longer in the constant. Reported, never deleted.
      console.log(`catalogue: orphaned (kept) ${catalogue.orphaned.join(', ')}`);
    }

    const drift = await catalogueDrift(client);
    if (drift.length > 0) {
      // Reported and NOT fatal: a key in the table that the constant dropped is
      // a real state during a rollback, and refusing to reconcile the roles
      // would leave them stale for the sake of tidiness.
      console.log('catalogue drift:');
      for (const line of drift) console.log(`  ${line}`);
    }

    // The same loop the deploy seed runs (modules/authz/seed.ts).
    const reconciled = await reconcileAllTenantSystemRoles(client);
    let changed = 0;
    for (const { slug, result, error } of reconciled) {
      if (result === null) {
        console.error(`  FAILED ${slug}: ${error}`);
        process.exitCode = 1;
        continue;
      }
      if (result.grantsAdded + result.grantsRemoved > 0) changed += 1;
      console.log(
        `  ${slug.padEnd(24)} +${result.grantsAdded} -${result.grantsRemoved}`
        + (result.rolesInserted.length > 0 ? ` (roles created: ${result.rolesInserted.join(', ')})` : ''),
      );
    }

    console.log(`\n${reconciled.length} tenant(s) checked, ${changed} changed.`);
  } finally {
    await client.end();
  }
}

await main();
