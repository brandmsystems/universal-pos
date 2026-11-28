import { beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import { assertCheckedSet } from '../helpers/db.js';
import { planCache } from '../helpers/plans.js';
import {
  registerTenantRoute, registeredRoutes, resetRegistry,
  MissingAuditPostureError, PublicRouteRefusedError,
  PUBLIC_PATH_PREFIXES, MUTATING_METHODS,
  type RouteDefinition,
} from '../../src/middleware/routeRegistry.js';
import {
  allRoutes, KEYS_WITHOUT_ROUTES, PLATFORM_KEYS_WITHOUT_ROUTES,
} from '../../src/routes/index.js';
import { posRoutes } from '../../src/routes/pos.js';
import { PERMISSIONS, type PermissionKey } from '../../src/modules/authz/permissions.js';
import { PLATFORM_PERMISSION_KEYS } from '../../src/modules/authz/platformPermissions.js';
import { ERROR_CONTRACT, toErrorResponse } from '../../src/utils/errors/errors.js';

/**
 * Raise DELIBERATELY as routes land. An exact count, not a floor: a floor of
 * zero is vacuous, and this file passed over an empty registry before Phase 7.
 *
 * 92 -> 94: DELETE /pos/session/:id and PATCH /pos/session/:id/table. Both
 * handlers (`closeSession`, `moveSession`) were already implemented and had no
 * route at all -- found by the handler-to-route correspondence assertion in
 * tests/http/thinHandlers.test.ts, which had been vacuous because it read a
 * `_name` marker that was set nowhere.
 *
 * 106 -> 120: the customer surface. `customer.view`, `customer.create` and
 * `customer.edit` had been in the catalogue since migration 0004 with nothing
 * behind them, and `GET /admin/customers/:id/contact` revealed STAFF records
 * because no customer table existed. Fourteen routes: the generated customer
 * CRUD (list, create, edit), the profile read, consent at the till and in
 * admin, a points adjustment, erasure, the loyalty programme read and write,
 * the till's lookup / attach / redeem, and a staff PII reveal on its own key.
 *
 * 104 -> 106: POST and GET /admin/branches/:id/gst-registration. Deliberately
 * not fields on the generated branch PATCH: the write can be REFUSED (a branch
 * mid-service would take new lines at the new rate and bill two positions on
 * one document), it has to leave a row a GST return can read, and it sits
 * behind `branch.gst.state` rather than `branch.edit` because it decides
 * whether diners are charged tax at all.
 *
 * 120 -> 127: the tax surface. Four generated routes for `tax-classes`
 * (list, create, edit, archive) plus GET and POST /admin/tax-settings and
 * POST /pos/bill/:id/recipient.
 *
 * The four are the ones worth pausing on. `app.menu_item.tax_class_id` is NOT
 * NULL with a foreign key and until migration 0050 NOTHING created a tax class
 * -- not a route, not `provisionTenant`. So a tenant provisioned through the
 * product could not add a single dish: the create form asked for an id, there
 * was nothing to put in it, and no route listed the options. 3,582 of the 3,975
 * tenants in the dev install had no tax class and no menu item, which is what
 * that looks like from the outside.
 *
 * The other two exist because the B2B half of the outward-supply return has
 * been dead since 0039: `bill.recipient_gstin` and `recipient_legal_name` had
 * no write path at all, so the section always returned an empty list. It is
 * behind a per-tenant setting, off by default, so a till that never issues a
 * GST bill to a company never shows the field.
 */
// 131 -> 133: GET/POST /users, so a Super Admin can onboard platform staff
// through a route instead of shell access to the database.
// 133 -> 140: restaurant management -- edit, deactivate and reactivate a
// tenant; list Sales Persons with their book; edit and switch platform staff
// on/off; publish a plan version. Three of the seven serve keys that had sat in
// PLATFORM_KEYS_WITHOUT_ROUTES since phase 1.
// 140 -> 145: the Restaurant Manager's setup link (issued on the control
// plane, redeemed on the public one), a staff password reset, plan
// active/inactive, and subscription renewal. Before this, no restaurant
// provisioned from the console could ever sign in.
// 145 -> 147: GET /api/platform/me (who am I, for the console header) and
// POST /api/auth/platform/password (change your own password, verified like a login).
// 147 -> 149: the restaurant's own page -- GET /api/public/restaurants/:slug
// (its name for `/{slug}`) and GET /api/platform/tenants/slug-available.
// 157 -> 158: GET /pos/order/:id/tickets -- the KOT screen's kitchen tickets and
// their print status, read from the print jobs fire already writes.
// 158 -> 159: GET /api/t/me -- who is signed in, for the header badge on every screen.
// 159 -> 161: POST /admin/setup/import/preview and POST /admin/setup/import -- the
// restaurant set up from one Excel file.
// 161 -> 162: POST /pos/kot/:id/ready -- in a restaurant without a kitchen screen,
// KOT says when a ticket's food is ready.
// 162 -> 164: GET /admin/sessions/open and POST /admin/sessions/:id/cancel -- every
// open order from any day, and cancelling one nobody will pay for (0068).
// 164 -> 165: POST /pos/bill/:id/print -- the printed bill and receipt, each copy
// counted (0069).
// 168 -> 170 (0075, 0076): POST /pos/dine-in and GET /pos/dine-ins -- dine-in numbered
// at the counter where the plan has no tables; POST /api/auth/:tenantSlug/till -- the
// POS half of the one login page, which replaced POST /admin/till and its sign-back-in
// route; POST /admin/staff/accounts -- the manager creates a username + password.
// 157 -> 158: GET /admin/tax-splits -- what each tax rate prints as (CGST + SGST,
// IGST), derived from the jurisdiction catalogue, read only.
// 158 -> 160: POST /pos/order/:id/parcel-charge -- a parcel's packing charge, capped
// by the branch (0081); POST /pos/quote -- the order screen's estimate, a read.
// 160 -> 161: GET /pos/my-takings -- the till's own X-read (till.summary.view).
// 161 -> 162: POST /admin/branches/:id/tax -- how a branch charges tax (0083), on
// tax.setting.edit; not generic PATCH fields, for the gst-registration route's reason.
// 162 -> 166: country and currency (0084) -- GET /countries, PATCH
// /settings/countries (platform.settings.edit), and a restaurant's
// GET /tenants/:id/country-change preview and POST /tenants/:id/country.
// 166 -> 171: the local print agent (0085) -- GET/POST /admin/print-agents and
// DELETE /admin/print-agents/:id; POST /admin/printers/:id/test-print; and the
// agent's own POST /api/agent/poll, on the fourth plane.
// 171 -> 184: bill history, bill edits and day end (0086) -- on the till GET
// /pos/bills, GET /pos/bills/:id, POST /pos/bills/:id/revise(/preview), GET
// /pos/day and POST /pos/day/submit; on the manager screens GET /admin/bills,
// GET /admin/bills/:id, POST /admin/bills/:id/print, POST
// /admin/bills/:id/revise(/preview), POST /admin/days/:date/submit and /reopen.
// 184 -> 186: Allow POS Bill Editing (0087) -- POST
// /admin/days/:date/pos-editing/enable and /disable.
// 186 -> 187: GET /api/public/restaurants/:tenantSlug/manifest -- the installable
// POS app's manifest, public like the lookup.
const EXPECTED_ROUTE_COUNT = 187;

const pool = { } as pg.Pool;
const noop: RouteDefinition['handler'] = async () => ({ ok: true });

function register(definition: Partial<RouteDefinition>): void {
  const app = Fastify();
  registerTenantRoute(app, { pool }, {
    method: 'GET', url: '/probe', plane: 'tenant', audit: 'none', handler: noop,
    ...definition,
  } as RouteDefinition);
}

beforeEach(() => { resetRegistry(); });

/* ------------------------------------------- the registrar, proven --- */

describe('the registrar refuses what it claims to', () => {
  it('refuses a route with no audit posture', () => {
    expect(() => register({ audit: undefined as never }))
      .toThrow(MissingAuditPostureError);
    // 'none' is fine and greppable; SILENCE is what fails.
    expect(() => register({ audit: 'none' })).not.toThrow();
  });

  it('refuses a public route outside the declared prefixes', () => {
    expect(() => register({ plane: 'public', url: '/api/t/pos/menu' }))
      .toThrow(PublicRouteRefusedError);
    expect(() => register({ plane: 'public', url: '/healthz' })).not.toThrow();
  });

  it('refuses a public MUTATION outside /api/auth/', () => {
    // A public read is a health check. A public write anywhere else is an
    // unauthenticated mutation, which is never what anyone meant.
    expect(() => register({ plane: 'public', method: 'POST', url: '/healthz' }))
      .toThrow(/mutates outside \/api\/auth\//);
    expect(() => register({ plane: 'public', method: 'POST', url: '/api/auth/login' }))
      .not.toThrow();
  });

  it('names every public prefix, so the third one cannot be added quietly', () => {
    assertCheckedSet({
      label: 'public path prefixes',
      checked: [...PUBLIC_PATH_PREFIXES],
      minimum: 3,
      mustInclude: ['/api/auth/', '/healthz', '/api/public/'],
    });
    // Three. The third, /api/public/, was decided for the restaurant's own page
    // (`/{slug}` needs the name before anyone signs in); it holds READS only --
    // the test above proves a public write outside /api/auth/ is refused. A
    // fourth is a decision, and this is where it gets made.
    expect(PUBLIC_PATH_PREFIXES).toHaveLength(3);
    expect(MUTATING_METHODS).toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);
  });
});

/* --------------------------------------------------- the inventory --- */

describe('the route inventory', () => {
  const routes = allRoutes();

  it('holds an EXACT count, so a new route cannot land unexamined', () => {
    expect(
      routes.length,
      `the inventory has ${routes.length} routes but EXPECTED_ROUTE_COUNT is ` +
        `${EXPECTED_ROUTE_COUNT}. Raise it deliberately.`,
    ).toBe(EXPECTED_ROUTE_COUNT);
  });

  it('declares a plane for every route, and only public ones are unguarded', () => {
    const planes = new Set(routes.map((r) => r.plane));
    expect([...planes].sort()).toEqual(['agent', 'platform', 'public', 'tenant']);

    for (const route of routes.filter((r) => r.plane === 'public')) {
      expect(PUBLIC_PATH_PREFIXES.some((p) => route.url.startsWith(p)), route.url).toBe(true);
    }
    // The agent plane holds no JWT and no permission: its bearer is the agent's
    // own token, checked on every request (agentRoute.ts). One route, by name.
    expect(routes.filter((r) => r.plane === 'agent').map((r) => `${r.method} ${r.url}`)).toEqual(['POST /api/agent/poll']);
  });

  it('gives every route a real permission key, or none at all deliberately', () => {
    const tenantKeys = new Set(PERMISSIONS.map((p) => p.key as string));
    const platformKeys = new Set(PLATFORM_PERMISSION_KEYS as readonly string[]);

    const invented = routes
      .flatMap((r) => (r.permission ? [r.permission] : []))
      .filter((p) => !(p.plane === 'tenant' ? tenantKeys : platformKeys).has(p.key))
      .map((p) => `${p.plane}:${p.key}`);
    expect(invented, 'a route guarded by a key nobody defined is unguarded').toEqual([]);

    // The union makes a mismatch a COMPILE error; this is the runtime half.
    const mismatched = routes.filter(
      (r) => r.permission !== undefined && r.permission.plane !== r.plane);
    expect(mismatched.map((r) => r.url)).toEqual([]);

    // Only PUBLIC and AGENT routes may carry no key (the agent's is its token). Platform routes are guarded by a
    // platform key, not merely by holding some platform_role -- read_only
    // reaching POST /impersonation was a live escalation.
    const unguarded = routes.filter(
      (r) => r.plane !== 'public' && r.plane !== 'agent' && r.permission === undefined);
    expect(
      unguarded.map((r) => `${r.method} ${r.url}`),
      'a route on either plane without a key is guarded only by having any token',
    ).toEqual([]);
  });

  it('audits every mutation, and declares `none` explicitly on reads', () => {
    const mutations = routes.filter((r) => MUTATING_METHODS.includes(r.method));
    const unaudited = mutations.filter((r) => r.audit === 'none');

    // Four deliberate exceptions: three are lease churn, one is a read.
    //
    // The lease claim/release pair: lease churn is constant and the lease ROW is
    // already the record, with its own one-way stamps.
    //
    // Billing's claim on a handed-over session is the same kind of lease
    // churn, under its own key.
    //
    // The order screen's estimate is a POST only because a cart does not fit a
    // query string; it writes nothing (POS_POST_READS).
    //
    // The print agent's poll: what it does is recorded on the print_job rows it
    // moves, as the server worker's is; agentRoute.ts refuses an audit posture.
    //
    // Everything else that mutates is audited.
    expect(unaudited.map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      'DELETE /pos/session/:id/lease',
      'POST /api/agent/poll',
      'POST /pos/quote',
      'POST /pos/session/:id/billing-lease',
      'POST /pos/session/:id/lease',
    ]);
  });
});

