import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import pg from 'pg';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';

/**
 * ###########################################################################
 * A TEST RUNNING AS THE OWNER IS NOT TESTING THE POSTURE PRODUCTION USES.
 *
 * `FORCE ROW LEVEL SECURITY` is deliberately off, so the owner is exempt from
 * every policy by virtue of owning the tables. A test that hands the owner client
 * to a function which reads `app.*` therefore exercises a MORE PRIVILEGED path
 * that merely shares code with the real one.
 *
 * That is not hypothetical. `verifyPrintDrain` read `app.print_job` with no
 * tenant scope: the print worker crashed on every real invocation while its test
 * passed, because the test supplied the owner client. The test passed for the
 * wrong reason -- the mirror image of the partition test that once failed for the
 * wrong reason.
 *
 * So: a production function that touches a tenant table may not be called with
 * the owner client, unless the owner genuinely IS its production role.
 * ###########################################################################
 */

/**
 * Functions whose production role really is katkitchen_owner. Allowlist polarity:
 * anything not named here is denied, because the set of production functions
 * grows and a blocklist would fail open.
 */
const OWNER_POSTURE: ReadonlyArray<{ fn: string; why: string }> = [
  { fn: 'seedPermissionCatalogue', why: 'the catalogue seed runs as the owner on every deploy' },
  { fn: 'seedPlatformAuthz', why: 'control-plane seeding, owner-role' },
  { fn: 'seedTenantSystemRoles', why: 'the seed must be able to push new keys into locked system roles, which only the owner may do' },
  { fn: 'reconcileAllTenantSystemRoles', why: 'the deploy seed (database/seed.ts) and pnpm reconcile:roles run it as the owner: seedTenantSystemRoles for every tenant' },
  { fn: 'catalogueDrift', why: 'reads the seeded catalogue as the seeder sees it' },
  { fn: 'grantOwnerMemberships', why: 'part of the provisioning transaction, which is owner-role' },
  { fn: 'provisionTenant', why: 'runs in the owner transaction before any tenant session exists' },
  { fn: 'missingPartitionMonths', why: 'the partition job must run as the owner or the revokes do not apply' },
  { fn: 'ensureAuditPartitionFor', why: 'partition DDL, same posture as the partition job: ALTER DEFAULT PRIVILEGES only affects objects created afterward BY THAT ROLE, so a partition created as the app role lands with the append-only revokes silently not applied' },
  { fn: 'anonymiseTenant', why: 'the purge job is owner-role; it writes app_user across tenants by design' },
  { fn: 'recomputeLadder', why: 'the ladder job is an owner-role reconciliation over platform.tenant' },
  { fn: 'ladderThresholds', why: 'reads platform settings for the owner-role ladder job' },
  { fn: 'publishEntitlement', why: 'the control plane publishes the document as the owner' },
  { fn: 'loadLiveSession', why: 'impersonation session lifecycle is control-plane, owner-role' },
  { fn: 'revokeImpersonation', why: 'the one-way revocation stamp, owner-role' },
];

const ALLOWED = new Map(OWNER_POSTURE.map((o) => [o.fn, o.why]));

function walk(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = `${dir}/${entry}`;
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * Every exported function of a module that references a tenant table.
 *
 * Attribution is per MODULE, not per function body, because a function composes
 * its SQL from module-level constants: `salesBy` builds every query out of
 * LINE_SOURCE and MEASURES, so a body scan sees no table name at all and misses
 * it entirely.
 *
 * A miss here ships a bug; an over-match merely asks a test to use the app
 * client, which it should be doing anyway. So it fails closed.
 */
function functionsTouchingAppTables(): ReadonlySet<string> {
  const touching = new Set<string>();
  for (const file of walk('src').filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // `app.tenant_id` is the GUC and `app.current_tenant_id()` a function, not tables.
    if (!/\bapp\.(?!tenant_id\b|current_tenant_id\b)[a-z_]+/.test(source)) continue;
    for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) {
      touching.add(m[1]!);
    }
  }
  return touching;
}

