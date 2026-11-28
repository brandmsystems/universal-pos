import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { signToken } from '../../src/modules/authentication/jwt.js';
import { planeGuard } from '../../src/middleware/security/planeGuards.js';
import { registerTenantRoute, resetRegistry } from '../../src/middleware/routeRegistry.js';
import { toErrorResponse } from '../../src/utils/errors/errors.js';
import { adminRoutes } from '../../src/routes/index.js';
import { posRoutes } from '../../src/routes/pos.js';
import { adminHandlers } from '../../src/routes/handlers/admin.js';
import { posHandlers } from '../../src/routes/handlers/pos.js';
import { isUnserved, mergeHandlers } from '../../src/routes/lookup.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';
import { planCache } from '../helpers/plans.js';
import { setupHandlers } from '../../src/routes/handlers/setup.js';

/**
 * The tax surface, over HTTP.
 *
 * ###########################################################################
 * THE FIRST TEST IN THIS FILE IS THE ONE THAT MATTERS.
 *
 * `app.menu_item.tax_class_id` is NOT NULL with a foreign key to
 * `app.tax_class`. Before migration 0050 `provisionTenant` created no tax class
 * and no route could create one, so A REAL TENANT COULD NOT ADD A SINGLE DISH:
 * the create form asked for a tax class id, there was nothing to put in it, and
 * no route listed the options.
 *
 * It was invisible because `seed-demo.mts` inserted a class directly with an
 * owner connection and every test fixture did the same. 3,582 of the 3,975
 * tenants in the dev install had no tax class AND no menu item, which is what
 * that gap looks like from outside.
 *
 * So this file provisions a tenant THROUGH THE PROVISIONING PATH and then adds
 * a dish using only what a caller can see. Nothing is inserted by hand.
 * ###########################################################################
 */
const KEY = 'tax-surface-signing-key';

let owner: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let tenantId: string, branchId: string, userId: string;

function token(as: string, overrides: Record<string, unknown> = {}): string {
  return signToken(
    { sub: as, tenant_id: tenantId, exp: Math.floor(Date.now() / 1000) + 600, ...overrides },
    KEY,
  );
}

