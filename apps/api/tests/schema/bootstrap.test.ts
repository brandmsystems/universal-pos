import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ownerClient } from '../helpers/db.js';

/**
 * Bootstrap-level properties. These are established by db/bootstrap/*.sql rather
 * than by a migration, which is exactly why they need asserting: nothing in the
 * migration history would notice if they were skipped on a new environment.
 */

let client: pg.Client;

beforeAll(async () => {
  client = ownerClient();
  await client.connect();
});

afterAll(async () => {
  await client?.end();
});

describe('citext lives in a dedicated extensions schema', () => {
  it('is installed, and not in public', async () => {
    const result = await client.query<{ schema: string }>(
      `SELECT n.nspname AS schema
         FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = 'citext'`,
    );
    // Non-vacuity: a missing extension must fail here, not silently skip.
    expect(result.rows, 'citext extension is not installed at all').toHaveLength(1);
    expect(result.rows[0]?.schema).toBe('extensions');
  });

  it('is actually used by the schema, not merely installed', async () => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_type t ON t.oid = a.atttypid
        WHERE n.nspname IN ('app', 'platform')
          AND t.typname = 'citext'
          AND a.attnum > 0 AND NOT a.attisdropped`,
    );
    expect(Number(result.rows[0]?.count ?? '0')).toBeGreaterThanOrEqual(5);
  });

  it('puts extensions on the application role search_path explicitly', async () => {
    // Nothing may rely on public being present or usable.
    const result = await client.query<{ setconfig: string[] }>(
      `SELECT s.setconfig
         FROM pg_db_role_setting s
         JOIN pg_roles r ON r.oid = s.setrole
         JOIN pg_database d ON d.oid = s.setdatabase
        WHERE r.rolname = 'katkitchen_app' AND d.datname = current_database()`,
    );
    expect(result.rows, 'katkitchen_app has no per-database settings at all').toHaveLength(1);

    const searchPath = (result.rows[0]?.setconfig ?? []).find((s) => s.startsWith('search_path='));
    expect(searchPath, 'no search_path set for katkitchen_app').toBeDefined();
    expect(searchPath).toContain('extensions');
    expect(searchPath).not.toContain('public');
  });
});

describe('schema public is stripped and empty', () => {
  it('grants PUBLIC nothing on schema public', async () => {
    const acl = await client.query<{ nspacl: string[] | null }>(
      `SELECT nspacl FROM pg_namespace WHERE nspname = 'public'`,
    );
    expect(acl.rows, 'schema public does not exist').toHaveLength(1);
    // A NULL ACL means "database default", which in PG15+ still grants USAGE to
    // PUBLIC -- so NULL is a failure here, not an absence of grants.
    expect(acl.rows[0]?.nspacl, 'schema public still carries default privileges').not.toBeNull();

    const toPublic = await client.query<{ privilege_type: string }>(
      `SELECT a.privilege_type
         FROM pg_namespace n, aclexplode(n.nspacl) a
        WHERE n.nspname = 'public' AND a.grantee = 0`,
    );
    expect(toPublic.rows.map((r) => r.privilege_type)).toEqual([]);
  });

  it('holds no objects', async () => {
    const result = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`,
    );
    expect(result.rows.map((r) => r.relname)).toEqual([]);
  });
});
