import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { PERMISSIONS, PERMISSION_KEYS, riskClassOf, riskSubclassOf } from './permissions.js';
import { SYSTEM_ROLES, type SystemRoleDefinition } from './systemRoles.js';
import { PLATFORM_PERMISSIONS, platformRiskClassOf } from './platformPermissions.js';
import { PLATFORM_ROLES } from './platformRoles.js';

/**
 * Seeds run as katkitchen_owner: they bypass RLS (tenant_id is passed
 * explicitly) and they are the only caller the system-role lock permits.
 *
 * Everything here is idempotent and safe to re-run on every deploy.
 */

export interface CatalogueSeedResult {
  readonly inserted: readonly string[];
  readonly updated: readonly string[];
  /** In the table but no longer in the constant. Reported, never deleted. */
  readonly orphaned: readonly string[];
}

/**
 * The catalogue is global reference data, so this runs once per database rather
 * than once per tenant.
 *
 * created_at is deliberately left alone on conflict. It records when a key first
 * entered *this* database, which is what makes "N permissions added since this
 * role was created" exact on an existing install and correctly empty on a fresh
 * one. Touching it here would reset every role's diff on every deploy.
 */
export async function seedPermissionCatalogue(client: pg.ClientBase): Promise<CatalogueSeedResult> {
  const keys = PERMISSIONS.map((p) => p.key);
  const result = await client.query<{ key: string; was_inserted: boolean }>(
    `INSERT INTO platform.permission (key, module, name, description, risk_class, risk_subclass)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
     ON CONFLICT (key) DO UPDATE
       SET module        = EXCLUDED.module,
           name          = EXCLUDED.name,
           description   = EXCLUDED.description,
           risk_class    = EXCLUDED.risk_class,
           risk_subclass = EXCLUDED.risk_subclass
     RETURNING key, (xmax = 0) AS was_inserted`,
    [
      keys,
      PERMISSIONS.map((p) => p.module),
      PERMISSIONS.map((p) => p.name),
      PERMISSIONS.map((p) => p.description),
      PERMISSIONS.map((p) => riskClassOf(p.key)),
      PERMISSIONS.map((p) => riskSubclassOf(p.key)),
    ],
  );

  // Never deleted: role_permission references them ON DELETE RESTRICT, and a key
  // vanishing from the constant is more likely a bad merge than an intent to
  // revoke it from everyone holding it.
  const orphaned = await client.query<{ key: string }>(
    `SELECT key FROM platform.permission WHERE key <> ALL($1::text[]) ORDER BY key`,
    [keys],
  );

  return {
    inserted: result.rows.filter((r) => r.was_inserted).map((r) => r.key),
    updated: result.rows.filter((r) => !r.was_inserted).map((r) => r.key),
    orphaned: orphaned.rows.map((r) => r.key),
  };
}

export interface TenantRoleSeedResult {
  readonly rolesInserted: readonly string[];
  readonly rolesUpdated: readonly string[];
  readonly grantsAdded: number;
  readonly grantsRemoved: number;
}

export interface TenantReconciliation {
  readonly slug: string;
  readonly result: TenantRoleSeedResult | null;
  readonly error: string | null;
}

/**
 * Every EXISTING tenant's system roles brought to `SYSTEM_ROLES`, through the
 * same `seedTenantSystemRoles` provisioning runs. Without it a new permission
 * key reaches only tenants created after the deploy that added it. Called on
 * every deploy (core/database/seed.ts) and by `pnpm reconcile:roles`; custom
 * roles are never touched. One transaction per tenant: a failure on one must
 * not deny the rest, and it is reported, not swallowed.
 */
