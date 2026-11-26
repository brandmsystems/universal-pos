import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { signToken } from '../../src/modules/auth/jwt.js';
import { planeGuard } from '../../src/core/security/planeGuards.js';
import { registerTenantRoute, resetRegistry } from '../../src/core/middleware/routeRegistry.js';
import { toErrorResponse } from '../../src/core/errors/errors.js';
import { adminRoutes } from '../../src/routes/index.js';
import { adminHandlers } from '../../src/routes/handlers/admin.js';
import { crmHandlers } from '../../src/routes/handlers/crm.js';
import { handlerName, isUnserved } from '../../src/routes/lookup.js';
import {
  ADMIN_RESOURCES, writableOnly, UnwritableFieldsError, type AdminResource,
} from '../../src/modules/restaurants/adminResources.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';
import { planCache } from '../helpers/plans.js';

/**
 * The generic admin CRUD surface.
 *
 * ###########################################################################
 * A GENERATED HANDLER IS ONE MISTAKE APPLIED FORTY TIMES.
 *
 * That is the argument FOR generating them -- one implementation to get right --
 * and it is also why this file exists. The three hazards a generic CRUD layer
 * has are all silent:
 *
 *   mass assignment    `repo.update({id}, body)` lets `PATCH /admin/devices/:id`
 *                      with `{"status":"active"}` un-revoke a stolen terminal
 *                      through a route whose key is only `device.edit`
 *   column leakage     `SELECT *` returns `device.fingerprint` and
 *                      `app_user.email` to anything holding `*.view`
 *   scope escape       a branch-scoped session editing another branch's row by
 *                      naming its id
 *
 * None of the three produces an error. Each one returns 200.
 * ###########################################################################
 */

const KEY = 'admin-surface-signing-key';

let owner: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let tenantId: string, branchId: string, otherBranchId: string, userId: string;

function token(overrides: Record<string, unknown> = {}): string {
  return signToken(
    { sub: userId, tenant_id: tenantId, branch_id: branchId,
      exp: Math.floor(Date.now() / 1000) + 600, ...overrides },
    KEY,
  );
}

async function send(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
  claims: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method, url: `/api/t${url}`,
    headers: {
      authorization: `Bearer ${token(claims)}`,
      // Only when there IS a body. A JSON content-type with no body is a
      // separate refusal (FST_ERR_CTP_EMPTY_JSON_BODY) and not what these tests
      // are about -- though it is now mapped rather than a 500.
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 6 });
  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);

  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key='super_admin'`)).rows[0]!.id;
  const superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id,email,password_hash,full_name,platform_role_id)
     VALUES ($1,$2,'argon2id$stub','Root',$3)`,
    [superAdminId, `adm+${superAdminId}@p.test`, roleId]);
  await owner.query(`INSERT INTO platform.plan (id,key,name) VALUES ($1,'adm_plan','Adm')
    ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
  const planId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan WHERE key='adm_plan'`)).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version
       (id,plan_id,version,price_minor,currency,billing_period,published_at)
     VALUES ($1,$2,1,100000,'INR','monthly',now()) ON CONFLICT (plan_id,version) DO NOTHING`,
    [randomUUID(), planId]);
  const planVersionId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan_version WHERE plan_id=$1 AND version=1`, [planId])).rows[0]!.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const key = `adm-${randomUUID()}`;
    const r = await provisionTenant(client, {
      idempotencyKey: key, slug: `d${key.slice(4, 12)}`, name: 'Admin Probe',
      currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: `${key}@d.test`,
      ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
      taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId });
    await client.query('COMMIT');
    tenantId = r.tenantId; branchId = r.firstBranchId; userId = r.ownerUserId;
  } finally { client.release(); }

  await owner.query(`UPDATE app.app_user SET status='active' WHERE id=$1`, [userId]);

  otherBranchId = randomUUID();
  await owner.query(
    `INSERT INTO app.branch (id,tenant_id,code,name,timezone,gst_registration)
     VALUES ($1,$2,'SECOND','Second','Asia/Kolkata','unstated')`, [otherBranchId, tenantId]);

  // A station in each branch, so the scope test has something to try to reach.
  for (const [branch, code, name] of [
    [branchId, 'curry', 'Curry (main)'], [otherBranchId, 'curry', 'Curry (second)'],
  ] as const) {
    await owner.query(
      `INSERT INTO app.station_code (tenant_id, code, name) VALUES ($1,$2,$2)
       ON CONFLICT DO NOTHING`, [tenantId, code]);
    await owner.query(
      `INSERT INTO app.kitchen_station (id,tenant_id,branch_id,name,code,display_order)
       VALUES ($1,$2,$3,$4,$5,1)`, [randomUUID(), tenantId, branch, name, code]);
  }

  // A revoked device, which is the mass-assignment target. Revoked properly:
  // `device_revocation_consistent` requires status, revoked_at and
  // revoked_by_user_id to move together, and a fixture that skips them is
  // asserting against a state the schema does not permit.
  await owner.query(
    `INSERT INTO app.device
       (id,tenant_id,branch_id,name,fingerprint,status,registered_by_user_id,
        revoked_at,revoked_by_user_id)
     VALUES ($1,$2,$3,'Stolen till',$4,'revoked',$5,now(),$5)`,
    [randomUUID(), tenantId, branchId, randomUUID().replace(/-/g, ''), userId]);

  resetRegistry();
  app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const { status, body } = toErrorResponse(error);
    void reply.code(status).send(body);
  });
  app.register(async (scope) => {
    scope.addHook('onRequest', planeGuard('tenant', KEY));
    for (const route of adminRoutes({ ...adminHandlers(), ...crmHandlers() })) {
      if (isUnserved(route.handler)) continue;
      registerTenantRoute(scope, { pool, entitlements: planCache() }, route);
    }
  }, { prefix: '/api/t' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await owner?.end();
});