interface Violation { readonly file: string; readonly fn: string }

function findOwnerCalls(file: string, source: string, appTouching: ReadonlySet<string>): readonly Violation[] {
  const imported = new Set<string>();
  for (const m of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'(?:\.\.\/)+src\/[^']+'/g)) {
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().split(' as ')[0]!.replace('type ', '').trim();
      if (name) imported.add(name);
    }
  }

  const violations: Violation[] = [];
  for (const fn of imported) {
    if (ALLOWED.has(fn) || !appTouching.has(fn)) continue;
    if (new RegExp(`\\b${fn}\\s*\\(\\s*owner\\b`).test(source)) violations.push({ file, fn });
  }
  return violations;
}

let appTouching: ReadonlySet<string>;
beforeAll(() => { appTouching = functionsTouchingAppTables(); });

describe('tests exercise the app posture, not the owner posture', () => {
  it('derives which functions touch tenant tables, rather than listing them', () => {
    assertCheckedSet({
      label: 'functions reading app tables',
      checked: [...appTouching],
      minimum: 20,
      mustInclude: ['requestReprint', 'branchPrintFailures', 'deductForKot', 'salesBy'],
    });
    // The GUC is not a table; matching it would flag every scoped function.
    expect(appTouching.has('reclaimStale')).toBe(true);
  });

  it('finds no test handing the owner client to a tenant-table function', () => {
    const violations = walk('tests')
      .filter((f) => f.endsWith('.test.ts'))
      .flatMap((f) => findOwnerCalls(f, readFileSync(f, 'utf8'), appTouching));

    expect(
      violations.map((v) => `${v.file}: ${v.fn}(owner, ...)`),
      'the owner is exempt from RLS by table ownership, so this exercises a more ' +
        'privileged path than production. Use the app client with a tenant GUC, or add ' +
        'the function to OWNER_POSTURE with the reason its production role is the owner.',
    ).toEqual([]);
  });

  it('justifies every owner-posture exemption', () => {
    assertCheckedSet({
      label: 'owner-posture functions',
      checked: OWNER_POSTURE.map((o) => o.fn),
      minimum: 12,
      mustInclude: ['provisionTenant', 'seedTenantSystemRoles', 'anonymiseTenant',
                    'missingPartitionMonths'],
    });
    expect(OWNER_POSTURE.filter((o) => o.why.length < 30)).toEqual([]);
  });
});

