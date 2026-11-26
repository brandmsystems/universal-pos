import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { appClient, assertCheckedSet, ownerClient } from '../helpers/db.js';
import { PERMISSION_KEYS, riskClassOf } from '../../src/modules/authz/permissions.js';
import { SYSTEM_ROLES, systemRole } from '../../src/modules/authz/systemRoles.js';
import {
  catalogueDrift,
  grantOwnerMemberships,
  reconcileAllTenantSystemRoles,
  seedPermissionCatalogue,
  seedTenantSystemRoles,
} from '../../src/modules/authz/seed.js';
import { effectiveAuthority, authorisingMembershipFor } from '../../src/modules/authz/grant.js';

let owner: pg.Client;
let app: pg.Client;

// A FRESH tenant per run, never a fixed id that has to be cleared first.
//
// The previous form deleted the tenant in beforeEach and enumerated its dependent
// tables to get past the FKs. That enumeration is a hand-maintained list of
// everything referencing `tenant` -- it broke when usage_counter was added, and
// would break again on the next platform table. Nothing in production deletes a
// tenant either: the ladder anonymises. So the fixture stops pretending it can.
let TENANT: string;
let BRANCH_ID: string;
let OWNER_USER_ID: string;

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  await owner.connect();
  await app.connect();
});

afterAll(async () => {
  await owner?.end();
  await app?.end();
});

describe('the permission catalogue seed', () => {
  it('converges, and is idempotent on a second run', async () => {
    const first = await seedPermissionCatalogue(owner);
    assertCheckedSet({
      label: 'catalogue rows written',
      checked: [...first.inserted, ...first.updated],
      minimum: 90,
      mustInclude: ['order.void', 'payment.collect', 'report.exception.view'],
    });

    const second = await seedPermissionCatalogue(owner);
    expect(second.inserted, 'a second run must insert nothing').toEqual([]);
    expect(second.updated.length).toBe(PERMISSION_KEYS.length);
    expect(await catalogueDrift(owner)).toEqual([]);
  });

  it('projects risk_class faithfully and derives is_dangerous from it', async () => {
    await seedPermissionCatalogue(owner);
    const rows = await owner.query<{ key: string; risk_class: string; is_dangerous: boolean }>(
      `SELECT key, risk_class, is_dangerous FROM platform.permission ORDER BY key`,
    );
    assertCheckedSet({
      label: 'seeded permissions',
      checked: rows.rows.map((r) => r.key),
      minimum: 90,
      mustInclude: ['customer.pii.view', 'recipe.edit', 'membership.grant'],
    });

    const mismatched = rows.rows.filter(
      (r) =>
        r.risk_class !== riskClassOf(r.key as never) ||
        r.is_dangerous !== (r.risk_class !== 'none'),
    );
    expect(mismatched).toEqual([]);
  });

  it('separates the three risk classes', async () => {
    await seedPermissionCatalogue(owner);
    const counts = await owner.query<{ risk_class: string; n: string }>(
      `SELECT risk_class, count(*)::text AS n FROM platform.permission GROUP BY 1 ORDER BY 1`,
    );
    const byClass = Object.fromEntries(counts.rows.map((r) => [r.risk_class, Number(r.n)]));
    expect(byClass['financial']).toBeGreaterThanOrEqual(17);
    // device.register joined the escalation class in Phase 2: a rogue terminal
    // can accept PINs. table.session.lease.force_release joined in Phase 5A: it
    // takes a session from a device that still believes it holds it, which is the
    // one moment two parties can both think they own an order.
    expect(byClass['escalation']).toBe(6);
    // Four since migration 0049: customer.pii.view (single record),
    // customer.pii.export (bulk, owner-only), user.pii.view -- split out
    // because the customer key was what the reveal route actually checked while
    // it read app_user -- and customer.erase, which answers a deletion request
    // by destroying a name and phone in place.
    expect(byClass['privacy']).toBe(4);

    // The loss-prevention report must never pick up PII access, so the two sets
    // must not overlap at all.
    const privacy = await owner.query<{ key: string }>(
      `SELECT key FROM platform.permission WHERE risk_class = 'privacy' ORDER BY key`,
    );
    expect(privacy.rows.map((r) => r.key)).toEqual(
      ['customer.erase', 'customer.pii.export', 'customer.pii.view', 'user.pii.view']);
  });

  it('does not touch created_at once a key exists', async () => {
    await seedPermissionCatalogue(owner);
    const before = await owner.query<{ created_at: Date }>(
      `SELECT created_at FROM platform.permission WHERE key = 'order.void'`,
    );
    await seedPermissionCatalogue(owner);
    const after = await owner.query<{ created_at: Date }>(
      `SELECT created_at FROM platform.permission WHERE key = 'order.void'`,
    );
    // Resetting this would wipe every role's "permissions added since" diff.
    expect(after.rows[0]?.created_at).toEqual(before.rows[0]?.created_at);
  });
});