/* ------------------------------------------------------- mass assignment --- */

describe('a field is writable only where the declaration says so', () => {
  it('REFUSES a status change through the edit route, rather than ignoring it', async () => {
    // The defect in its exact shape: relabel-a-till permission used to
    // un-revoke a stolen one. It must not silently succeed AND must not silently
    // do nothing -- a caller told 200 believes it worked.
    const result = await send('PATCH', '/admin/branches/' + branchId, { status: 'active' });
    expect(result.status).toBe(422);
    expect(result.body['error']).toBe('fields_not_writable');
    expect(String(result.body['detail'])).toContain('status');
  });

  it('leaves the row untouched when it refuses', async () => {
    const before = await owner.query<{ status: string }>(
      `SELECT status FROM app.branch WHERE id=$1`, [branchId]);
    await send('PATCH', '/admin/branches/' + branchId, { name: 'Renamed', status: 'inactive' });
    const after = await owner.query<{ status: string }>(
      `SELECT status, name FROM app.branch WHERE id=$1`, [branchId]);
    // Not partially applied. The refusal happens before the UPDATE is composed,
    // so the legal half of a mixed request does not land either.
    expect(after.rows[0]!.status).toBe(before.rows[0]!.status);
    expect((after.rows[0] as Record<string, unknown>)['name']).not.toBe('Renamed');
  });

  it('accepts the fields it does declare', async () => {
    const result = await send('PATCH', '/admin/branches/' + branchId, { name: 'Renamed Branch' });
    expect(result.status).toBe(200);
    expect(result.body['name']).toBe('Renamed Branch');
  });

  it('refuses tenant_id explicitly, which is the escape everything else rests on',
    async () => {
      const result = await send('PATCH', '/admin/branches/' + branchId,
        { tenant_id: randomUUID() });
      expect(result.status).toBe(422);
      expect(result.body['error']).toBe('fields_not_writable');
    });

  it('refuses a structured value where a column expects a scalar', async () => {
    const result = await send('PATCH', '/admin/branches/' + branchId,
      { name: { $ne: null } });
    expect(result.status).toBe(422);
    expect(result.body['error']).toBe('field_value_not_scalar');
  });

  it('refuses an empty body rather than reporting a successful no-op', async () => {
    const result = await send('PATCH', '/admin/branches/' + branchId, {});
    expect(result.status).toBe(400);
    expect(result.body['error']).toBe('nothing_to_update');
  });
});