export async function reconcileAllTenantSystemRoles(
  client: pg.ClientBase,
  /** Narrow to these tenants (a test, one restaurant by hand); every tenant when omitted. */
  only?: readonly string[],
): Promise<readonly TenantReconciliation[]> {
  const tenants = await client.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM platform.tenant WHERE $1::uuid[] IS NULL OR id = ANY($1::uuid[]) ORDER BY created_at`,
    [only === undefined ? null : [...only]],
  );
  const out: TenantReconciliation[] = [];
  for (const tenant of tenants.rows) {
    await client.query('BEGIN');
    try {
      const result = await seedTenantSystemRoles(client, tenant.id);
      await client.query('COMMIT');
      out.push({ slug: tenant.slug, result, error: null });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      out.push({ slug: tenant.slug, result: null, error: String(error) });
    }
  }
  return out;
}

async function seedOneRole(
  client: pg.ClientBase,
  tenantId: string,
  role: SystemRoleDefinition,
): Promise<{ id: string; inserted: boolean; added: number; removed: number }> {
  const upserted = await client.query<{ id: string; was_inserted: boolean }>(
    `INSERT INTO app.role (id, tenant_id, key, name, description, is_system,
                           assignable_scope, discount_percent_cap, discount_amount_cap)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)
     ON CONFLICT (tenant_id, key) DO UPDATE
       SET name                 = EXCLUDED.name,
           description          = EXCLUDED.description,
           assignable_scope     = EXCLUDED.assignable_scope,
           discount_percent_cap = EXCLUDED.discount_percent_cap,
           discount_amount_cap  = EXCLUDED.discount_amount_cap
     RETURNING id, (xmax = 0) AS was_inserted`,
    [
      randomUUID(),
      tenantId,
      role.key,
      role.name,
      role.description,
      role.assignableScope,
      role.discountPercentCap,
      role.discountAmountCap,
    ],
  );

  const row = upserted.rows[0];
  if (!row) throw new Error(`failed to seed role ${role.key} for tenant ${tenantId}`);

  const added = await client.query(
    `INSERT INTO app.role_permission (tenant_id, role_id, permission_key)
     SELECT $1, $2, k FROM unnest($3::text[]) AS k
     ON CONFLICT (tenant_id, role_id, permission_key) DO NOTHING`,
    [tenantId, row.id, role.permissions],
  );

  // A key removed from the constant is revoked from the system role it was
  // seeded into. Custom roles are never touched by this reconciliation.
  const removed = await client.query(
    `DELETE FROM app.role_permission
      WHERE tenant_id = $1 AND role_id = $2 AND permission_key <> ALL($3::text[])`,
    [tenantId, row.id, role.permissions],
  );

  return {
    id: row.id,
    inserted: row.was_inserted,
    added: added.rowCount ?? 0,
    removed: removed.rowCount ?? 0,
  };
}

export async function seedTenantSystemRoles(
  client: pg.ClientBase,
  tenantId: string,
): Promise<TenantRoleSeedResult> {
  const rolesInserted: string[] = [];
  const rolesUpdated: string[] = [];
  let grantsAdded = 0;
  let grantsRemoved = 0;

  for (const role of SYSTEM_ROLES) {
    const outcome = await seedOneRole(client, tenantId, role);
    (outcome.inserted ? rolesInserted : rolesUpdated).push(role.key);
    grantsAdded += outcome.added;
    grantsRemoved += outcome.removed;
  }

  return { rolesInserted, rolesUpdated, grantsAdded, grantsRemoved };
}

export interface OwnerMembershipResult {
  readonly ownerMembershipId: string;
  readonly cashierMembershipId: string;
  readonly created: boolean;
}

/**
 * Provisioning must create BOTH memberships, not just the owner one.
 *
 * Owner deliberately does not hold payment.collect -- dual capacity is modelled
 * as two memberships rather than one role holding both sides. The consequence is
 * that a single-outlet owner-operator would otherwise be unable to take a
 * payment on their first day, which is a broken first run for most of the
 * market. Explicit and present at provisioning, not a support ticket.
 *
 * Called inside the provisioning transaction (Phase 1) after the tenant, its
 * first branch, the owner user and the system roles exist.
 */
export async function grantOwnerMemberships(
  client: pg.ClientBase,
  params: { tenantId: string; ownerUserId: string; firstBranchId: string },
): Promise<OwnerMembershipResult> {
  const { tenantId, ownerUserId, firstBranchId } = params;

  const roles = await client.query<{ key: string; id: string; assignable_scope: string }>(
    `SELECT key, id, assignable_scope FROM app.role
      WHERE tenant_id = $1 AND key = ANY($2::text[]) AND is_system`,
    [tenantId, ['owner', 'cashier']],
  );
  const byKey = new Map(roles.rows.map((r) => [r.key, r]));
  const ownerRole = byKey.get('owner');
  const cashierRole = byKey.get('cashier');
  if (!ownerRole || !cashierRole) {
    throw new Error(`system roles are not seeded for tenant ${tenantId}`);
  }

  async function ensure(
    role: { id: string; assignable_scope: string },
    branchId: string | null,
  ): Promise<{ id: string; created: boolean }> {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM app.membership
        WHERE tenant_id = $1 AND user_id = $2 AND role_id = $3
          AND branch_id IS NOT DISTINCT FROM $4 AND status = 'active'`,
      [tenantId, ownerUserId, role.id, branchId],
    );
    const found = existing.rows[0];
    if (found) return { id: found.id, created: false };

    const id = randomUUID();
    await client.query(
      `INSERT INTO app.membership
         (id, tenant_id, user_id, branch_id, role_id, role_assignable_scope)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, tenantId, ownerUserId, branchId, role.id, role.assignable_scope],
    );
    return { id, created: true };
  }

  // Table-driven so Phase 4 adds a row rather than a fourth copy of this logic.
  const plan: readonly { role: { id: string; assignable_scope: string }; branchId: string | null }[] = [
    { role: ownerRole, branchId: null },
    { role: cashierRole, branchId: firstBranchId },
  ];

  const results = [];
  for (const step of plan) results.push(await ensure(step.role, step.branchId));

  return {
    ownerMembershipId: results[0]!.id,
    cashierMembershipId: results[1]!.id,
    created: results.some((r) => r.created),
  };
}

/** Sanity check for the reconciliation: the table must match the constant exactly. */
export async function catalogueDrift(client: pg.ClientBase): Promise<readonly string[]> {
  const result = await client.query<{ key: string; reason: string }>(
    `SELECT key, 'in table, not in constant' AS reason
       FROM platform.permission WHERE key <> ALL($1::text[])
      UNION ALL
     SELECT k, 'in constant, not in table'
       FROM unnest($1::text[]) AS k
      WHERE NOT EXISTS (SELECT 1 FROM platform.permission p WHERE p.key = k)`,
    [PERMISSION_KEYS],
  );
  return result.rows.map((r) => `${r.key}: ${r.reason}`);
}


/* ------------------------------------------------- control plane seeding --- */

export interface PlatformSeedResult {
  readonly permissionsInserted: number;
  readonly rolesSeeded: readonly string[];
  readonly grantsAdded: number;
  readonly grantsRemoved: number;
}

/**
 * Seeds the CONTROL-PLANE catalogue and its five fixed roles. Separate table,
 * separate vocabulary, separate function -- a shared seeder is how a tenant key
 * would eventually end up on a platform role.
 */
export async function seedPlatformAuthz(client: pg.ClientBase): Promise<PlatformSeedResult> {
  const keys = PLATFORM_PERMISSIONS.map((p) => p.key);
  const permissions = await client.query<{ key: string; was_inserted: boolean }>(
    `INSERT INTO platform.platform_permission (key, module, name, description, risk_class)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
     ON CONFLICT (key) DO UPDATE
       SET module = EXCLUDED.module, name = EXCLUDED.name,
           description = EXCLUDED.description, risk_class = EXCLUDED.risk_class
     RETURNING key, (xmax = 0) AS was_inserted`,
    [
      keys,
      PLATFORM_PERMISSIONS.map((p) => p.module),
      PLATFORM_PERMISSIONS.map((p) => p.name),
      PLATFORM_PERMISSIONS.map((p) => p.description),
      PLATFORM_PERMISSIONS.map((p) => platformRiskClassOf(p.key)),
    ],
  );

  const rolesSeeded: string[] = [];
  let grantsAdded = 0;
  let grantsRemoved = 0;

  for (const role of PLATFORM_ROLES) {
    const upserted = await client.query<{ id: string }>(
      `INSERT INTO platform.platform_role (id, key, name, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
       RETURNING id`,
      [randomUUID(), role.key, role.name, role.description],
    );
    const roleId = upserted.rows[0]!.id;
    rolesSeeded.push(role.key);

    const added = await client.query(
      `INSERT INTO platform.platform_role_permission (platform_role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) AS k
       ON CONFLICT (platform_role_id, permission_key) DO NOTHING`,
      [roleId, role.permissions],
    );
    const removed = await client.query(
      `DELETE FROM platform.platform_role_permission
        WHERE platform_role_id = $1 AND permission_key <> ALL($2::text[])`,
      [roleId, role.permissions],
    );
    grantsAdded += added.rowCount ?? 0;
    grantsRemoved += removed.rowCount ?? 0;
  }

  return {
    permissionsInserted: permissions.rows.filter((r) => r.was_inserted).length,
    rolesSeeded,
    grantsAdded,
    grantsRemoved,
  };
}