describe('the per-tenant system role seed', () => {
  beforeEach(async () => {
    await seedPermissionCatalogue(owner);
    TENANT = randomUUID();
    BRANCH_ID = randomUUID();
    OWNER_USER_ID = randomUUID();
    await owner.query(
      `INSERT INTO platform.tenant (id, slug, name, default_currency, tax_jurisdiction)
       VALUES ($1, $2, 'Seed Probe', 'INR', 'IN')`,
      [TENANT, `seed-probe-${TENANT.slice(0, 8)}`],
    );
    await owner.query(
      `INSERT INTO app.branch (id, tenant_id, code, name, timezone, gst_registration)
       VALUES ($1, $2, 'MAIN', 'Main', 'Asia/Kolkata', 'unstated')`,
      [BRANCH_ID, TENANT],
    );
    await owner.query(
      `INSERT INTO app.app_user (id, tenant_id, full_name, email, status)
       VALUES ($1, $2, 'Seed Owner', 'owner@seed.probe', 'active')`,
      [OWNER_USER_ID, TENANT],
    );
  });

  it('seeds all seven roles with their caps, idempotently', async () => {
    const first = await seedTenantSystemRoles(owner, TENANT);
    assertCheckedSet({
      label: 'seeded system roles',
      checked: first.rolesInserted,
      minimum: 7,
      mustInclude: ['owner', 'branch_admin', 'manager', 'cashier', 'waiter', 'kds', 'accounts'],
    });
    expect(first.grantsAdded).toBeGreaterThan(200);

    const second = await seedTenantSystemRoles(owner, TENANT);
    expect(second.rolesInserted).toEqual([]);
    expect(second.grantsAdded, 'a second run must add no grants').toBe(0);
    expect(second.grantsRemoved, 'a second run must remove no grants').toBe(0);

    const caps = await owner.query<{ key: string; p: number; a: string | null }>(
      `SELECT key, discount_percent_cap AS p, discount_amount_cap::text AS a
         FROM app.role WHERE tenant_id = $1 ORDER BY key`,
      [TENANT],
    );
    const byKey = new Map(caps.rows.map((r) => [r.key, r]));
    expect(byKey.get('owner')).toMatchObject({ p: 100, a: null });
    expect(byKey.get('manager')).toMatchObject({ p: 20, a: '20000' });
    expect(byKey.get('cashier')).toMatchObject({ p: 0, a: null });
  });

  it('reproduces the matrix exactly in role_permission', async () => {
    await seedTenantSystemRoles(owner, TENANT);
    for (const role of SYSTEM_ROLES) {
      const rows = await owner.query<{ permission_key: string }>(
        `SELECT rp.permission_key FROM app.role_permission rp
           JOIN app.role r ON r.tenant_id = rp.tenant_id AND r.id = rp.role_id
          WHERE rp.tenant_id = $1 AND r.key = $2`,
        [TENANT, role.key],
      );
      expect(new Set(rows.rows.map((r) => r.permission_key)), role.key).toEqual(
        new Set(role.permissions),
      );
    }
  });

  it('revokes a key from a system role when it leaves the constant', async () => {
    await seedTenantSystemRoles(owner, TENANT);
    const roleId = (
      await owner.query<{ id: string }>(
        `SELECT id FROM app.role WHERE tenant_id = $1 AND key = 'waiter'`,
        [TENANT],
      )
    ).rows[0]!.id;

    await owner.query(
      `INSERT INTO app.role_permission (tenant_id, role_id, permission_key) VALUES ($1, $2, 'order.void')`,
      [TENANT, roleId],
    );
    const reseed = await seedTenantSystemRoles(owner, TENANT);
    expect(reseed.grantsRemoved).toBe(1);

    const still = await owner.query(
      `SELECT 1 FROM app.role_permission WHERE tenant_id = $1 AND role_id = $2 AND permission_key = 'order.void'`,
      [TENANT, roleId],
    );
    expect(still.rowCount).toBe(0);
  });

  it('locks system roles against the application role but not the seeder', async () => {
    await seedTenantSystemRoles(owner, TENANT);
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
      const roleId = (
        await app.query<{ id: string }>(
          `SELECT id FROM app.role WHERE tenant_id = $1 AND key = 'waiter'`,
          [TENANT],
        )
      ).rows[0]!.id;

      await expect(
        app.query(`UPDATE app.role SET name = 'Tampered' WHERE id = $1`, [roleId]),
      ).rejects.toThrow(/system roles are locked/i);
    } finally {
      await app.query('ROLLBACK');
    }

    // Editing role_permission directly reaches the same result by another door.
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
      const roleId = (
        await app.query<{ id: string }>(
          `SELECT id FROM app.role WHERE tenant_id = $1 AND key = 'cashier'`,
          [TENANT],
        )
      ).rows[0]!.id;
      await expect(
        app.query(
          `INSERT INTO app.role_permission (tenant_id, role_id, permission_key) VALUES ($1, $2, 'order.void')`,
          [TENANT, roleId],
        ),
      ).rejects.toThrow(/system roles are locked/i);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('aborts a scope narrowing that an existing membership contradicts', async () => {
    await seedTenantSystemRoles(owner, TENANT);
    const managerId = (
      await owner.query<{ id: string }>(
        `SELECT id FROM app.role WHERE tenant_id = $1 AND key = 'manager'`,
        [TENANT],
      )
    ).rows[0]!.id;

    await owner.query(
      `INSERT INTO app.membership (id, tenant_id, user_id, branch_id, role_id, role_assignable_scope)
       VALUES ($1, $2, $3, $4, $5, 'any')`,
      [randomUUID(), TENANT, OWNER_USER_ID, BRANCH_ID, managerId],
    );
    await expect(
      owner.query(`UPDATE app.role SET assignable_scope = 'tenant_only' WHERE id = $1`, [managerId]),
    ).rejects.toThrow(/membership_scope_agrees/i);
  });
});

describe('the deploy reconciles EXISTING tenants\' system roles', () => {
  it('a key added after a tenant was provisioned reaches its system roles, and only those', async () => {
    await seedPermissionCatalogue(owner);
    const tenant = randomUUID();
    await owner.query(
      `INSERT INTO platform.tenant (id, slug, name, default_currency, tax_jurisdiction)
       VALUES ($1, $2, 'Reconcile Probe', 'INR', 'IN')`, [tenant, `reconcile-${tenant.slice(0, 8)}`]);
    await seedTenantSystemRoles(owner, tenant);
    // As if provisioned before till.summary.view existed: the cashier lacks it,
    // and a custom role (which no seed may touch) is beside it.
    await owner.query(
      `DELETE FROM app.role_permission rp USING app.role r
        WHERE rp.tenant_id = $1 AND r.tenant_id = rp.tenant_id AND r.id = rp.role_id
          AND r.key = 'cashier' AND rp.permission_key = 'till.summary.view'`, [tenant]);
    const custom = randomUUID();
    await owner.query(
      `INSERT INTO app.role (id, tenant_id, key, name, is_system, assignable_scope) VALUES ($1, $2, 'my_till', 'My till', false, 'branch_only')`,
      [custom, tenant]);
    await owner.query(
      `INSERT INTO app.role_permission (tenant_id, role_id, permission_key) VALUES ($1, $2, 'payment.collect')`, [tenant, custom]);

    const [reconciled] = await reconcileAllTenantSystemRoles(owner, [tenant]);
    expect(reconciled).toMatchObject({ error: null, result: { grantsAdded: 1, grantsRemoved: 0 } });
    const holders = await owner.query<{ key: string }>(
      `SELECT r.key FROM app.role_permission rp JOIN app.role r ON r.tenant_id = rp.tenant_id AND r.id = rp.role_id
        WHERE rp.tenant_id = $1 AND rp.permission_key = 'till.summary.view' ORDER BY r.key`, [tenant]);
    expect(holders.rows.map((r) => r.key)).toEqual(['cashier', 'counter']);
    const customKeys = await owner.query<{ permission_key: string }>(
      `SELECT permission_key FROM app.role_permission WHERE tenant_id = $1 AND role_id = $2`, [tenant, custom]);
    expect(customKeys.rows.map((r) => r.permission_key)).toEqual(['payment.collect']);

    // Idempotent: a second deploy moves nothing.
    const [again] = await reconcileAllTenantSystemRoles(owner, [tenant]);
    expect(again!.result).toMatchObject({ grantsAdded: 0, grantsRemoved: 0 });
  });
});

describe('provisioning the owner', () => {
  beforeEach(async () => {
    await seedPermissionCatalogue(owner);
    TENANT = randomUUID();
    BRANCH_ID = randomUUID();
    OWNER_USER_ID = randomUUID();
    await owner.query(
      `INSERT INTO platform.tenant (id, slug, name, default_currency, tax_jurisdiction)
       VALUES ($1, $2, 'Seed Probe', 'INR', 'IN')`,
      [TENANT, `seed-probe-${TENANT.slice(0, 8)}`],
    );
    await owner.query(
      `INSERT INTO app.branch (id, tenant_id, code, name, timezone, gst_registration) VALUES ($1, $2, 'MAIN', 'Main', 'Asia/Kolkata', 'unstated')`,
      [BRANCH_ID, TENANT],
    );
    await owner.query(
      `INSERT INTO app.app_user (id, tenant_id, full_name, email, status)
       VALUES ($1, $2, 'Seed Owner', 'owner@seed.probe', 'active')`,
      [OWNER_USER_ID, TENANT],
    );
    await seedTenantSystemRoles(owner, TENANT);
  });

  it('creates the owner membership AND a cashier membership at the first branch', async () => {
    // A single-outlet owner-operator who cannot take a payment on day one is a
    // broken first run, and owner deliberately does not hold payment.collect.
    const result = await grantOwnerMemberships(owner, {
      tenantId: TENANT,
      ownerUserId: OWNER_USER_ID,
      firstBranchId: BRANCH_ID,
    });
    expect(result.created).toBe(true);

    const rows = await owner.query<{ key: string; branch_id: string | null }>(
      `SELECT r.key, m.branch_id FROM app.membership m
         JOIN app.role r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
        WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active' ORDER BY r.key`,
      [TENANT, OWNER_USER_ID],
    );
    expect(rows.rows).toEqual([
      { key: 'cashier', branch_id: BRANCH_ID },
      { key: 'owner', branch_id: null },
    ]);
  });

  it('is idempotent', async () => {
    await grantOwnerMemberships(owner, { tenantId: TENANT, ownerUserId: OWNER_USER_ID, firstBranchId: BRANCH_ID });
    const second = await grantOwnerMemberships(owner, { tenantId: TENANT, ownerUserId: OWNER_USER_ID, firstBranchId: BRANCH_ID });
    expect(second.created).toBe(false);

    const count = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.membership WHERE tenant_id = $1 AND user_id = $2`,
      [TENANT, OWNER_USER_ID],
    );
    expect(Number(count.rows[0]?.n)).toBe(2);
  });

  it('attributes a collected payment to the cashier membership, not the owner one', async () => {
    const granted = await grantOwnerMemberships(owner, {
      tenantId: TENANT,
      ownerUserId: OWNER_USER_ID,
      firstBranchId: BRANCH_ID,
    });

    const authority = effectiveAuthority(
      [
        {
          id: granted.ownerMembershipId,
          branchId: null,
          permissions: systemRole('owner').permissions,
          discountPercentCap: 100,
          discountAmountCap: null,
        },
        {
          id: granted.cashierMembershipId,
          branchId: BRANCH_ID,
          permissions: systemRole('cashier').permissions,
          discountPercentCap: 0,
          discountAmountCap: null,
        },
      ],
      { branchId: BRANCH_ID },
    );

    // The whole point: "owner collected cash at this branch" becomes a fact
    // about which capacity they acted in, not an inference from the union.
    expect(authorisingMembershipFor(authority, 'payment.collect')).toBe(granted.cashierMembershipId);
    // Narrowest scope wins, so a key both memberships carry attributes to the branch one.
    expect(authorisingMembershipFor(authority, 'order.view')).toBe(granted.cashierMembershipId);
    // A key only the owner membership carries still attributes correctly.
    expect(authorisingMembershipFor(authority, 'role.create')).toBe(granted.ownerMembershipId);
  });

  it('records the authorising membership on the audit row', async () => {
    const granted = await grantOwnerMemberships(owner, {
      tenantId: TENANT,
      ownerUserId: OWNER_USER_ID,
      firstBranchId: BRANCH_ID,
    });

    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
      const inserted = await app.query<{ authorising_membership_id: string }>(
        `INSERT INTO app.tenant_audit_log
           (id, tenant_id, branch_id, actor_kind, actor_user_id, actor_name, action, target_type,
            request_id, authorising_membership_id)
         VALUES (gen_random_uuid(), $1, $2, 'user', $3, 'Seed Owner', 'payment.collected', 'payment', 'req-1', $4)
         RETURNING authorising_membership_id`,
        [TENANT, BRANCH_ID, OWNER_USER_ID, granted.cashierMembershipId],
      );
      expect(inserted.rows[0]?.authorising_membership_id).toBe(granted.cashierMembershipId);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('rejects an audit row citing another tenant’s membership', async () => {
    await grantOwnerMemberships(owner, { tenantId: TENANT, ownerUserId: OWNER_USER_ID, firstBranchId: BRANCH_ID });
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
      await expect(
        app.query(
          `INSERT INTO app.tenant_audit_log
             (id, tenant_id, actor_kind, actor_name, action, target_type, request_id,
              authorising_membership_id)
           VALUES (gen_random_uuid(), $1, 'user', 'x', 'a', 't', 'r', gen_random_uuid())`,
          [TENANT],
        ),
      ).rejects.toThrow(/foreign key/i);
    } finally {
      await app.query('ROLLBACK');
    }
  });
});