/* ---------------------------------------- coverage, both directions --- */

describe('no route without a key, no key without a route', () => {
  const routes = allRoutes();
  const routed = new Set(
    routes.flatMap((r) => (r.permission?.plane === 'tenant' ? [r.permission.key as string] : [])));
  const routedPlatform = new Set(
    routes.flatMap((r) => (r.permission?.plane === 'platform' ? [r.permission.key as string] : [])));
  const catalogue = PERMISSIONS.map((p) => p.key as string);

  it('routes a substantial share of the catalogue', () => {
    assertCheckedSet({
      label: 'routed permission keys',
      checked: [...routed],
      minimum: 45,
      mustInclude: ['kot.fire', 'payment.collect', 'order.void', 'bill.generate',
                    'report.exception.view', 'order.handover',
                    'table.session.lease.force_release', 'payment.settle.manual'],
    });
  });

  it('accounts for EVERY key: routed, or on the shrinking not-yet list', () => {
    const unaccounted = catalogue.filter(
      (k) => !routed.has(k) && !KEYS_WITHOUT_ROUTES.includes(k));
    expect(
      unaccounted,
      'a key with no route and no entry on the not-yet list is a capability an ' +
        'admin can grant that does nothing',
    ).toEqual([]);
  });

  it('keeps the not-yet list HONEST: nothing on it may already have a route', () => {
    // THE RATCHET. An entry leaving the list is progress; an entry that stays
    // while a route appears would turn the list into a permanent excuse.
    const stale = KEYS_WITHOUT_ROUTES.filter((k) => routed.has(k));
    expect(
      stale,
      'these keys have routes and must be removed from KEYS_WITHOUT_ROUTES',
    ).toEqual([]);

    // And nothing invented may hide on it either.
    const catalogueSet = new Set(catalogue);
    expect(KEYS_WITHOUT_ROUTES.filter((k) => !catalogueSet.has(k))).toEqual([]);
  });

  it('ratchets the PLATFORM catalogue too, not only the tenant one', () => {
    assertCheckedSet({
      label: 'routed platform keys',
      checked: [...routedPlatform],
      minimum: 8,
      mustInclude: ['platform.impersonation.start', 'platform.tenant.provision',
                    'platform.subscription.change'],
    });
    const unaccounted = (PLATFORM_PERMISSION_KEYS as readonly string[]).filter(
      (k) => !routedPlatform.has(k) && !PLATFORM_KEYS_WITHOUT_ROUTES.includes(k));
    expect(unaccounted).toEqual([]);

    const stale = PLATFORM_KEYS_WITHOUT_ROUTES.filter((k) => routedPlatform.has(k));
    expect(stale, 'these platform keys have routes and must leave the list').toEqual([]);
  });

  it('shrinks toward empty', () => {
    // Recorded so the direction is visible in a diff. Lower is better; this
    // number must never rise without a stated reason. It rose from 35 to 55
    // with migration 0064: 33 keys retired with stock, suppliers, recipes,
    // customers and GST registration (see the RETIRED block on the list), less
    // order.reopen and bill.view, which gained routes. 55 -> 65 with 0077
    // (Basic only): the kitchen screen, setup codes and the manager's staff
    // management retired ten keys.
    expect(KEYS_WITHOUT_ROUTES.length).toBeLessThanOrEqual(65);
    expect(PLATFORM_KEYS_WITHOUT_ROUTES.length).toBeLessThanOrEqual(22);
  });
  it('declares every escalated key on the ROUTE, and never in a handler', () => {
    // The countable form of the rule. `platform.impersonation.write` is a real
    // permission that is not the base key of any route, so before `escalation`
    // existed it could only have been enforced inside a handler -- which is
    // where it was. This asserts it is declared, and that nothing else has
    // quietly gone back to doing it the old way.
    const escalations = allRoutes({}).flatMap((route) =>
      route.escalation === undefined ? [] : [{
        route: `${route.method} ${route.url}`,
        key: route.escalation.key,
        refusal: route.escalation.refusal,
      }]);
    expect(escalations).toEqual([{
      route: 'POST /impersonation',
      key: 'platform.impersonation.write',
      refusal: 'impersonation_write_not_permitted',
    }]);
    // And its refusal is in the contract, so it answers with a sentence.
    expect(Object.keys(ERROR_CONTRACT)).toContain('impersonation_write_not_permitted');
  });

});

