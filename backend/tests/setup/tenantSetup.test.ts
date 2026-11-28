import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';
import { withTenantTransaction } from '../../src/database/unitOfWork.js';
import { peekTenantContext, type TenantContext } from '../../src/database/tenantContext.js';
import {
  authenticatePin,
  checkPinPolicy,
  hashSecret,
  lockoutSeconds,
  revokeDevice,
} from '../../src/modules/authentication/deviceAuth.js';
import { checkSubsetGrant, effectiveAuthority } from '../../src/modules/authz/grant.js';
import { systemRole } from '../../src/modules/authz/systemRoles.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz } from '../../src/modules/authz/seed.js';

let owner: pg.Client;
let pool: pg.Pool;

let tenantId: string;
let branchId: string;
let otherBranchId: string;
let userId: string;
let planVersionId: string;
let superAdminId: string;

const FINGERPRINT = 'terminal-fingerprint-001';

function ctx(): TenantContext {
  return peekTenantContext()!;
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 6 });

  await seedPlatformAuthz(owner);
  const roleId = (
    await owner.query<{ id: string }>(
      `SELECT id FROM platform.platform_role WHERE key = 'super_admin'`,
    )
  ).rows[0]!.id;
  superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1, $2, 'argon2id$stub', 'Root', $3)`,
    [superAdminId, `setup+${superAdminId}@platform.test`, roleId],
  );

  const planId = randomUUID();
  await owner.query(
    `INSERT INTO platform.plan (id, key, name) VALUES ($1, 'setup_plan', 'Setup Plan')
     ON CONFLICT (key) DO NOTHING`,
    [planId],
  );
  const actualPlanId = (
    await owner.query<{ id: string }>(`SELECT id FROM platform.plan WHERE key = 'setup_plan'`)
  ).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version (id, plan_id, version, price_minor, currency, billing_period, published_at)
     VALUES ($1, $2, 1, 100000, 'INR', 'monthly', now())
     ON CONFLICT (plan_id, version) DO NOTHING`,
    [randomUUID(), actualPlanId],
  );
  planVersionId = (
    await owner.query<{ id: string }>(
      `SELECT id FROM platform.plan_version WHERE plan_id = $1 AND version = 1`,
      [actualPlanId],
    )
  ).rows[0]!.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const key = `setup-${randomUUID()}`;
    const result = await provisionTenant(client, {
      idempotencyKey: key,
      slug: `s${key.slice(6, 14)}`,
      name: 'Setup Probe',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      ownerEmail: `${key}@owner.test`,
      ownerName: 'Owner',
      firstBranchName: 'Main',
      planVersionId,
      taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId,
    });
    await client.query('COMMIT');
    tenantId = result.tenantId;
    branchId = result.firstBranchId;
    userId = result.ownerUserId;
  } finally {
    client.release();
  }

  otherBranchId = randomUUID();
  await owner.query(
    `INSERT INTO app.branch (id, tenant_id, code, name, timezone, gst_registration)
     VALUES ($1, $2, 'SECOND', 'Second', 'Asia/Kolkata', 'unstated')`,
    [otherBranchId, tenantId],
  );
  await owner.query(`UPDATE app.app_user SET status = 'active' WHERE id = $1`, [userId]);
});

afterAll(async () => {
  await pool?.end();
  await owner?.end();
});

/* --------------------------------------------------------------------- A --- */

