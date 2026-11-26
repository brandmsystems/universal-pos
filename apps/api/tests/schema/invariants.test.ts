import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { APP_TABLES, AUDIT_PARENTS, assertCheckedSet, ownerClient } from '../helpers/db.js';

/**
 * Schema invariants, asserted by introspection rather than by convention.
 *
 * These replace the base-repository exception list: a list drifts silently, a
 * query over information_schema and pg_catalog does not. A new table cannot
 * quietly join the exception set, because there is no set to join.
 *
 * Every test here names the set it checked before asserting the set of
 * violations is empty -- see assertCheckedSet.
 *
 * Requires a migrated database: pnpm db:bootstrap && pnpm db:migrate
 */

let client: pg.Client;

// 7 declared tables + 4 monthly audit partitions + 1 default.
const MIN_APP_RELATIONS = 81;

beforeAll(async () => {
  client = ownerClient();
  await client.connect();
});

afterAll(async () => {
  await client?.end();
});

describe('schema app: every table is tenant-scoped', () => {
  it('gives every table tenant_id NOT NULL', async () => {
    const checked = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'app' AND table_type = 'BASE TABLE'`,
    );
    assertCheckedSet({
      label: 'app base tables',
      checked: checked.rows.map((r) => r.table_name),
      minimum: MIN_APP_RELATIONS,
      mustInclude: APP_TABLES,
    });

    const violations = await client.query<{ table_name: string }>(
      `SELECT t.table_name
         FROM information_schema.tables t
        WHERE t.table_schema = 'app'
          AND t.table_type = 'BASE TABLE'
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'app'
               AND c.table_name = t.table_name
               AND c.column_name = 'tenant_id'
               AND c.is_nullable = 'NO')`,
    );
    expect(violations.rows.map((r) => r.table_name)).toEqual([]);
  });
});

describe('schema app: RLS covers partitions, not just parents', () => {
  async function appRelations(): Promise<string[]> {
    const result = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')`,
    );
    return result.rows.map((r) => r.relname);
  }

  it('enables row level security on every relation including partitions', async () => {
    assertCheckedSet({
      label: 'app relations',
      checked: await appRelations(),
      minimum: MIN_APP_RELATIONS,
      mustInclude: [...APP_TABLES, 'tenant_audit_log_default'],
    });

    const violations = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND c.relrowsecurity = false`,
    );
    expect(violations.rows.map((r) => r.relname)).toEqual([]);
  });

  it('gives every relation a policy with both USING and WITH CHECK', async () => {
    // USING alone lets a request write a row into a tenant it cannot read.
    assertCheckedSet({
      label: 'app relations',
      checked: await appRelations(),
      minimum: MIN_APP_RELATIONS,
      mustInclude: [...APP_TABLES, 'tenant_audit_log_default'],
    });

    const violations = await client.query<{ relname: string; reason: string }>(
      `SELECT c.relname,
              CASE WHEN p.polname IS NULL THEN 'no policy'
                   WHEN p.polqual IS NULL THEN 'no USING'
                   ELSE 'no WITH CHECK' END AS reason
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_policy p ON p.polrelid = c.oid
        WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
          AND (p.polname IS NULL OR p.polqual IS NULL OR p.polwithcheck IS NULL)`,
    );
    expect(violations.rows).toEqual([]);
  });
});

describe('cross-schema foreign keys are one-directional', () => {
  /**
   * An FK from the control plane into tenant data makes hard boundary #1
   * unachievable: schema app could never move to its own database without
   * dropping it. app -> platform is permitted; platform -> app never is.
   */
  async function fkSourceTables(schema: string): Promise<string[]> {
    const result = await client.query<{ relname: string }>(
      `SELECT DISTINCT s.relname
         FROM pg_constraint c
         JOIN pg_class s ON s.oid = c.conrelid
         JOIN pg_namespace sn ON sn.oid = s.relnamespace
        WHERE c.contype = 'f' AND sn.nspname = $1`,
      [schema],
    );
    return result.rows.map((r) => r.relname);
  }

  it('has no foreign key originating in platform and terminating in app', async () => {
    // Non-vacuity matters most here: if this query stopped matching any FK at
    // all it would report "no violations" forever.
    assertCheckedSet({
      label: 'platform tables holding foreign keys',
      checked: await fkSourceTables('platform'),
      minimum: 4,
      mustInclude: ['platform_user', 'tenant', 'tenant_owner_invite', 'platform_audit_log'],
    });

    const violations = await client.query<{ conname: string; source: string; target: string }>(
      `SELECT c.conname,
              sn.nspname || '.' || s.relname AS source,
              tn.nspname || '.' || t.relname AS target
         FROM pg_constraint c
         JOIN pg_class s ON s.oid = c.conrelid
         JOIN pg_namespace sn ON sn.oid = s.relnamespace
         JOIN pg_class t ON t.oid = c.confrelid
         JOIN pg_namespace tn ON tn.oid = t.relnamespace
        WHERE c.contype = 'f' AND sn.nspname = 'platform' AND tn.nspname = 'app'`,
    );
    expect(violations.rows).toEqual([]);
  });

  it('still uses the permitted app -> platform direction', async () => {
    // Proves the rule is a direction, not an accident of having no cross-schema
    // FKs at all.
    const result = await client.query<{ source: string }>(
      `SELECT DISTINCT s.relname AS source
         FROM pg_constraint c
         JOIN pg_class s ON s.oid = c.conrelid
         JOIN pg_namespace sn ON sn.oid = s.relnamespace
         JOIN pg_class t ON t.oid = c.confrelid
         JOIN pg_namespace tn ON tn.oid = t.relnamespace
        WHERE c.contype = 'f' AND sn.nspname = 'app' AND tn.nspname = 'platform'`,
    );
    assertCheckedSet({
      label: 'app tables with FKs into platform',
      checked: result.rows.map((r) => r.source),
      minimum: 5,
      mustInclude: ['branch', 'app_user', 'role', 'role_permission', 'tenant_audit_log'],
    });
  });
});

describe('audit tables are append-only for the application role', () => {
  it('denies UPDATE and DELETE on both audit parents', async () => {
    assertCheckedSet({
      label: 'audit parents',
      checked: [...AUDIT_PARENTS],
      minimum: 2,
      mustInclude: AUDIT_PARENTS,
    });

    for (const table of AUDIT_PARENTS) {
      const result = await client.query<{ can_update: boolean; can_delete: boolean }>(
        `SELECT has_table_privilege('katkitchen_app', $1, 'UPDATE') AS can_update,
                has_table_privilege('katkitchen_app', $1, 'DELETE') AS can_delete`,
        [table],
      );
      expect(result.rows[0], `privileges on ${table}`).toEqual({
        can_update: false,
        can_delete: false,
      });
    }
  });

  it('grants the application role nothing at all on any audit partition', async () => {
    // Grants do not propagate to new partitions -- ALTER DEFAULT PRIVILEGES only
    // covers objects created afterward by that role -- so partitions are revoked
    // outright and reached only through the parent.
    // Partitions OF THE AUDIT TABLES specifically. Scanning every partition in the
    // two schemas over-matches: request_claim is also partitioned and its
    // partitions are legitimately reachable by the application role.
    const checked = await client.query<{ relname: string }>(
      `SELECT n.nspname || '.' || c.relname AS relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE c.relkind IN ('r', 'p')
          AND p.relname IN ('platform_audit_log', 'tenant_audit_log')`,
    );
    assertCheckedSet({
      label: 'audit partitions',
      checked: checked.rows.map((r) => r.relname),
      minimum: 10,
      mustInclude: [
        'app.tenant_audit_log_default',
        'platform.platform_audit_log_default',
      ],
    });

    const violations = await client.query<{ relname: string }>(
      `SELECT n.nspname || '.' || c.relname AS relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE c.relkind IN ('r', 'p')
          AND p.relname IN ('platform_audit_log', 'tenant_audit_log')
          AND (has_table_privilege('katkitchen_app', c.oid, 'SELECT')
            OR has_table_privilege('katkitchen_app', c.oid, 'INSERT')
            OR has_table_privilege('katkitchen_app', c.oid, 'UPDATE')
            OR has_table_privilege('katkitchen_app', c.oid, 'DELETE'))`,
    );
    expect(violations.rows.map((r) => r.relname)).toEqual([]);
  });
});

describe('the reporting role cannot reach tenant data', () => {
  it('has no USAGE on schema app but does have it on platform', async () => {
    const result = await client.query<{ app: boolean; platform: boolean }>(
      `SELECT has_schema_privilege('katkitchen_platform_readonly', 'app', 'USAGE') AS app,
              has_schema_privilege('katkitchen_platform_readonly', 'platform', 'USAGE') AS platform`,
    );
    // Asserting both directions: a role with access to nothing would satisfy the
    // first half while being a broken deployment rather than a secure one.
    expect(result.rows[0]).toEqual({ app: false, platform: true });
  });
});