describe('the app role can use every table it must', () => {
  let denied: { name: string; select: boolean; insert: boolean }[];

  beforeAll(async () => {
    const owner: pg.Client = ownerClient();
    await owner.connect();
    try {
      const result = await owner.query<{ name: string; sel: boolean; ins: boolean }>(
        `SELECT c.relnamespace::regnamespace || '.' || c.relname AS name,
                has_table_privilege('katkitchen_app', c.oid, 'SELECT') AS sel,
                has_table_privilege('katkitchen_app', c.oid, 'INSERT') AS ins
           FROM pg_class c
          WHERE c.relkind = 'r'
            AND c.relnamespace::regnamespace::text IN ('app', 'platform')
            AND NOT (has_table_privilege('katkitchen_app', c.oid, 'SELECT')
                 AND has_table_privilege('katkitchen_app', c.oid, 'INSERT'))
          ORDER BY 1`,
      );
      denied = result.rows.map((r) => ({ name: r.name, select: r.sel, insert: r.ins }));
    } finally {
      await owner.end();
    }
  });

  /**
   * ###########################################################################
   * TABLES THE APP ROLE MAY READ AND MUST NOT WRITE.
   *
   * The check below used to be "SELECT and INSERT, or it is a production
   * hazard", with the audit partitions as the one exemption. Migration 0052
   * added a second, different kind of table: the jurisdiction catalogue is
   * IMMUTABLE GLOBAL REFERENCE DATA -- the app role reads it on every bill and
   * may never write it, because these rows ARE a guard and a plane that could
   * write its own guard is not bound by it. That is the whole objection to
   * moving a rule out of code, and the grant is the answer to it.
   *
   * Listed by name rather than pattern-matched, and asserted POSITIVELY:
   * SELECT yes, and INSERT / UPDATE / DELETE no. An exemption that only said
   * "do not require INSERT here" would also pass for a table the app role had
   * been quietly granted everything on.
   * ###########################################################################
   */
  const READ_ONLY_TO_APP: Readonly<Record<string, string>> = {
    'platform.tax_jurisdiction':
      'the regimes this product knows about. A guard expressed as data; only the owner-role seed writes it',
    'platform.tax_treatment':
      'the supply treatments per jurisdiction and what a document head must look like under each. Read by app.assert_bill_line_heads_match_treatment at COMMIT',
    'platform.tax_rate_override':
      'the rate a stated PREMISES position imposes, overriding the dish tax class. Read by app.assert_order_line_premises_rate at COMMIT and by the rate resolution in orderEntry; a tenant that could write it could lower its own specified-premises rate to the one it prefers',
    'platform.tax_head':
      'the head names and their shares of the headline rate. A tenant that could add a head could name its own, which is exactly the defect 0050 removed when it deleted app.tax_component',
  };

  it('denies the app role ONLY the audit partitions, and denies those completely', () => {
    // Grants do not propagate to new partitions, and the partition job revokes on
    // each one so direct access is impossible regardless of policy state. Access
    // goes through the parent. Anything ELSE here is a table the app role would
    // fail on in production while every owner-run test passed.
    const unexpected = denied
      .filter((d) => !/_audit_log_(\d{4}_\d{2}|default)$/.test(d.name))
      .filter((d) => !(d.name in READ_ONLY_TO_APP));
    expect(
      unexpected.map((d) => d.name),
      'the app role cannot use these tables; production would fail where the tests do not',
    ).toEqual([]);

    // Non-vacuity: the partitions must actually be denied, or this passed over
    // an empty set.
    const partitions = denied.filter((d) => /_audit_log_(\d{4}_\d{2}|default)$/.test(d.name));
    expect(partitions.length).toBeGreaterThanOrEqual(4);
    expect(partitions.every((d) => !d.select && !d.insert)).toBe(true);
  });

  it('grants the reference catalogue READ and nothing else, which is the guard', async () => {
    const owner: pg.Client = ownerClient();
    await owner.connect();
    try {
      const checked: string[] = [];
      for (const [table, why] of Object.entries(READ_ONLY_TO_APP)) {
        expect(why.length, `${table} needs a reason`).toBeGreaterThan(30);
        const row = (await owner.query<{
          sel: boolean; ins: boolean; upd: boolean; del: boolean;
        }>(
          `SELECT has_table_privilege('katkitchen_app', $1, 'SELECT') AS sel,
                  has_table_privilege('katkitchen_app', $1, 'INSERT') AS ins,
                  has_table_privilege('katkitchen_app', $1, 'UPDATE') AS upd,
                  has_table_privilege('katkitchen_app', $1, 'DELETE') AS del`,
          [table])).rows[0]!;
        expect({ table, ...row })
          .toEqual({ table, sel: true, ins: false, upd: false, del: false });
        checked.push(table);
      }
      assertCheckedSet({
        label: 'read-only reference tables',
        checked,
        minimum: 3,
        mustInclude: ['platform.tax_jurisdiction', 'platform.tax_treatment',
                      'platform.tax_head'],
      });
    } finally {
      await owner.end();
    }
  });
});

/* ------------------------------------- the owner pool, and who gets it --- */