/* ----------------------------------------------------- the POS lease --- */

describe('an escalated key is declared, not checked in a handler', () => {
  it('declares the only one there is, with its refusal', () => {
    // The countable form of the rule. `platform.impersonation.write` is a real
    // permission that is the base key of no route, so before `escalation`
    // existed it could only have been enforced inside a handler -- which is
    // where it was, as the one authorisation decision no registrar made.
    const escalations = allRoutes({}).flatMap((route) =>
      route.escalation === undefined ? [] : [{
        route: `${route.method} ${route.url}`,
        key: route.escalation.key,
        refusal: route.escalation.refusal,
      }]);
    expect(escalations).toEqual([{
      route: 'POST /impersonation',
      key: 'platform.impersonation.write',
      refusal: 'impersonation_write_not_permitted',
    }]);
    // And the refusal is in the contract, so moving the check did not cost the
    // sentence a support agent needs to read.
    expect(Object.keys(ERROR_CONTRACT)).toContain('impersonation_write_not_permitted');
  });
});

describe('the lease requirement is declared, not discovered', () => {
  const pos = posRoutes();

  it('requires a lease on everything that touches a leased session', () => {
    const required = pos
      .filter((r) => r.lease !== undefined && r.lease !== 'exempt')
      .map((r) => `${r.method} ${r.url}`);
    assertCheckedSet({
      label: 'lease-required POS routes',
      checked: required,
      minimum: 10,
      mustInclude: ['POST /pos/order/:id/fire', 'POST /pos/bill/:id/tender',
                    'POST /pos/order/:id/line'],
    });
  });

  it('exempts exactly the two routes whose actor CANNOT hold a lease', () => {
    const exempt = pos
      .filter((r) => r.lease === 'exempt' && MUTATING_METHODS.includes(r.method))
      .map((r) => r.url);

    // force-release exists BECAUSE a device died holding the lease, so the
    // manager has no token by definition -- requiring one would make the
    // recovery path depend on the thing being recovered from. Manual settlement
    // is a cashier keying in money after an outage, usually on another device.
    expect(exempt).toContain('/pos/session/:id/lease/force-release');
    expect(exempt).toContain('/pos/bill/:id/settle-manual');
  });

  it('names a subject on every leased route, and a reachable one', () => {
    // The subject is what the registrar resolves the session from. A leased
    // route without one could only be presence-checked, which is what it did for
    // its whole life before this test existed.
    for (const route of pos) {
      if (route.lease === undefined || route.lease === 'exempt') continue;
      expect(['session', 'order', 'bill'], `${route.url}`).toContain(route.lease.subject);
      if (route.lease.at.in === 'param') {
        expect(route.url, `${route.url} is leased on :${route.lease.at.name}`)
          .toContain(`:${route.lease.at.name}`);
      }
    }
  });

  it('leaves no POS mutation without a lease decision', () => {
    const undecided = pos
      .filter((r) => MUTATING_METHODS.includes(r.method) && r.lease === undefined)
      .map((r) => `${r.method} ${r.url}`);
    expect(undecided, 'every POS mutation states required or exempt').toEqual([]);
  });
});