async function send(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
  as: string = userId,
  overrides: Record<string, unknown> = {},
  leaseToken?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method, url: `/api/t${url}`,
    headers: {
      authorization: `Bearer ${token(as, overrides)}`,
      ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
      ...(leaseToken === undefined ? {} : { 'x-lease-token': leaseToken }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function userWith(label: string, keys: readonly string[]): Promise<string> {
  const id = randomUUID(); const roleId = randomUUID();
  await owner.query(
    `INSERT INTO app.app_user (id,tenant_id,full_name,employee_code,status)
     VALUES ($1,$2,$3,$4,'active')`,
    [id, tenantId, label, `${label.slice(0, 3)}-${id.slice(0, 8)}`]);
  await owner.query(
    `INSERT INTO app.role (id,tenant_id,key,name,assignable_scope)
     VALUES ($1,$2,$3,$3,'any')`, [roleId, tenantId, `r_${label}_${id.slice(0, 8)}`]);
  for (const key of keys) {
    await owner.query(
      `INSERT INTO app.role_permission (tenant_id,role_id,permission_key) VALUES ($1,$2,$3)`,
      [tenantId, roleId, key]);
  }
  // Tenant-wide, because these tokens carry no branch: a branch-scoped
  // membership resolves no authority for a branch-less session.
  await owner.query(
    `INSERT INTO app.membership (id,tenant_id,user_id,branch_id,role_id,role_assignable_scope)
     VALUES ($1,$2,$3,NULL,$4,'any')`,
    [randomUUID(), tenantId, id, roleId]);
  return id;
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
    [superAdminId, `tax+${superAdminId}@p.test`, roleId]);
  await owner.query(`INSERT INTO platform.plan (id,key,name) VALUES ($1,'tax_plan','Tax')
    ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
  const planId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan WHERE key='tax_plan'`)).rows[0]!.id;
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
    const key = `tax-${randomUUID()}`;
    const r = await provisionTenant(client, {
      idempotencyKey: key, slug: `x${key.slice(4, 12)}`, name: 'Tax Probe',
      currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: `${key}@x.test`,
      ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
      taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId });
    await client.query('COMMIT');
    tenantId = r.tenantId; branchId = r.firstBranchId; userId = r.ownerUserId;
  } finally { client.release(); }
  await owner.query(`UPDATE app.app_user SET status='active' WHERE id=$1`, [userId]);
  // The branch trades in Karnataka. Stated here because provisioning cannot
  // know it -- and a branch with no state code stamps `unstated` on every taxed
  // bill, which the return then refuses.
  await owner.query(`UPDATE app.branch SET state_code='29' WHERE id=$1`, [branchId]);
  await owner.query(
    `INSERT INTO app.station_code (tenant_id,code,name) VALUES ($1,'grill','Grill')
     ON CONFLICT DO NOTHING`, [tenantId]);
  // The branch's own Grill: an item is put on sale only where its kitchen exists.
  await owner.query(
    `INSERT INTO app.kitchen_station (id,tenant_id,branch_id,code,name) VALUES ($1,$2,$3,'grill','Grill')
     ON CONFLICT DO NOTHING`, [randomUUID(), tenantId, branchId]);

  resetRegistry();
  app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const { status, body } = toErrorResponse(error);
    void reply.code(status).send(body);
  });
  const handlers = mergeHandlers(adminHandlers(), posHandlers(), setupHandlers());
  app.register(async (scope) => {
    scope.addHook('onRequest', planeGuard('tenant', KEY));
    for (const route of [...adminRoutes(handlers), ...posRoutes(handlers)]) {
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

describe('a tenant provisioned through the product can price a dish', () => {
  it('is handed the three standard rates without asking for them', async () => {
    const list = await send('GET', '/admin/tax-classes');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const rows = list.body['rows'] as { key: string; rate_bps: number }[];
    expect(rows.map((r) => r.key).sort())
      .toEqual(['gst_0', 'gst_18', 'gst_5']);
    // Every SEEDED rate is even, because India's are. Not a rule any more --
    // 0052 deleted `tax_class_rate_halves` so a tenant in a jurisdiction with
    // an odd combined rate can enter one. This asserts what was seeded, not
    // what is permitted.
    for (const row of rows) expect(row.rate_bps % 2).toBe(0);
  });

  it('adds a menu item using ONLY what a caller can see', async () => {
    // ###################################################################
    // THE ASSERTION THE WHOLE PHASE EXISTS FOR.
    //
    // No hand-inserted tax class. The id comes from the list route, which is
    // the only thing a real client has -- and before 0050 the list would have
    // been empty and this call would have had nothing to send.
    // ###################################################################
    const list = await send('GET', '/admin/tax-classes');
    const rows = list.body['rows'] as { id: string; key: string }[];
    const five = rows.find((r) => r.key === 'gst_5')!;

    const created = await send('POST', `/admin/menu/items?branchId=${branchId}`, {
      name: `Masala Dosa ${randomUUID().slice(0, 6)}`, kind: 'single',
      priceMinor: 12000, taxClassId: five.id, kitchenCode: 'grill',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
  });

  it('ACCEPTS an odd rate now, which is what one product for the world costs', async () => {
    // ###################################################################
    // THIS ASSERTION IS THE REVERSE OF THE ONE IT REPLACED.
    //
    // It used to expect 422 for 501bps, on the reasoning that CGST and SGST are
    // exactly half each so a rate must be even. Correct for India and refusing
    // for everyone else: California's combined rate is 7.25% -- 725bps, odd,
    // and perfectly lawful -- so a restaurant there could not have entered its
    // own rate at all. Migration 0052 deleted `tax_class_rate_halves` and made
    // a head a SHARE of the rate, allocated by largest remainder, which is
    // exact for any rate and any number of heads.
    //
    // Rolled back at the end: a surviving odd rate is permanent, because
    // 0052's DOWN migration cannot re-add the constraint while one exists.
    // ###################################################################
    const result = await send('POST', '/admin/tax-classes', {
      key: `odd_${randomUUID().slice(0, 6)}`, name: 'Combined 7.25%', rate_bps: 725,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body['rate_bps']).toBe(725);
    await owner.query(
      `DELETE FROM app.tax_class WHERE tenant_id=$1 AND id=$2`,
      [tenantId, result.body['id']]);
  });

  it('edits a rate, which is safe because an order line snapshots it', async () => {
    const created = await send('POST', '/admin/tax-classes', {
      key: `cess_${randomUUID().slice(0, 6)}`, name: 'Cess 2%', rate_bps: 200,
    });
    const id = created.body['id'] as string;
    const edited = await send('PATCH', `/admin/tax-classes/${id}`, { rate_bps: 400 });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body['rate_bps']).toBe(400);
  });

  it('archives one without disturbing the dishes already priced under it', async () => {
    const created = await send('POST', '/admin/tax-classes', {
      key: `old_${randomUUID().slice(0, 6)}`, name: 'Old 12%', rate_bps: 1200,
    });
    const id = created.body['id'] as string;
    const itemKey = `legacy_${randomUUID().slice(0, 8)}`;
    const item = await send('POST', `/admin/menu/items?branchId=${branchId}`, {
      name: `Legacy Dish ${itemKey}`, kind: 'single',
      priceMinor: 9000, taxClassId: id, kitchenCode: 'grill',
    });
    expect(item.status, JSON.stringify(item.body)).toBe(200);

    // Permitted, and deliberately so: the row stays resolvable, so the dish
    // keeps its rate and the class simply stops being offered for new ones.
    // A refusal here would be inventing a rule archive does not have anywhere
    // else in ADMIN_RESOURCES.
    const archived = await send('DELETE', `/admin/tax-classes/${id}`);
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);

    const still = (await owner.query<{ tax_class_id: string }>(
      `SELECT tax_class_id FROM app.menu_item WHERE tenant_id=$1 AND id=$2`,
      [tenantId, item.body['id']])).rows[0]!;
    expect(still.tax_class_id).toBe(id);

    const list = await send('GET', '/admin/tax-classes');
    expect((list.body['rows'] as { id: string }[]).map((r) => r.id)).not.toContain(id);
  });

  it('shows what each rate prints as -- CGST + SGST within the state, IGST across -- derived, never stated', async () => {
    const list = await send('GET', '/admin/tax-classes');
    const gst5 = (list.body['rows'] as { id: string; key: string }[]).find((r) => r.key === 'gst_5')!;
    const exempt = (list.body['rows'] as { id: string; key: string }[]).find((r) => r.key === 'gst_0')!;
    const res = await send('GET', '/admin/tax-splits');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body['jurisdiction']).toBe('IN');
    type Split = { taxClassId: string; rateBps: number; treatments: { key: string; heads: { name: string; rateBps: number }[] }[] };
    const rows = res.body['rows'] as Split[];
    expect(rows.find((r) => r.taxClassId === gst5.id)).toEqual({
      taxClassId: gst5.id, rateBps: 500,
      treatments: [
        { key: 'intra_state', name: 'Intra-state supply', heads: [{ name: 'CGST', rateBps: 250 }, { name: 'SGST', rateBps: 250 }] },
        { key: 'inter_state', name: 'Inter-state supply', heads: [{ name: 'IGST', rateBps: 500 }] },
      ],
    });
    // Exempt has nothing to split.
    expect(rows.find((r) => r.taxClassId === exempt.id)!.treatments).toEqual([]);

    // A rate edit is what the split follows: no second copy of it to update.
    const created = await send('POST', '/admin/tax-classes', {
      key: `split_${randomUUID().slice(0, 6)}`, name: 'Split check', rate_bps: 1200 });
    const id = created.body['id'] as string;
    const twelve = ((await send('GET', '/admin/tax-splits')).body['rows'] as Split[]).find((r) => r.taxClassId === id)!;
    expect(twelve.treatments[0]!.heads).toEqual([{ name: 'CGST', rateBps: 600 }, { name: 'SGST', rateBps: 600 }]);
    await send('PATCH', `/admin/tax-classes/${id}`, { rate_bps: 1800 });
    const eighteen = ((await send('GET', '/admin/tax-splits')).body['rows'] as Split[]).find((r) => r.taxClassId === id)!;
    expect(eighteen.treatments.map((t) => t.heads)).toEqual([
      [{ name: 'CGST', rateBps: 900 }, { name: 'SGST', rateBps: 900 }], [{ name: 'IGST', rateBps: 1800 }]]);
    // An archived rate is not offered, so its split is not either.
    await send('DELETE', `/admin/tax-classes/${id}`);
    expect(((await send('GET', '/admin/tax-splits')).body['rows'] as Split[]).some((r) => r.taxClassId === id)).toBe(false);
  });

  it('the split read needs only tax.class.view, and nothing writes through it', async () => {
    const viewer = await userWith('splitviewer', ['tax.class.view']);
    expect((await send('GET', '/admin/tax-splits', undefined, viewer)).status).toBe(200);
    const nobody = await userWith('nosplit', ['menu.view']);
    expect((await send('GET', '/admin/tax-splits', undefined, nobody)).status).toBe(403);
  });

  it('separates reading a rate from setting one', async () => {
    // `tax.class.view` is plain; create/edit/archive are financial-configuration,
    // the same class as menu.price.edit, because they change what every future
    // bill charges.
    const viewer = await userWith('viewer', ['tax.class.view']);
    expect((await send('GET', '/admin/tax-classes', undefined, viewer)).status).toBe(200);
    const denied = await send('POST', '/admin/tax-classes',
      { key: `sneak_${randomUUID().slice(0, 6)}`, name: 'Sneak', rate_bps: 200 }, viewer);
    expect(denied.status).toBe(403);
  });
});