describe('only a route that must have the owner role declares it', () => {
  /**
   * ###########################################################################
   * THE POOL WIRING AND THE POSTURE THIS FILE RECORDS HAD DIVERGED.
   *
   * `provisionTenant` has been in OWNER_POSTURE above since it was written, with
   * the reason "runs in the owner transaction before any tenant session exists".
   * The server built ONE pool, on the app role, and handed it to both registrars
   * -- so `POST /tenants` reached `provisionTenant` on a connection that every
   * `app` table refuses (SQLSTATE 28000, `app.tenant_id is not set`). The route
   * answered `500 internal_error` and every test passed, because every test
   * builds its pool from DATABASE_URL_OWNER.
   *
   * This file knew the right answer and nothing compared it to the wiring.
   *
   * The first fix gave the WHOLE control plane the owner, and the system-health
   * check refused it on its own connection: a table owner is outside RLS
   * whatever its NOBYPASSRLS setting, because no policy is evaluated for the
   * owner at all. So it is per-route, and this gate is the comparison that was
   * missing.
   * ###########################################################################
   */

  it('declares the owner role on exactly the routes that provision', async () => {
    const { allRoutes } = await import('../../src/routes/index.js');
    const owned = allRoutes()
      .filter((route) => route.role === 'owner')
      .map((route) => `${route.method} ${route.url}`);

    // Exactly one. Every other control-plane route reads `platform.*`, which has
    // no RLS to be exempt from, so an owner connection buys it nothing and
    // widens what a future handler could reach.
    expect(owned).toEqual(['POST /tenants']);
  });

  it('gives the owner role only to routes whose function is listed above', async () => {
    const { allRoutes } = await import('../../src/routes/index.js');
    const { handlerName } = await import('../../src/routes/lookup.js');

    // The handler name a route asks for, mapped to the domain function the
    // allowlist above already vouches for. `provision` -> `provisionTenant`.
    const VOUCHED: Readonly<Record<string, string>> = { provision: 'provisionTenant' };

    for (const route of allRoutes()) {
      if (route.role !== 'owner') continue;
      const name = handlerName(route.handler);
      expect(name, `${route.url} has no handler name to vouch for`).not.toBeNull();
      const fn = VOUCHED[name!];
      expect(fn, `${name} declares role: 'owner' and is not vouched for`).toBeDefined();
      expect(
        ALLOWED.has(fn!),
        `${fn} is given an owner connection but is not in OWNER_POSTURE with a reason`,
      ).toBe(true);
    }
  });

  it('leaves every tenant-plane route on the app role, with no way to ask', async () => {
    const { allRoutes } = await import('../../src/routes/index.js');
    // A tenant route on an owner connection would be outside RLS -- the one
    // thing the whole two-plane design exists to prevent. `role` is honoured
    // only by the platform registrar, and this pins that nothing tenant-shaped
    // has started declaring it.
    const wrong = allRoutes()
      .filter((route) => route.role === 'owner' && route.plane !== 'platform')
      .map((route) => `${route.method} ${route.url}`);
    expect(wrong, 'a tenant or public route may never run as the owner').toEqual([]);
  });

  it('is not vacuous: the app role really is refused the write provisioning makes',
    async () => {
      // The reason `role: 'owner'` exists at all, asserted rather than asserted
      // ABOUT. If this ever stops refusing, the declaration is no longer needed
      // and should go.
      const pg = (await import('pg')).default;
      const app = new pg.Client({ connectionString: process.env['DATABASE_URL_APP']! });
      await app.connect();
      try {
        await app.query('BEGIN');
        await expect(app.query(
          `INSERT INTO app.branch (id, tenant_id, code, name, timezone, gst_registration)
           VALUES (gen_random_uuid(), gen_random_uuid(), 'PROBE', 'Probe', 'Asia/Kolkata', 'unstated')`,
        )).rejects.toMatchObject({ code: '28000' });
      } finally {
        await app.query('ROLLBACK').catch(() => undefined);
        await app.end();
      }
    });
});