/* --------------------------------------------------------- column leakage --- */

describe('a list returns declared columns and nothing else', () => {
  it('never returns a device fingerprint', async () => {
    const result = await send('GET', '/admin/devices');
    expect(result.status).toBe(200);
    const rows = result.body['rows'] as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // The fingerprint is what a PIN login is checked against. `device.view`
      // must not be a way to obtain one.
      expect(Object.keys(row)).not.toContain('fingerprint');
    }
  });

  it('never returns staff email, because reading PII is a logged event elsewhere',
    async () => {
      const result = await send('GET', '/admin/users');
      const rows = result.body['rows'] as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(Object.keys(row)).not.toContain('email');
    });

  it('returns exactly the declared column set, no more and no fewer', async () => {
    for (const [name, resource] of Object.entries(ADMIN_RESOURCES)) {
      const result = await send('GET', `/admin/${name}`);
      expect(result.status, name).toBe(200);
      const rows = result.body['rows'] as Record<string, unknown>[];
      for (const row of rows) {
        expect(Object.keys(row).sort(), name).toEqual([...resource.columns].sort());
      }
    }
  });

  it('tells the client what is writable, so no client keeps a second copy',
    async () => {
      // Without this a form has two bad options: offer every column and have the
      // whole request refused because one is not writable, or keep its own list
      // -- a second declaration that drifts from this one.
      for (const [name, resource] of Object.entries(ADMIN_RESOURCES)) {
        const result = await send('GET', `/admin/${name}`);
        expect(result.body['editable'], name).toEqual([...resource.editable]);
        expect(result.body['creatable'], name).toEqual([...resource.creatable]);
        expect(result.body['deletes'], name).toBe(
          resource.archivedBy !== null ? 'archive'
            : resource.hardDelete ? 'remove' : 'none');
      }
    });

  it('names a delete that is a delete and an archive that is an archive', async () => {
    // 'Take out of use' and 'Delete permanently' are not interchangeable words to
    // put in front of a manager, and only the server knows which one applies.
    expect((await send('GET', '/admin/roles')).body['deletes']).toBe('remove');
    expect((await send('GET', '/admin/branches')).body['deletes']).toBe('archive');
    expect((await send('GET', '/admin/stations')).body['deletes']).toBe('none');
  });

  it('caps the page size however large a limit is asked for', async () => {
    const result = await send('GET', '/admin/users?limit=100000');
    expect(Number(result.body['limit'])).toBeLessThanOrEqual(200);
  });
});

/* ------------------------------------------------------------ scope escape --- */