describe('A. a PIN is only valid from a registered device', () => {
  /** A staff member: the till's PIN is staff's -- the owner, a manager, is refused one by role. */
  let staffId: string;
  beforeAll(async () => {
    staffId = randomUUID();
    await owner.query(
      `INSERT INTO app.app_user (id, tenant_id, full_name, employee_code, status) VALUES ($1, $2, 'Till Staff', 'TS1', 'active')`,
      [staffId, tenantId]);
    const waiter = (await owner.query<{ id: string; assignable_scope: string }>(
      `SELECT id, assignable_scope FROM app.role WHERE tenant_id = $1 AND key = 'waiter'`, [tenantId])).rows[0]!;
    await owner.query(
      `INSERT INTO app.membership (id, tenant_id, user_id, branch_id, role_id, role_assignable_scope)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), tenantId, staffId, branchId, waiter.id, waiter.assignable_scope]);
  });

  /** A registered till at a branch (a fixture: there are no setup codes to redeem). */
  async function enrol(fingerprint: string, branch = branchId): Promise<string> {
    const deviceId = randomUUID();
    await owner.query(
      `INSERT INTO app.device (id, tenant_id, branch_id, name, fingerprint, registered_by_user_id)
       VALUES ($1, $2, $3, 'Till 1', $4, $5)`,
      [deviceId, tenantId, branch, fingerprint, userId]);
    return deviceId;
  }

  async function setPin(pin: string): Promise<void> {
    const hash = await hashSecret(pin);
    await owner.query(
      `UPDATE app.credential SET status = 'revoked', revoked_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND type = 'pin' AND status = 'active'`,
      [tenantId, staffId],
    );
    await owner.query(
      `INSERT INTO app.credential (id, tenant_id, user_id, type, secret_hash)
       VALUES ($1, $2, $3, 'pin', $4)`,
      [randomUUID(), tenantId, staffId, hash],
    );
  }

  it('refuses a correct PIN from an unregistered device', async () => {
    await setPin('4816');
    const result = await withTenantTransaction(pool, tenantId, () =>
      authenticatePin(ctx(), {
        userId: staffId,
        pin: '4816',
        deviceFingerprint: 'never-enrolled',
        branchId,
      }),
    );
    // The PIN is correct. The terminal is not. That is the whole point of a
    // four-digit secret being defensible.
    expect(result).toEqual({ ok: false, reason: 'device_unknown' });
  });

  it('accepts the same PIN once the device is registered', async () => {
    await enrol(FINGERPRINT);
    const result = await withTenantTransaction(pool, tenantId, () =>
      authenticatePin(ctx(), { userId: staffId, pin: '4816', deviceFingerprint: FINGERPRINT, branchId }),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a device enrolled at another branch', async () => {
    const other = 'terminal-at-second-branch';
    await enrol(other, otherBranchId);
    const result = await withTenantTransaction(pool, tenantId, () =>
      authenticatePin(ctx(), { userId: staffId, pin: '4816', deviceFingerprint: other, branchId }),
    );
    expect(result).toEqual({ ok: false, reason: 'device_wrong_branch' });
  });

  it('stops accepting PINs the instant the device is revoked', async () => {
    const fingerprint = `revocation-probe-${randomUUID()}`;
    const deviceId = await enrol(fingerprint);

    const before = await withTenantTransaction(pool, tenantId, () =>
      authenticatePin(ctx(), { userId: staffId, pin: '4816', deviceFingerprint: fingerprint, branchId }),
    );
    expect(before.ok).toBe(true);

    await withTenantTransaction(pool, tenantId, () => revokeDevice(ctx(), deviceId, userId));

    // No caching of device trust: a stolen terminal stops working now, not at the
    // end of a TTL.
    const after = await withTenantTransaction(pool, tenantId, () =>
      authenticatePin(ctx(), { userId: staffId, pin: '4816', deviceFingerprint: fingerprint, branchId }),
    );
    expect(after).toEqual({ ok: false, reason: 'device_revoked' });
  });

  it('rejects a wrong PIN and locks out exponentially, never indefinitely', async () => {
    expect(lockoutSeconds(0)).toBe(0);
    expect(lockoutSeconds(2)).toBe(0);
    expect(lockoutSeconds(3)).toBe(60);
    expect(lockoutSeconds(4)).toBe(120);
    // Capped: an indefinite PIN lock mid-service is an outage.
    expect(lockoutSeconds(50)).toBe(15 * 60);

    await setPin('4816');
    const result = await withTenantTransaction(pool, tenantId, () =>
      authenticatePin(ctx(), { userId: staffId, pin: '9999', deviceFingerprint: FINGERPRINT, branchId }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'bad_pin' });
  });

  it('enforces the PIN policy', () => {
    expect(checkPinPolicy('123')).toBe('too_short');
    expect(checkPinPolicy('1234567')).toBe('too_long');
    expect(checkPinPolicy('12a4')).toBe('not_numeric');
    expect(checkPinPolicy('0000')).toBe('trivial_sequence');
    expect(checkPinPolicy('1234')).toBe('trivial_sequence');
    expect(checkPinPolicy('4321')).toBe('trivial_sequence');
    expect(checkPinPolicy('4816', { employeeCode: 'E4816' })).toBe('matches_employee_code');
    // Any digit run within the phone, not just a prefix.
    expect(checkPinPolicy('9900', { phone: '+91-98-9900-1234' })).toBe('found_in_phone');
    expect(checkPinPolicy('4816')).toBeNull();
  });

  it('leaves password credentials unbound to any device', async () => {
    // The web admin is used from anywhere; only PINs are device-bound.
    const columns = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'credential'`,
    );
    const names = columns.rows.map((r) => r.column_name);
    expect(names).not.toContain('branch_id');
    expect(names).not.toContain('device_id');
  });
});

