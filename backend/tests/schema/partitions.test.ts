import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { appClient, assertCheckedSet, ownerClient } from '../helpers/db.js';
import { missingPartitionMonths } from '../../src/database/partitions.js';

/**
 * The regression surface for the RLS-does-not-propagate bug is partitions
 * created *later*, by the job -- not the ones migration 0007 created. Asserting
 * the migration's own partitions proves nothing about the job.
 */

let owner: pg.Client;
let app: pg.Client;

const PROBE_TENANT = '0000ffff-0000-0000-0000-00000000f00d';

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

async function partitionNames(schema: string): Promise<string[]> {
  const result = await owner.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relispartition AND c.relkind IN ('r', 'p')`,
    [schema],
  );
  return result.rows.map((r) => r.relname);
}

async function monthSuffix(offset: number): Promise<string> {
  const result = await owner.query<{ ym: string }>(
    `SELECT to_char(date_trunc('month', now()) + make_interval(months => $1::int), 'YYYY_MM') AS ym`,
    [offset],
  );
  return result.rows[0]!.ym;
}

describe('partitions the job creates, not the ones the migration created', () => {
  it('creates them already compliant, in the same transaction as CREATE TABLE', async () => {
    await owner.query('BEGIN');
    try {
      const beforeApp = await partitionNames('app');
      const beforePlatform = await partitionNames('platform');

      await owner.query('SELECT app.ensure_audit_partitions(18)');
      await owner.query('SELECT platform.ensure_audit_partitions(18)');

      const newApp = (await partitionNames('app')).filter((n) => !beforeApp.includes(n));
      const newPlatform = (await partitionNames('platform')).filter(
        (n) => !beforePlatform.includes(n),
      );

      // Non-vacuity: if the job created nothing, every assertion below would
      // pass over an empty set and this test would be worthless.
      assertCheckedSet({
        label: 'partitions created by the job in app',
        checked: newApp,
        minimum: 14,
        mustInclude: [`tenant_audit_log_${await monthSuffix(18)}`],
      });
      assertCheckedSet({
        label: 'partitions created by the job in platform',
        checked: newPlatform,
        minimum: 14,
        mustInclude: [`platform_audit_log_${await monthSuffix(18)}`],
      });

      const notIsolated = await owner.query<{ relname: string; reason: string }>(
        `SELECT c.relname,
                CASE WHEN c.relrowsecurity = false THEN 'no rls'
                     WHEN p.polname IS NULL THEN 'no policy'
                     WHEN p.polqual IS NULL THEN 'no USING'
                     ELSE 'no WITH CHECK' END AS reason
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_policy p ON p.polrelid = c.oid
          WHERE n.nspname = 'app' AND c.relname = ANY($1::text[])
            AND (c.relrowsecurity = false OR p.polname IS NULL
                 OR p.polqual IS NULL OR p.polwithcheck IS NULL)`,
        [newApp],
      );
      expect(notIsolated.rows).toEqual([]);

      const overPrivileged = await owner.query<{ relname: string }>(
        `SELECT n.nspname || '.' || c.relname AS relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE ((n.nspname = 'app' AND c.relname = ANY($1::text[]))
              OR (n.nspname = 'platform' AND c.relname = ANY($2::text[])))
            AND (has_table_privilege('katkitchen_app', c.oid, 'SELECT')
              OR has_table_privilege('katkitchen_app', c.oid, 'INSERT')
              OR has_table_privilege('katkitchen_app', c.oid, 'UPDATE')
              OR has_table_privilege('katkitchen_app', c.oid, 'DELETE'))`,
        [newApp, newPlatform],
      );
      expect(overPrivileged.rows.map((r) => r.relname)).toEqual([]);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});

describe('the partition job verifies its own postcondition', () => {
  it('reports a complete forward window after the migration ran', async () => {
    expect(await missingPartitionMonths(owner, 3)).toEqual([]);
  });

  it('detects a gap, so the postcondition can actually fail', async () => {
    // Without this, "no missing months" might mean the check matches nothing.
    const suffix = await monthSuffix(2);
    await owner.query('BEGIN');
    try {
      await owner.query(`DROP TABLE app.tenant_audit_log_${suffix}`);
      const missing = await missingPartitionMonths(owner, 3);
      expect(missing).toContain(`app.tenant_audit_log_${suffix}`);
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('detects a table that exists but is not attached to the parent', async () => {
    const suffix = await monthSuffix(1);
    await owner.query('BEGIN');
    try {
      // Detach but keep the table: a name-only check would call this present.
      await owner.query(
        `ALTER TABLE app.tenant_audit_log DETACH PARTITION app.tenant_audit_log_${suffix}`,
      );
      const missing = await missingPartitionMonths(owner, 3);
      expect(missing).toContain(`app.tenant_audit_log_${suffix}`);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});

describe('the application role writes through the parent, never the partition', () => {
  it('routes an insert to the correct monthly partition', async () => {
    const suffix = await monthSuffix(0);
    await app.query('BEGIN');
    try {
      // SET takes no bind parameters; set_config(..., true) is SET LOCAL.
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [PROBE_TENANT]);
      await app.query(
        `INSERT INTO platform.tenant (id, slug, name, default_currency, tax_jurisdiction)
         VALUES ($1, 'partition-probe', 'Partition Probe', 'INR', 'IN')`,
        [PROBE_TENANT],
      );

      const inserted = await app.query<{ partition: string }>(
        `INSERT INTO app.tenant_audit_log
           (id, tenant_id, actor_kind, actor_system_job, actor_name, action, target_type, request_id)
         VALUES (gen_random_uuid(), $1, 'system', 'partition_probe', 'probe', 'probe.write', 'probe', 'req-probe')
         RETURNING tableoid::regclass::text AS partition`,
        [PROBE_TENANT],
      );

      // Belt-and-braces revokes on partitions are exactly where routed inserts
      // break, and the failure would be invisible until the first audited write.
      expect(inserted.rows[0]?.partition).toBe(`tenant_audit_log_${suffix}`);
      expect(inserted.rows[0]?.partition).not.toContain('default');

      const readBack = await app.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM app.tenant_audit_log WHERE tenant_id = $1`,
        [PROBE_TENANT],
      );
      expect(Number(readBack.rows[0]?.count ?? '0')).toBe(1);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('cannot name a partition directly, even with a valid tenant context', async () => {
    // The tenant context has to be set to make this assertion mean anything.
    // Without it the policy function raises "app.tenant_id is not set" first, so
    // the query is refused for the wrong reason and the revoke goes untested.
    const suffix = await monthSuffix(0);
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [PROBE_TENANT]);
      await expect(
        app.query(`SELECT 1 FROM app.tenant_audit_log_${suffix}`),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('is refused for lack of context when no tenant is set', async () => {
    // The other half: outside a tenant transaction the refusal is the loud
    // 28000, never a silent empty result.
    await expect(app.query('SELECT 1 FROM app.tenant_audit_log')).rejects.toThrow(
      /app\.tenant_id is not set/i,
    );
  });
});
