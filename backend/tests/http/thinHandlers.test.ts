import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assertCheckedSet } from '../helpers/db.js';
import { mergeHandlers } from '../../src/routes/lookup.js';

/**
 * ###########################################################################
 * THE ROUTE LAYER MAKES NO DECISIONS, AND THIS IS THE GATE THAT KEEPS IT SO.
 *
 * The reporting scanner (`tests/reporting/snapshotOnly.test.ts`) does not
 * transfer here, and the difference is worth naming rather than assuming:
 *
 *   - A REPORT reads, and its risk is dereferencing a live value -- so its gate
 *     is an allowlist of tables it may read.
 *   - A HANDLER writes, and its risk is TAKING the snapshot itself: computing a
 *     price, accepting one from the body, or reading a catalogue row for a
 *     number on its way to an INSERT.
 *
 * An allowlist of readable tables says nothing about the second. The gate that
 * does is stronger and simpler: the route layer may not issue SQL AT ALL, and
 * may not do money arithmetic. If it cannot query, it cannot snapshot wrongly
 * and it cannot read a live price; every write necessarily goes through a domain
 * function, which is where the rule lives and where the offline sync path also
 * calls it.
 *
 * This is what makes "one addLine" true rather than aspirational. A snapshot
 * implemented in the route layer is a snapshot the sync path does not take --
 * and the symptom is a bill that fails to reconcile weeks later, traced to lines
 * that came from a tablet.
 *
 * ---------------------------------------------------------------------------
 * IT SCANS THE WHOLE ROUTE LAYER, NOT ONE DIRECTORY INSIDE IT.
 *
 * This gate used to scan `src/http/handlers/` only, and it passed for the wrong
 * reason: `readBoard` -- six queries including a live catalogue price -- sat in
 * `src/routes/pos.ts`, one directory over, and `handlers/pos.ts` imported
 * it. The handlers were SQL-free by GEOGRAPHY. A gate naming one directory
 * beside a directory that grows is the wrong polarity: adding a file to
 * `routes/` silently widened the ungated surface while every test stayed green.
 *
 * So the scan is recursive, and SQL is permitted only in the REGISTRARS named
 * below.
 *
 * ###########################################################################
 * SINCE THE backend RESTRUCTURE THE ROUTE LAYER IS NOT ONE DIRECTORY, AND THE
 * SCAN IS THEREFORE EVERYTHING *EXCEPT* THE DOMAIN.
 *
 * The layer now spans `app.ts`, `routes/` (tables and handlers),
 * `core/middleware/` (registrars) and `core/security/` (guards). Naming those
 * four would be a list sitting next to something that expands -- the exact
 * shape of defect (5) in CLAUDE.md, which was a gate naming one directory while
 * the SQL lived in the next. So the polarity is inverted: every file under
 * `src/` is scanned unless it sits under a named DOMAIN root. A new top-level
 * folder is scanned by default; exempting one is a visible edit to DOMAIN_ROOTS.
 * ########################################################################### Everything else is denied until someone justifies
 * it there -- the same direction as a new permission key defaulting deny.
 *
 * `readBoard` now lives in `src/modules/orders/board.ts`. Its live-price read was never the
 * defect and must not be "fixed": the board renders the menu a waiter chooses
 * FROM, so it must show the current price, and the snapshot happens in
 * `addLine`. The reasoning is on the query itself, because that is the thing a
 * later reader gets wrong.
 * ###########################################################################
 */

const SRC_DIR = 'src';

/**
 * Where SQL legitimately lives, and so what the route-layer rules do not apply
 * to: the domain modules, the database core, configuration, the job runner and
 * the process entry point. Everything else under src/ is route layer.
 */
const DOMAIN_ROOTS: readonly string[] = [
  'modules/', 'core/database/', 'config/', 'jobs/', 'server.ts',
];

/**
 * The ONLY route-layer modules permitted to issue SQL.
 *
 * Both are registrars: infrastructure that owns the transaction, the actor
 * snapshot and the audit write. They are the mechanism the rule is implemented
 * BY, so they cannot be subject to it.
 *
 * `routeRegistry.ts` is deliberately ABSENT: it goes through repositories and
 * has zero raw queries today. Keep it that way -- if it needs one, that is a
 * decision to make here, visibly.
 */