describe('a branch-scoped session cannot reach another branch', () => {
  it('lists only its own branch when the token names one', async () => {
    const result = await send('GET', '/admin/stations');
    const rows = result.body['rows'] as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row['branch_id']).toBe(branchId);
  });

  it('lists every branch when the token names none, which is the admin session',
    async () => {
      // A password session carries no branch. That is a WIDER read, deliberately,
      // and it is the reason the scope is applied from the token rather than
      // being assumed present.
      const result = await send('GET', '/admin/stations', undefined, { branch_id: null });
      const rows = result.body['rows'] as Record<string, unknown>[];
      const branches = new Set(rows.map((row) => row['branch_id']));
      expect(branches.size).toBeGreaterThan(1);
    });

  it('refuses to edit another branch row by naming its id', async () => {
    const other = await owner.query<{ id: string }>(
      `SELECT id FROM app.kitchen_station WHERE tenant_id=$1 AND branch_id=$2`,
      [tenantId, otherBranchId]);
    const targetId = other.rows[0]!.id;

    const result = await send('PATCH', `/admin/stations/${targetId}`, { name: 'Hijacked' });
    // 404, and EXACTLY the answer a made-up id gets -- so it confirms nothing
    // about another branch's ids. It used to be 200 `{updated:false}`: no leak,
    // but a success status for a write that never happened.
    expect(result.status).toBe(404);
    expect(result.body['error']).toBe('row_not_found');
    const madeUp = await send('PATCH', `/admin/stations/${randomUUID()}`, { name: 'Hijacked' });
    expect({ status: madeUp.status, error: madeUp.body['error'] })
      .toEqual({ status: result.status, error: result.body['error'] });

    const after = await owner.query<{ name: string }>(
      `SELECT name FROM app.kitchen_station WHERE id=$1`, [targetId]);
    expect(after.rows[0]!.name).toBe('Curry (second)');
  });

  it('creates into the token branch, not a body-supplied one', async () => {
    // `stations` declares no creatable fields, so `branches` is the case that
    // exercises this: it is NOT branch-scoped, and a branch-scoped resource with
    // a create would take the branch from the token. Asserted structurally
    // instead, since no such resource exists yet.
    for (const [name, resource] of Object.entries(ADMIN_RESOURCES)) {
      if (resource.branchColumn === null) continue;
      expect(resource.creatable, `${name} would need the token-branch path`).not
        .toContain(resource.branchColumn);
    }
  });
});

/* ------------------------------------------------------------------ archive --- */