/* --------------------------------------------------------------------- B --- */

describe('B. staff invites are tenant-plane and subject to the subset rule', () => {
  it('is a separate table from the control-plane owner invite', async () => {
    const staff = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'staff_invite'`,
    );
    const names = staff.rows.map((r) => r.column_name);
    // Reusing tenant_owner_invite would have put a control-plane writer inside
    // tenant identity.
    expect(names).not.toContain('invited_by_platform_user_id');
    expect(names).toContain('invited_by_user_id');
    expect(names).toContain('tenant_id');
  });

  it('stops a manager inviting an owner', () => {
    const manager = systemRole('manager');
    const authority = effectiveAuthority(
      [
        {
          id: 'm-manager',
          branchId: null,
          permissions: manager.permissions,
          discountPercentCap: manager.discountPercentCap,
          discountAmountCap: manager.discountAmountCap,
        },
      ],
      { branchId: null },
    );
    const decision = checkSubsetGrant(authority, systemRole('owner'));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.missing.length).toBeGreaterThan(0);
  });

  it('refuses an invite whose scope contradicts the role', async () => {
    const roleId = (
      await owner.query<{ id: string }>(
        `SELECT id FROM app.role WHERE tenant_id = $1 AND key = 'owner'`,
        [tenantId],
      )
    ).rows[0]!.id;

    // owner is tenant_only; naming a branch is the same contradiction membership
    // already refuses, caught one step earlier.
    await expect(
      owner.query(
        `INSERT INTO app.staff_invite
           (id, tenant_id, email, full_name, role_id, role_assignable_scope, branch_id,
            token_hash, expires_at, invited_by_user_id, credential_type)
         VALUES ($1, $2, 'x@y.test', 'X', $3, 'tenant_only', $4, $5, now() + interval '1 day', $6, 'password')`,
        [randomUUID(), tenantId, roleId, branchId, Buffer.from(randomUUID()), userId],
      ),
    ).rejects.toThrow(/staff_invite_scope_agrees/);
  });

  it('allows only one pending invite per address', async () => {
    const roleId = (
      await owner.query<{ id: string }>(
        `SELECT id FROM app.role WHERE tenant_id = $1 AND key = 'waiter'`,
        [tenantId],
      )
    ).rows[0]!.id;

    const insert = (token: string) =>
      owner.query(
        `INSERT INTO app.staff_invite
           (id, tenant_id, email, full_name, role_id, role_assignable_scope, branch_id,
            token_hash, expires_at, invited_by_user_id, credential_type)
         VALUES ($1, $2, 'dup@y.test', 'Dup', $3, 'branch_only', $4, $5, now() + interval '1 day', $6, 'password')`,
        [randomUUID(), tenantId, roleId, branchId, Buffer.from(token), userId],
      );

    await insert(randomUUID());
    await expect(insert(randomUUID())).rejects.toThrow(/one_pending_per_email/);
  });
});

/* --------------------------------------------------------------------- C --- */

describe('C. floors, table types and tables', () => {
  let groundId: string;
  let rooftopId: string;

  beforeAll(async () => {
    groundId = randomUUID();
    rooftopId = randomUUID();
    await owner.query(
      `INSERT INTO app.floor (id, tenant_id, branch_id, name, display_order)
       VALUES ($1, $2, $3, 'Ground', 1), ($4, $2, $3, 'Rooftop', 2)`,
      [groundId, tenantId, branchId, rooftopId],
    );
  });

  it('scopes table identifier uniqueness to the floor, not the branch', async () => {
    // Two floors legitimately both have a "1". Forcing branch-wide uniqueness
    // makes staff rename tables to satisfy the database.
    await owner.query(
      `INSERT INTO app.dining_table (id, tenant_id, branch_id, floor_id, identifier, seats)
       VALUES ($1, $2, $3, $4, '1', 4)`,
      [randomUUID(), tenantId, branchId, groundId],
    );
    await owner.query(
      `INSERT INTO app.dining_table (id, tenant_id, branch_id, floor_id, identifier, seats)
       VALUES ($1, $2, $3, $4, '1', 6)`,
      [randomUUID(), tenantId, branchId, rooftopId],
    );

    await expect(
      owner.query(
        `INSERT INTO app.dining_table (id, tenant_id, branch_id, floor_id, identifier, seats)
         VALUES ($1, $2, $3, $4, '1', 2)`,
        [randomUUID(), tenantId, branchId, groundId],
      ),
    ).rejects.toThrow(/identifier_per_floor/);
  });

  it('treats table types as tenant-defined reference data, not an enum', async () => {
    const rows = await owner.query<{ key: string }>(
      `INSERT INTO app.table_type (id, tenant_id, key, name) VALUES
         ($1, $4, 'ac', 'Air Conditioned'),
         ($2, $4, 'cabana', 'Poolside Cabana'),
         ($3, $4, 'majlis', 'Majlis Seating')
       RETURNING key`,
      [randomUUID(), randomUUID(), randomUUID(), tenantId],
    );
    // Nobody shipping the product would have guessed "majlis". An enum would need
    // a migration per tenant idea.
    expect(rows.rows.map((r) => r.key).sort()).toEqual(['ac', 'cabana', 'majlis']);

    const isEnum = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'dining_table'
          AND column_name = 'table_type_id' AND data_type = 'uuid'`,
    );
    expect(Number(isEnum.rows[0]!.n)).toBe(1);
  });

  it('archives tables rather than deleting them', async () => {
    const tableId = randomUUID();
    await owner.query(
      `INSERT INTO app.dining_table (id, tenant_id, branch_id, floor_id, identifier, seats)
       VALUES ($1, $2, $3, $4, 'ARCH-1', 2)`,
      [tableId, tenantId, branchId, groundId],
    );
    await expect(
      owner.query(
        `UPDATE app.dining_table SET status = 'archived' WHERE id = $1`,
        [tableId],
      ),
    ).rejects.toThrow(/archival_consistent/);

    await owner.query(
      `UPDATE app.dining_table SET status = 'archived', archived_at = now() WHERE id = $1`,
      [tableId],
    );
    const still = await owner.query(`SELECT 1 FROM app.dining_table WHERE id = $1`, [tableId]);
    expect(still.rowCount).toBe(1);
  });

  it('requires a positive seat count', async () => {
    await expect(
      owner.query(
        `INSERT INTO app.dining_table (id, tenant_id, branch_id, floor_id, identifier, seats)
         VALUES ($1, $2, $3, $4, 'ZERO', 0)`,
        [randomUUID(), tenantId, branchId, groundId],
      ),
    ).rejects.toThrow(/seats/);
  });
});