/* -------------------------------------------------- the error contract --- */

describe('the POS can tell the five refusals apart', () => {
  it('maps each code to a status AND an explicit retryable', () => {
    assertCheckedSet({
      label: 'error contract codes',
      checked: Object.keys(ERROR_CONTRACT),
      minimum: 15,
      mustInclude: ['session_leased', 'lease_not_held', 'offline_expired',
                    'stale_beyond_window', 'upgrade_required', 'entitlement_unavailable'],
    });
  });

  it('does NOT let the tablet infer retryable from the status class', () => {
    // Two 409s demanding opposite actions is exactly the case inference gets
    // wrong.
    expect(ERROR_CONTRACT['session_leased']!.status).toBe(409);
    expect(ERROR_CONTRACT['lease_not_held']!.status).toBe(409);
    expect(ERROR_CONTRACT['session_leased']!.retryable).toBe(false);
    expect(ERROR_CONTRACT['lease_not_held']!.retryable).toBe(false);
    // And a 5xx that is NOT retryable, so the reverse inference fails too.
    expect(ERROR_CONTRACT['tenant_context_required']!.status).toBe(500);
    expect(ERROR_CONTRACT['tenant_context_required']!.retryable).toBe(false);
  });

  it('answers a quarantine with 202, never a 4xx', () => {
    for (const code of ['stale_beyond_window', 'lease_force_released',
                        'lease_conflict', 'forbidden_operation']) {
      // A quarantined batch is not something the device should retry, and a 4xx
      // makes it retry forever against a wall.
      expect(ERROR_CONTRACT[code]!.status, code).toBe(202);
      expect(ERROR_CONTRACT[code]!.retryable, code).toBe(false);
    }
  });

  it('carries the real error class through, code and all', () => {
    const mapped = toErrorResponse(
      Object.assign(new Error('session x is leased by device y'), { code: 'session_leased' }));
    expect(mapped.status).toBe(409);
    expect(mapped.body).toEqual({
      error: 'session_leased', retryable: false,
      detail: 'session x is leased by device y',
    });
  });

  it('treats a serialisation failure as the one thing worth retrying', () => {
    const mapped = toErrorResponse(Object.assign(new Error('deadlock'), { code: '40P01' }));
    expect(mapped.status).toBe(503);
    expect(mapped.body.retryable).toBe(true);
    expect(mapped.body.error).toBe('conflict_retry');
  });

  it('makes an UNMAPPED error loud and non-retryable, never a soft 400', () => {
    const mapped = toErrorResponse(new Error('something nobody classified'));
    // A new error class nobody mapped must not be presented as a client mistake
    // the tablet can fix by changing its request.
    expect(mapped.status).toBe(500);
    expect(mapped.body.error).toBe('internal_error');
    expect(mapped.body.retryable).toBe(false);
  });

  it('has no order-time stock refusal', () => {
    // Negative stock is permitted, flagged and never blocking: refusing a
    // deduction does not un-cook the food. The only stock refusal is a waste
    // entry, which is an admin action.
    expect(ERROR_CONTRACT['insufficient_stock']!.clientAction).toMatch(/counted quantity/);
    const posUrls = posRoutes().map((r) => r.url);
    expect(posUrls.some((u) => u.includes('waste'))).toBe(false);
  });
});

/* --------------------------------------------------- registry wiring --- */

describe('registering the inventory populates the registry', () => {
  it('records plane, permission and lease for each route', () => {
    const app = Fastify();
    for (const route of posRoutes()) {
      registerTenantRoute(app, { pool, entitlements: planCache() }, route);
    }
    const registered = registeredRoutes();
    expect(registered.length).toBe(posRoutes().length);

    const fire = registered.find((r) => r.url === '/pos/order/:id/fire')!;
    expect(fire.plane).toBe('tenant');
    expect(fire.permission).toEqual({ plane: 'tenant', key: 'kot.fire' satisfies PermissionKey });
    expect(fire.lease).toEqual({ subject: 'order', at: { in: 'param', name: 'id' } });
    expect(fire.audit).not.toBe('none');
  });
});