const SQL_PERMITTED: readonly string[] = [
  // The control-plane registrar: opens the transaction with no tenant GUC and
  // writes platform.platform_audit_log in it.
  'core/middleware/platformRoute.ts',
  // The pre-auth registrar. Its transaction spans the credential verify and the
  // platform.auth_attempt row, so a lockout increment cannot survive a failure
  // to record why it happened. Registrar infrastructure, same class as
  // platformRoute.ts -- and it is BEGIN/COMMIT plus one insert through
  // recordAuthAttempt, not a snapshot: the rule this gate exists for is that a
  // route layer must not decide what a line costs, and nothing here reads a
  // price.
  'core/middleware/publicRoute.ts',
  // The print agent's registrar: BEGIN/COMMIT around the agent-token check
  // (which sets the tenant GUC) and the poll. Infrastructure of the same class
  // as publicRoute.ts; every read and write is in modules/kitchen/printAgent.ts.
  'core/middleware/agentRoute.ts',
];

/** Any query call. The domain layer owns SQL; the route layer owns none of it. */
const QUERY_CALL = /\.query\s*[(<]|\bsql`/;

/**
 * Money arithmetic. Deliberately crude and deliberately over-eager: a false
 * positive costs one line of justification, a false negative costs a wrong bill.
 */
const MONEY_MATH =
  /\w*(minor|price|amount|total|delta|bps)\w*\s*[*/+-]\s*\w|\w+\s*[*/+-]\s*\w*(minor|price|total|bps)/i;

/**
 * A CATALOGUE price from the request body, which is the one that looks harmless.
 *
 * The distinction is not "money in the body". A tender amount is what the
 * customer handed over and a discount amount is what a manager decided -- both
 * are legitimately stated by the request, and both are bounded by the domain
 * (the tender against the bill total by deferred trigger, the discount against
 * the role's cap). A UNIT PRICE is different in kind: nobody states it, it is
 * looked up, and accepting one lets a tablet decide what the customer pays.
 */
const PRICE_FROM_BODY =
  /body<[^>]*\b(unitPrice|unitPriceMinor|priceMinor|price_minor|lineTotal|lineTotalMinor|unit_price|displayTotal)\b/;

/** Every .ts file under src/, at any depth, relative to src/. */
function allSourceFiles(dir: string = SRC_DIR, prefix = ''): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      out.push(...allSourceFiles(full, rel));
    } else if (entry.endsWith('.ts')) {
      out.push(rel);
    }
  }
  return out;
}

/** Pure, so the polarity can be tested with paths that do not exist yet. */
function isRouteLayer(relative: string): boolean {
  return !DOMAIN_ROOTS.some((root) => relative === root || relative.startsWith(root));
}

function routeLayerFiles(): readonly string[] {
  return allSourceFiles().filter(isRouteLayer);
}

function source(relative: string): string {
  return readFileSync(join(SRC_DIR, relative), 'utf8');
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the route layer is thin', () => {
  it('scans every route-layer file under src/, at any depth', () => {
    const files = routeLayerFiles();
    assertCheckedSet({
      label: 'route-layer modules',
      checked: files,
      // A ratchet. It was 3 when the gate scanned handlers/ alone; the route
      // layer is now app.ts, routes/, core/middleware, core/security and
      // core/errors -- 27 modules.
      minimum: 25,
      mustInclude: [
        'app.ts',
        'core/middleware/routeRegistry.ts',
        'core/middleware/platformRoute.ts',
        'core/middleware/publicRoute.ts',
        'core/security/planeGuards.ts',
        'core/errors/errors.ts',
        'routes/index.ts',
        'routes/pos.ts',
        'routes/lookup.ts',
        'routes/handlers/pos.ts',
        'routes/handlers/auth.ts',
        'routes/handlers/sync.ts',
      ],
    });
  });

  it('issues no SQL outside the two registrars', () => {
    const offenders = routeLayerFiles()
      .filter((file) => !SQL_PERMITTED.includes(file))
      .filter((file) => QUERY_CALL.test(source(file)));
    expect(
      offenders,
      'route-layer SQL can snapshot wrongly; move it into a domain function so ' +
        'the offline sync path gets the same rule. If it is genuinely registrar ' +
        'infrastructure, add it to SQL_PERMITTED with a reason.',
    ).toEqual([]);
  });

  it('keeps the SQL allowlist honest: every entry actually queries', () => {
    // An allowlist entry that no longer needs to be there is a hole waiting for
    // the next file with that name. Same ratchet as KEYS_WITHOUT_ROUTES refusing
    // an entry that already has a route.
    const idle = SQL_PERMITTED.filter((file) => !QUERY_CALL.test(source(file)));
    expect(
      idle,
      'these are exempted from the SQL rule but issue none -- drop them from ' +
        'SQL_PERMITTED so the exemption does not outlive its reason',
    ).toEqual([]);
  });

  it('does no money arithmetic, anywhere in the layer', () => {
    const offenders = routeLayerFiles().filter((file) =>
      MONEY_MATH.test(stripComments(source(file))));
    expect(
      offenders,
      'money arithmetic in the route layer is arithmetic the sync path does not do',
    ).toEqual([]);
  });

  it('never takes a price from the request body', () => {
    const offenders = routeLayerFiles().filter((file) => PRICE_FROM_BODY.test(source(file)));
    expect(
      offenders,
      'a price accepted from a tablet is an uncapped discount channel with no ' +
        'reason code and no exception report',
    ).toEqual([]);
  });

  it('is not vacuous: the patterns fire on route-layer code written the wrong way', () => {
    // A synthetic violation, per the standing rule that a test of a rule runs a
    // fixture CONSTRUCTED to violate it. Production files agreeing with the rule
    // is evidence about those files, not about the gate.
    //
    // Shaped as a ROUTE-TABLE module rather than a handler, because that is the
    // shape the old gate could not see: this is the file whose arrival would
    // have widened the ungated surface silently.
    const badRouteModule = `
      export async function readBoardish(context, params) {
        const rows = await context.client.query('SELECT price_minor FROM app.menu_item');
        return rows;
      }
      export function someRoutes(handlers = {}) {
        return [{ method: 'POST', url: '/lines', plane: 'tenant', audit: 'none',
          handler: async (request) => {
            const input = body<{ menuItemId: string; unitPriceMinor: number }>(request);
            const lineTotal = input.unitPriceMinor * input.quantity;
            return { lineTotal };
          } }];
      }`;
    expect(QUERY_CALL.test(badRouteModule), 'the SQL pattern must fire').toBe(true);
    expect(
      MONEY_MATH.test(stripComments(badRouteModule)),
      'the arithmetic pattern must fire',
    ).toBe(true);
    expect(PRICE_FROM_BODY.test(badRouteModule), 'the body-price pattern must fire').toBe(true);
  });

  it('is not vacuous: route files are SCANNED, domain files are not', () => {
    const files = routeLayerFiles();
    expect(files.filter((f) => f.startsWith('routes/handlers/')).length).toBeGreaterThanOrEqual(10);
    expect(files.filter((f) => f.startsWith('core/middleware/')).length).toBeGreaterThanOrEqual(6);
    expect(files.some((f) => f.startsWith('modules/')), 'domain modules must not be scanned').toBe(false);
  });

  it('fails closed: a file in a folder nobody has classified is route layer', () => {
    // The synthetic entry the standing rule asks for: paths the old list would
    // have missed. A new top-level folder, a new core/ subfolder and a handler
    // placed straight in src/ are all scanned without editing this file.
    for (const path of ['http/handlers/pos.ts', 'core/newthing/x.ts', 'controllers/orders.ts', 'app2.ts']) {
      expect(isRouteLayer(path), path).toBe(true);
    }
    for (const path of ['modules/orders/orderEntry.ts', 'core/database/unitOfWork.ts', 'jobs/runner.ts', 'server.ts']) {
      expect(isRouteLayer(path), path).toBe(false);
    }
  });
});

/**
 * ###########################################################################
 * HANDLER <-> ROUTE CORRESPONDENCE, IN BOTH DIRECTIONS.
 *
 * The route tables name their handlers by STRING (`h('addLine')`), so the join
 * is untyped and a rename on either side compiles cleanly. Both directions fail
 * differently and both are silent:
 *
 *   - A handler nobody routes to is dead code.
 *   - A ROUTE asking for a name the map does not supply falls back to the `ok`
 *     stub -- and the audit middleware then records `order.line.added` for a
 *     request that added nothing. That is the worse of the two by a distance.
 *
 * This previously did not work. The loop read `route.handler._name`, which was
 * set nowhere in src/, so the set it built was always empty -- and it was never
 * asserted on anyway. It is now tagged by `handlerLookup`, in one place.
 * ###########################################################################
 */
describe('every handler corresponds to a route, and every route to a handler', () => {
  it('supplies a handler for every name the route tables ask for', async () => {
    const { posHandlers } = await import('../../src/routes/handlers/pos.js');
    const { syncHandlers } = await import('../../src/routes/handlers/sync.js');
    const { authHandlers } = await import('../../src/routes/handlers/auth.js');
    const { staffHandlers } = await import('../../src/routes/handlers/staff.js');
    const { reportHandlers } = await import('../../src/routes/handlers/reports.js');
    const { platformHandlers } = await import('../../src/routes/handlers/platform.js');
    const { adminHandlers } = await import('../../src/routes/handlers/admin.js');
    const { crmHandlers } = await import('../../src/routes/handlers/crm.js');
    const { planHandlers } = await import('../../src/routes/handlers/plan.js');
    const { setupHandlers } = await import('../../src/routes/handlers/setup.js');
    const { accessHandlers } = await import('../../src/routes/handlers/access.js');
    const { allRoutes } = await import('../../src/routes/index.js');
    const { handlerName, isUnserved } = await import('../../src/routes/lookup.js');

    const handlers = mergeHandlers(
      posHandlers(), syncHandlers(),
      adminHandlers(), staffHandlers(), reportHandlers(),
      crmHandlers(), planHandlers(), setupHandlers(), accessHandlers(),
      platformHandlers('gate-test-key'), authHandlers('gate-test-key'));
    const routes = allRoutes(handlers);

    const wanted = routes.map((r) => handlerName(r.handler)).filter((n): n is string => n !== null);

    assertCheckedSet({
      label: 'handler names the route tables ask for',
      checked: wanted,
      minimum: 20,
      mustInclude: ['addLine', 'fire', 'void', 'discount', 'sync', 'markTicketReady', 'board',
        'settleManual', 'forceRelease'],
    });

    // Every route was tagged. An untagged one means a route table built its
    // handler without going through the lookup, which puts it outside this
    // assertion entirely -- the hole the old vacuous loop had.
    const untagged = routes
      .filter((r) => handlerName(r.handler) === null)
      .map((r) => `${r.method} ${r.url}`);
    expect(
      untagged,
      'these routes did not go through handlerLookup, so nothing checks that ' +
        'their handler exists',
    ).toEqual([]);

    // DIRECTION 1: a route may fall back to the stub only if it is DECLARED as
    // not yet served. Enforced both ways, so the list is a ratchet and not an
    // excuse -- same shape as KEYS_WITHOUT_ROUTES.
    const { ROUTES_WITHOUT_HANDLERS } = await import('../../src/routes/index.js');
    const declared = new Set(ROUTES_WITHOUT_HANDLERS);
    const unserved = routes
      .filter((r) => isUnserved(r.handler))
      .map((r) => `${r.method} ${r.url}`);

    assertCheckedSet({
      label: 'unserved routes actually observed',
      checked: unserved,
      // A FLOOR on how many routes are still unbuilt, and it has come down every
      // phase: 60 while the admin CRUD was unserved, then 40, and now 0 -- every
      // route in the table has a handler. It stays at 0 rather than being
      // deleted, because the assertion below it (nothing unserved is
      // undeclared) is the one that matters and it needs this set to exist.
      minimum: 0,
      // Nothing left to require. Every route the table declares is served, so a
      // `mustInclude` here could only name a route that is about to be built.
      mustInclude: [],
    });

    const undeclared = unserved.filter((key) => !declared.has(key));
    expect(
      undeclared,
      'these routes name a handler the maps do not supply and are NOT declared ' +
        'in ROUTES_WITHOUT_HANDLERS; they would answer {ok:true} while the audit ' +
        'middleware recorded the mutation anyway',
    ).toEqual([]);

    // The other half of the ratchet: an entry that is now served must leave the
    // list. Without this the declaration outlives the gap it described, and the
    // next unserved route with that path is invisible.
    const servedButListed = routes
      .filter((r) => !isUnserved(r.handler))
      .map((r) => `${r.method} ${r.url}`)
      .filter((key) => declared.has(key));
    expect(
      servedButListed,
      'these routes ARE served but are still declared unserved -- drop them from ' +
        'ROUTES_WITHOUT_HANDLERS',
    ).toEqual([]);

    // And no phantom entries: a path that no longer exists at all.
    const allKeys = new Set(routes.map((r) => `${r.method} ${r.url}`));
    const phantom = [...declared].filter((key) => !allKeys.has(key));
    expect(phantom, 'declared unserved but no such route exists').toEqual([]);
  });

  it('routes to every handler the maps supply', async () => {
    const { posHandlers } = await import('../../src/routes/handlers/pos.js');
    const { syncHandlers } = await import('../../src/routes/handlers/sync.js');
    const { authHandlers } = await import('../../src/routes/handlers/auth.js');
    const { staffHandlers } = await import('../../src/routes/handlers/staff.js');
    const { reportHandlers } = await import('../../src/routes/handlers/reports.js');
    const { platformHandlers } = await import('../../src/routes/handlers/platform.js');
    const { adminHandlers } = await import('../../src/routes/handlers/admin.js');
    const { crmHandlers } = await import('../../src/routes/handlers/crm.js');
    const { planHandlers } = await import('../../src/routes/handlers/plan.js');
    const { setupHandlers } = await import('../../src/routes/handlers/setup.js');
    const { accessHandlers } = await import('../../src/routes/handlers/access.js');
    const { allRoutes } = await import('../../src/routes/index.js');
    const { handlerName } = await import('../../src/routes/lookup.js');

    const provided = Object.keys(mergeHandlers(
      posHandlers(), syncHandlers(),
      adminHandlers(), staffHandlers(), reportHandlers(),
      crmHandlers(), planHandlers(), setupHandlers(), accessHandlers(),
      platformHandlers('gate-test-key'), authHandlers('gate-test-key')));
    assertCheckedSet({
      label: 'handler map keys',
      checked: provided,
      minimum: 20,
      mustInclude: ['addLine', 'fire', 'void', 'discount', 'sync', 'markTicketReady', 'board'],
    });

    const wanted = new Set(
      allRoutes().map((r) => handlerName(r.handler)).filter((n): n is string => n !== null));

    // DIRECTION 2: no handler may be unreachable.
    const orphaned = provided.filter((name) => !wanted.has(name));
    expect(
      orphaned,
      'these handlers are dead code: no route asks for them, so a rename on the ' +
        'route side has already silently detached them',
    ).toEqual([]);
  });

  it('is not vacuous: a renamed handler is detected in both directions', async () => {
    const { allRoutes } = await import('../../src/routes/index.js');
    const { handlerName, isUnserved } = await import('../../src/routes/lookup.js');
    const { posHandlers } = await import('../../src/routes/handlers/pos.js');
    const { syncHandlers } = await import('../../src/routes/handlers/sync.js');
    const { authHandlers } = await import('../../src/routes/handlers/auth.js');
    const { staffHandlers } = await import('../../src/routes/handlers/staff.js');
    const { reportHandlers } = await import('../../src/routes/handlers/reports.js');
    const { platformHandlers } = await import('../../src/routes/handlers/platform.js');
    const { adminHandlers } = await import('../../src/routes/handlers/admin.js');
    const { crmHandlers } = await import('../../src/routes/handlers/crm.js');
    const { planHandlers } = await import('../../src/routes/handlers/plan.js');
    const { setupHandlers } = await import('../../src/routes/handlers/setup.js');
    const { accessHandlers } = await import('../../src/routes/handlers/access.js');

    // Simulate the rename: supply every handler EXCEPT one, as a typo on the
    // handler-map side would.
    const all = mergeHandlers(
      posHandlers(), syncHandlers(),
      adminHandlers(), staffHandlers(), reportHandlers(),
      crmHandlers(), planHandlers(), setupHandlers(), accessHandlers(),
      platformHandlers('gate-test-key'), authHandlers('gate-test-key'));
    const { addLine: _dropped, ...renamed } = all as Record<string, unknown>;
    const routes = allRoutes(renamed as never);

    const unserved = routes.filter((r) => isUnserved(r.handler)).map((r) => handlerName(r.handler));
    expect(unserved, 'dropping addLine must surface as an unserved route').toContain('addLine');

    // And the reverse: a handler under a name no route asks for is orphaned.
    const wanted = new Set(
      routes.map((r) => handlerName(r.handler)).filter((n): n is string => n !== null));
    expect(wanted.has('addLineTypo')).toBe(false);
    expect(
      Object.keys({ ...renamed, addLineTypo: () => undefined }).filter((n) => !wanted.has(n)),
      'an orphaned handler must be detectable',
    ).toContain('addLineTypo');
  });
});

/* ------------------------------------------------- the handler-key merge --- */

describe('two surfaces cannot supply the same handler name', () => {
  it('refuses a collision at assembly rather than keeping the last one', async () => {
    const { mergeHandlers: merge, DuplicateHandlerKeyError } =
      await import('../../src/routes/lookup.js');

    // THE SYNTHETIC VIOLATION, in the exact shape the real one had: two maps,
    // one shared name, two different implementations.
    const posLike = { board: async () => ({ from: 'pos' }) };
    const kdsLike = { board: async () => ({ from: 'kds' }) };

    expect(() => merge(posLike as never, kdsLike as never))
      .toThrow(DuplicateHandlerKeyError);

    // And the gate is not vacuous: distinct names merge.
    expect(Object.keys(merge(
      { board: async () => ({}) } as never,
      { kdsBoard: async () => ({}) } as never,
    ))).toEqual(['board', 'kdsBoard']);
  });

  it('the real maps are collision-free, which is the whole assertion', async () => {
    const { posHandlers } = await import('../../src/routes/handlers/pos.js');
    const { syncHandlers } = await import('../../src/routes/handlers/sync.js');
    const { authHandlers } = await import('../../src/routes/handlers/auth.js');
    const { staffHandlers } = await import('../../src/routes/handlers/staff.js');
    const { reportHandlers } = await import('../../src/routes/handlers/reports.js');
    const { platformHandlers } = await import('../../src/routes/handlers/platform.js');
    const { adminHandlers } = await import('../../src/routes/handlers/admin.js');
    const { crmHandlers } = await import('../../src/routes/handlers/crm.js');
    const { planHandlers } = await import('../../src/routes/handlers/plan.js');
    const { setupHandlers } = await import('../../src/routes/handlers/setup.js');
    const { accessHandlers } = await import('../../src/routes/handlers/access.js');
    // Was NOT true. `posHandlers().board` and `kdsHandlers().board` collided,
    // and GET /pos/session/:id/board answered with the kitchen station list --
    // status 200, empty array, no error anywhere.
    // ALL eleven maps (the kitchen screen's went with the kitchen screen). This
    // once merged four while importing eleven -- the unused imports were the
    // tell (ESLint found it) that the assertion covered less than its title claimed.
    expect(() => mergeHandlers(
      posHandlers(), syncHandlers(), authHandlers('gate-test-key'),
      staffHandlers(), reportHandlers(), platformHandlers('gate-test-key'),
      adminHandlers(), crmHandlers(), planHandlers(), setupHandlers(), accessHandlers(),
    )).not.toThrow();
  });

});