/* --------------------------------------------------------------------- D --- */

describe('D. kitchen stations and printers', () => {
  let grillId: string;
  let fryId: string;
  let printerA: string;
  let printerB: string;

  beforeAll(async () => {
    grillId = randomUUID();
    fryId = randomUUID();
    printerA = randomUUID();
    printerB = randomUUID();
    // The code vocabulary is tenant-level and a station must realise one of its
    // codes -- 0021 made that an FK precisely so two branches cannot spell the
    // same station differently and silently break menu routing.
    await owner.query(
      `INSERT INTO app.station_code (tenant_id, code, name) VALUES
         ($1, 'grill', 'Grill'), ($1, 'fry', 'Fryer')
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenantId],
    );
    await owner.query(
      `INSERT INTO app.kitchen_station (id, tenant_id, branch_id, code, name) VALUES
         ($1, $3, $4, 'grill', 'Grill'), ($2, $3, $4, 'fry', 'Fryer')`,
      [grillId, fryId, tenantId, branchId],
    );
    await owner.query(
      `INSERT INTO app.printer (id, tenant_id, branch_id, name, connection_kind, address) VALUES
         ($1, $3, $4, 'Kitchen A', 'network', '10.0.0.11'),
         ($2, $3, $4, 'Kitchen B', 'network', '10.0.0.12')`,
      [printerA, printerB, tenantId, branchId],
    );
  });

  it('requires a station to realise a code from the tenant vocabulary', async () => {
    // A free-text key that something else derives from is a drift vector.
    await expect(
      owner.query(
        `INSERT INTO app.kitchen_station (id, tenant_id, branch_id, code, name)
         VALUES ($1, $2, $3, 'invented', 'Invented')`,
        [randomUUID(), tenantId, branchId],
      ),
    ).rejects.toThrow(/kitchen_station_code_fk/);
  });

  it('keeps kitchen_station structurally distinct from role', async () => {
    // kitchen_station is a resource; kds is a role. Asserted, not left to the
    // fact that nobody has conflated them yet.
    const fks = await owner.query<{ target: string }>(
      `SELECT t.relname AS target
         FROM pg_constraint c
         JOIN pg_class s ON s.oid = c.conrelid
         JOIN pg_namespace sn ON sn.oid = s.relnamespace
         JOIN pg_class t ON t.oid = c.confrelid
        WHERE c.contype = 'f' AND sn.nspname = 'app' AND s.relname = 'kitchen_station'`,
    );
    expect(fks.rows.map((r) => r.target)).not.toContain('role');

    const columns = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'kitchen_station'`,
    );
    expect(columns.rows.map((r) => r.column_name).filter((c) => /role/.test(c))).toEqual([]);

    // And the kds role is still a role, carrying station-agnostic keys.
    expect(systemRole('kds').permissions).toContain('kds.view');
  });

  it('models printer-to-station as many-to-many, both directions real', async () => {
    // One station, several printers: a jam must not stop service.
    await owner.query(
      `INSERT INTO app.station_printer (tenant_id, station_id, printer_id, is_primary)
       VALUES ($1, $2, $3, true), ($1, $2, $4, false)`,
      [tenantId, grillId, printerA, printerB],
    );
    // One printer, several stations: a small kitchen runs one printer for all.
    await owner.query(
      `INSERT INTO app.station_printer (tenant_id, station_id, printer_id, is_primary)
       VALUES ($1, $2, $3, true)`,
      [tenantId, fryId, printerA],
    );

    const byStation = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.station_printer WHERE tenant_id = $1 AND station_id = $2`,
      [tenantId, grillId],
    );
    const byPrinter = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.station_printer WHERE tenant_id = $1 AND printer_id = $2`,
      [tenantId, printerA],
    );
    expect(Number(byStation.rows[0]!.n)).toBe(2);
    expect(Number(byPrinter.rows[0]!.n)).toBe(2);
  });

  it('allows exactly one primary printer per station', async () => {
    await expect(
      owner.query(
        `UPDATE app.station_printer SET is_primary = true
          WHERE tenant_id = $1 AND station_id = $2 AND printer_id = $3`,
        [tenantId, grillId, printerB],
      ),
    ).rejects.toThrow(/one_primary_per_station/);
  });

  it('makes the fallback a real column, not a convention', async () => {
    await owner.query(
      `UPDATE app.printer SET fallback_printer_id = $2 WHERE id = $1`,
      [printerA, printerB],
    );
    const row = await owner.query<{ fallback_printer_id: string }>(
      `SELECT fallback_printer_id FROM app.printer WHERE id = $1`,
      [printerA],
    );
    expect(row.rows[0]!.fallback_printer_id).toBe(printerB);

    await expect(
      owner.query(`UPDATE app.printer SET fallback_printer_id = id WHERE id = $1`, [printerA]),
    ).rejects.toThrow(/fallback_is_not_self/);
  });

  it('cannot fall back to another tenant’s printer', async () => {
    await expect(
      owner.query(`UPDATE app.printer SET fallback_printer_id = $2 WHERE id = $1`, [
        printerA,
        randomUUID(),
      ]),
    ).rejects.toThrow(/printer_fallback_fk/);
  });
});