describe('archive is a status and never a delete', () => {
  it('sets the declared column and leaves the row in place', async () => {
    const created = await send('POST', '/admin/branches',
      { code: `A${randomUUID().slice(0, 6)}`, name: 'To archive', timezone: 'Asia/Kolkata',
        // Required. The GST question has no default answer -- see the create
        // gate below, which asserts that omitting this is refused.
        gst_registration: 'unregistered' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = String(created.body['id']);

    const archived = await send('DELETE', `/admin/branches/${id}`);
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    // Not `{ deleted: true }`: the row is still there, and a caller told
    // "deleted" would build on that.
    expect(archived.body['archived']).toBe(true);
    // 'inactive', the value branch_status_known permits -- see the note in the
    // declaration. The vocabulary is the schema's, not the CRUD layer's.
    expect(archived.body['status']).toBe('inactive');

    const row = await owner.query(`SELECT status FROM app.branch WHERE id=$1`, [id]);
    expect(row.rowCount, 'the row must still exist').toBe(1);
    expect((row.rows[0] as { status: string }).status).toBe('inactive');
  });

  it('hides an archived row from the default list', async () => {
    const result = await send('GET', '/admin/branches?limit=200');
    const rows = result.body['rows'] as Record<string, unknown>[];
    expect(rows.every((row) => row['status'] !== 'inactive')).toBe(true);
  });

  it('never declares both an archive and a hard delete', () => {
    for (const [name, resource] of Object.entries(ADMIN_RESOURCES)) {
      expect(
        resource.archivedBy !== null && resource.hardDelete,
        `${name} declares both; the handler would silently pick one`,
      ).toBe(false);
    }
  });

  it('serves DELETE only where the declaration says how, in one of two ways', () => {
    // Two legitimate meanings of DELETE, and the declaration has to pick one:
    // archive (a status) or hardDelete (the row really goes). A resource with
    // neither must have no DELETE route -- and the route table is generated from
    // the permission keys, so a mismatch is a disagreement between the two
    // tables rather than an oversight in one.
    const routes = adminRoutes({ ...adminHandlers(), ...crmHandlers() });
    for (const [name, resource] of Object.entries(ADMIN_RESOURCES)) {
      const del = routes.find((r) => r.method === 'DELETE' && r.url === `/admin/${name}/:id`);
      const declared = resource.archivedBy !== null || resource.hardDelete;
      if (declared) {
        expect(del, `${name} declares a delete, so the route must exist`).toBeDefined();
        expect(isUnserved(del!.handler), `${name} DELETE must be served`).toBe(false);
      } else {
        expect(del, `${name} declares neither, so it must have no DELETE`).toBeUndefined();
      }
    }
  });

  it('really removes a role, and is refused while a membership references it',
    async () => {
      // The ONE hard delete in this surface, and the reason it is safe is not
      // that roles are unimportant -- it is that every membership row is an
      // ON DELETE RESTRICT reference, so a role anybody holds cannot go. That
      // makes the constraint the authority and this route the request.
      const created = await send('POST', '/admin/roles',
        { key: `probe_${randomUUID().slice(0, 8)}`, name: 'Deletable' });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const id = String(created.body['id']);

      const gone = await send('DELETE', `/admin/roles/${id}`);
      expect(gone.status).toBe(200);
      expect(gone.body['deleted']).toBe(true);
      expect((await owner.query(`SELECT 1 FROM app.role WHERE id=$1`, [id])).rowCount).toBe(0);

      // And a role in use: `owner` is granted by provisioning.
      const inUse = await owner.query<{ role_id: string }>(
        `SELECT role_id FROM app.membership WHERE tenant_id=$1 LIMIT 1`, [tenantId]);
      const held = await send('DELETE', `/admin/roles/${inUse.rows[0]!.role_id}`);
      expect(held.status, 'the membership foreign key must refuse it').toBe(422);
      expect(held.body['error']).toBe('reference_invalid');
    });
});

/* ------------------------------------------------- the table and the routes --- */

/* ------------------------------------- the declaration and the schema --- */

describe('every declared column and field exists on the table', () => {
  /**
   * ###################################################################
   * A DECLARATION THAT NAMES A COLUMN THE TABLE DOES NOT HAVE IS INVISIBLE.
   *
   * `menu/items` declared `tax_class_key` and `is_combo`. The real columns are
   * `tax_class_id`, and there is no combo flag on the table at all. `pick()`
   * used `row[column] ?? null`, so both came back as null, and the admin screen
   * rendered an em-dash meaning "not set" in every row of two columns.
   *
   * Nothing failed. The list returned 200, the shape was consistent, the
   * column-allowlist test passed because it compared the response to the same
   * wrong declaration. It was found by looking at a screenshot.
   *
   * So this reads information_schema. It is the only source that knows what the
   * table actually has, and it makes the resource table checkable rather than
   * merely reviewed -- which is the standard every other declaration in this
   * repo is held to.
   * ###################################################################
   */
  async function columnsOf(table: string): Promise<Set<string>> {
    const result = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = $1`,
      [table],
    );
    return new Set(result.rows.map((row) => row.column_name));
  }

  /** The table behind each resource, read off the repository rather than guessed. */
  function tableOf(resource: AdminResource): string {
    const repo = resource.repository() as unknown as { table: string };
    const qualified = repo.table;
    return qualified.slice(qualified.indexOf('.') + 1);
  }

  it('names a real table for every resource', async () => {
    for (const [name, resource] of Object.entries(ADMIN_RESOURCES)) {
      const columns = await columnsOf(tableOf(resource));
      expect(columns.size, `${name} -> app.${tableOf(resource)}`).toBeGreaterThan(0);
    }
  });

  it('declares only columns the table has', async () => {
    const wrong: string[] = [];
    for (const [name, resource] of Object.entries(ADMIN_RESOURCES)) {
      const table = tableOf(resource);
      const columns = await columnsOf(table);
      const check = (label: string, fields: readonly string[]): void => {
        for (const field of fields) {
          if (!columns.has(field)) wrong.push(`${name}.${label}: ${field} not on app.${table}`);
        }
      };
      check('columns', resource.columns);
      check('creatable', resource.creatable);
      check('editable', resource.editable);
      check('orderBy', [resource.orderBy]);
      if (resource.branchColumn !== null) check('branchColumn', [resource.branchColumn]);
      if (resource.archivedBy !== null) {
        check('archivedBy', resource.archivedBy.map((assignment) => assignment.column));
      }
      // `createdBy` is the same hazard on the other verb: a column named here
      // that the table does not have makes every create fail with
      // `field_malformed` or `field_required`, and neither names the
      // declaration.
      if (resource.createdBy !== null) {
        check('createdBy', resource.createdBy.map((assignment) => assignment.column));
      }
    }
    expect(wrong).toEqual([]);
  });

  it('archives every column the table pairs with a status, not just the status',
    async () => {
      // The device revocation was caught by a CHECK constraint. `menu_item` has
      // an `archived_at` with no constraint tying it to `status`, so nothing
      // would have complained about setting one and not the other -- a row
      // reading `archived` with a null archived_at, forever.
      const missed: string[] = [];
      for (const [name, resource] of Object.entries(ADMIN_RESOURCES)) {
        if (resource.archivedBy === null) continue;
        const columns = await columnsOf(tableOf(resource));
        const written = new Set(resource.archivedBy.map((assignment) => assignment.column));
        for (const paired of ['archived_at', 'revoked_at']) {
          if (columns.has(paired) && !written.has(paired)) {
            missed.push(`${name}: the table has ${paired} and the archive does not set it`);
          }
        }
      }
      expect(missed).toEqual([]);
    });

  it('would catch the declaration that caused this test to exist', async () => {
    // THE SYNTHETIC VIOLATION: the exact two column names that were wrong.
    const columns = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'menu_item'`);
    const real = new Set(columns.rows.map((row) => row.column_name));
    expect(real.has('tax_class_key'), 'the name the declaration used').toBe(false);
    expect(real.has('is_combo'), 'the other name it used').toBe(false);
    // And the corrected ones are real, so the fix is not the same mistake twice.
    expect(real.has('tax_class_id')).toBe(true);
    expect(real.has('archived_at')).toBe(true);
  });

  it('declares a value shape the column can hold, for the states it writes',
    async () => {
      // Every status value an archive writes has to satisfy the table's own
      // CHECK. `branch_status_known` permits active/inactive and this table once
      // said 'archived'; the constraint refused it at runtime, which is the
      // latest possible moment to find out.
      for (const [name, resource] of Object.entries(ADMIN_RESOURCES)) {
        if (resource.archivedBy === null) continue;
        const table = tableOf(resource);
        const constraint = await owner.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid = $1::regclass AND contype = 'c' AND conname LIKE '%status%'`,
          [`app.${table}`],
        );
        const def = constraint.rows[0]?.def;
        if (def === undefined) continue;
        for (const assignment of resource.archivedBy) {
          if (assignment.column !== 'status') continue;
          expect(
            def.includes(`'${String(assignment.value)}'`),
            `${name} archives to "${String(assignment.value)}" but ${table} permits ${def}`,
          ).toBe(true);
        }
      }
    });
});

describe('the declaration and the route table agree', () => {
  it('serves a handler for every generated route whose verb the declaration supports',
    () => {
      const routes = adminRoutes({ ...adminHandlers(), ...crmHandlers() });
      const missing: string[] = [];
      for (const [name, resource] of Object.entries(ADMIN_RESOURCES)) {
        const want: [string, string, boolean][] = [
          ['GET', `/admin/${name}`, true],
          ['POST', `/admin/${name}`, resource.creatable.length > 0],
          ['PATCH', `/admin/${name}/:id`, resource.editable.length > 0],
          ['DELETE', `/admin/${name}/:id`, resource.archivedBy !== null],
        ];
        for (const [method, url, expected] of want) {
          const route = routes.find((r) => r.method === method && r.url === url);
          if (!expected) continue;
          if (!route) { missing.push(`${method} ${url} (declared but not routed)`); continue; }
          if (isUnserved(route.handler)) missing.push(`${method} ${url} (routed but unserved)`);
        }
      }
      expect(missing).toEqual([]);
    });

  it('names every handler it supplies after a resource in the table', () => {
    // The ADMIN map alone, deliberately. Three handlers belong to no resource --
    // the loyalty programme, which is one row per tenant with no id or list, and
    // the staff PII reveal -- and they live in `crmHandlers()` for exactly this
    // reason. See the note at the top of src/routes/handlers/crm.ts.
    const names = Object.keys(adminHandlers());
    expect(names.length).toBeGreaterThan(15);
    for (const name of names) {
      const resource = name.slice(0, name.lastIndexOf('.'));
      expect(Object.keys(ADMIN_RESOURCES), name).toContain(resource);
    }
  });

  it('tags each generated handler with the name the route looked it up under', () => {
    // The correspondence gate reads this tag. A generated handler that lost it
    // would be invisible to the gate rather than reported.
    for (const route of adminRoutes({ ...adminHandlers(), ...crmHandlers() })) {
      if (isUnserved(route.handler)) continue;
      expect(handlerName(route.handler), route.url).not.toBeNull();
    }
  });
});

/* ----------------------------------------------- the synthetic violation --- */

describe('the writable-field check is not vacuous', () => {
  it('refuses a field absent from the permitted list', () => {
    expect(() => writableOnly('probe', { status: 'active' }, ['name']))
      .toThrow(UnwritableFieldsError);
  });

  it('passes a permitted field through unchanged', () => {
    expect(writableOnly('probe', { name: 'ok' }, ['name', 'other'])).toEqual({ name: 'ok' });
  });

  it('omits a permitted field the body did not send, rather than nulling it', () => {
    // A PATCH sets what it names. Filling absent columns with null would make
    // every edit a full replace, which is how a partial update erases a field.
    expect(writableOnly('probe', { name: 'ok' }, ['name', 'timezone'])).toEqual({ name: 'ok' });
  });
});

/* ------------------------------------- the three Phase 4 resources --- */

describe('a purpose-built verb is declared, not inferred', () => {
  it('has no resource that adds a till or a person through the generic layer', () => {
    // A till becomes a device at a manager's sign-in, and staff are the Sales
    // person's: neither may gain a generic create by accident.
    expect(ADMIN_RESOURCES['devices']!.creatable).toEqual([]);
    expect(ADMIN_RESOURCES['users']!.creatable).toEqual([]);
    expect(ADMIN_RESOURCES['users']!.editable).toEqual([]);
    expect(ADMIN_RESOURCES['users']!.archivedBy).toBeNull();
  });

  it('never generates a verb it declares purpose-built', () => {
    // Both directions, because the failure is silent in each: a generated
    // handler would shadow the hand-written one under the same name, and
    // `mergeHandlers` only catches that across two MAPS, not within one.
    for (const [name, resource] of Object.entries(ADMIN_RESOURCES)) {
      for (const verb of resource.purposeBuilt) {
        if (verb === 'create') {
          expect(resource.creatable, `${name}.create is purpose-built`).toEqual([]);
        }
        if (verb === 'edit') {
          expect(resource.editable, `${name}.edit is purpose-built`).toEqual([]);
        }
        if (verb === 'archive') {
          expect(resource.archivedBy, `${name}.archive is purpose-built`).toBeNull();
          expect(resource.hardDelete, `${name}.archive is purpose-built`).toBe(false);
        }
      }
    }
  });

  it('leaves every purpose-built verb served by some map', async () => {
    // The correspondence gate proper lives in thinHandlers.test.ts and reads the
    // whole route table. This is the narrower claim: a verb declared
    // purpose-built must actually be built, or the declaration is just a note
    // saying nobody did it.
    const { staffHandlers } = await import('../../src/routes/handlers/staff.js');
    const { setupHandlers } = await import('../../src/routes/handlers/setup.js');
    const supplied = new Set([
      ...Object.keys(adminHandlers()),
      ...Object.keys(staffHandlers()),
      ...Object.keys(setupHandlers()),
    ]);
    const missing: string[] = [];
    for (const [name, resource] of Object.entries(ADMIN_RESOURCES)) {
      for (const verb of resource.purposeBuilt) {
        if (!supplied.has(`${name}.${verb}`)) missing.push(`${name}.${verb}`);
      }
    }
    expect(missing, 'declared purpose-built and built by nobody').toEqual([]);
  });
});