/* ------------------------------------------------------------- coverage --- */

describe('the Phase 2 tables are tenant-scoped like everything else', () => {
  it('carries tenant_id, RLS and a WITH CHECK policy on every one', async () => {
    const checked = await owner.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')`,
    );
    assertCheckedSet({
      label: 'phase 2 app relations',
      checked: checked.rows.map((r) => r.relname),
      minimum: 21,
      mustInclude: [
        'device',
        'device_enrolment',
        'staff_invite',
        'floor',
        'table_type',
        'dining_table',
        'kitchen_station',
        'printer',
        'station_printer',
      ],
    });
  });

  it('blocks a cross-tenant read of the new tables', async () => {
    const otherTenant = randomUUID();
    await owner.query(
      `INSERT INTO platform.tenant (id, slug, name, default_currency, tax_jurisdiction)
       VALUES ($1, $2, 'Other', 'INR', 'IN')`,
      [otherTenant, `o${otherTenant.slice(0, 8)}`],
    );

    const appPool = new pg.Pool({ connectionString: process.env['DATABASE_URL_APP']!, max: 2 });
    try {
      const visible = await withTenantTransaction(appPool, otherTenant, async () => {
        const result = await ctx().client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM app.dining_table`,
        );
        return Number(result.rows[0]!.n);
      });
      expect(visible, 'another tenant must see none of these tables').toBe(0);
    } finally {
      await appPool.end();
    }
  });
});
