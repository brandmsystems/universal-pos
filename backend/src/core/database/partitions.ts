import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { env } from '../../config/env.js';

interface AuditTarget {
  schema: 'platform' | 'app';
  parent: string;
}

const TARGETS: readonly AuditTarget[] = [
  { schema: 'platform', parent: 'platform_audit_log' },
  { schema: 'app', parent: 'tenant_audit_log' },
];

/**
 * Must connect as katkitchen_owner. ALTER DEFAULT PRIVILEGES only affects
 * objects created afterward *by that role*, so a partition created by any other
 * role lands with no grants applied and the append-only revokes silently do not
 * take effect.
 */
export async function ensureAuditPartitions(
  client: pg.ClientBase,
  monthsAhead: number,
): Promise<{ platform: number; app: number }> {
  const platform = await client.query<{ ensure_audit_partitions: number }>(
    'SELECT platform.ensure_audit_partitions($1)',
    [monthsAhead],
  );
  const app = await client.query<{ ensure_audit_partitions: number }>(
    'SELECT app.ensure_audit_partitions($1)',
    [monthsAhead],
  );
  return {
    platform: platform.rows[0]?.ensure_audit_partitions ?? 0,
    app: app.rows[0]?.ensure_audit_partitions ?? 0,
  };
}

/**
 * One month, addressed explicitly, including a month in the past.
 *
 * The forward-window job cannot reach backwards, so anything that legitimately
 * writes a backdated audit row -- the exception report's baseline fixtures are
 * the case -- would otherwise land it in the DEFAULT partition. A permanently
 * dirty default means the "non-empty default = the job has stopped" alert can
 * never be exercised honestly, and the first real firing gets dismissed as the
 * known noise.
 *
 * Must connect as katkitchen_owner, for the same grant-propagation reason as
 * `ensureAuditPartitions`.
 */
export async function ensureAuditPartitionFor(
  client: pg.ClientBase,
  when: Date | string,
): Promise<{ platform: boolean; app: boolean }> {
  const platform = await client.query<{ ensure_audit_partition_for: boolean }>(
    'SELECT platform.ensure_audit_partition_for($1::timestamptz)',
    [when],
  );
  const app = await client.query<{ ensure_audit_partition_for: boolean }>(
    'SELECT app.ensure_audit_partition_for($1::timestamptz)',
    [when],
  );
  return {
    platform: platform.rows[0]?.ensure_audit_partition_for ?? false,
    app: app.rows[0]?.ensure_audit_partition_for ?? false,
  };
}

/**
 * The positive postcondition. Exiting 0 having done nothing is indistinguishable
 * from working, so the job proves the window it was supposed to produce actually
 * exists rather than merely reporting no error.
 *
 * Months are derived from the database's now(), not the process clock, so this
 * asks about the same window the job just built. Joining pg_inherits closes the
 * case where a table of the right name exists but is not attached to the right
 * parent.
 */
export async function missingPartitionMonths(
  client: pg.ClientBase,
  monthsAhead: number,
): Promise<string[]> {
  const missing: string[] = [];

  for (const target of TARGETS) {
    const result = await client.query<{ missing: string }>(
      `WITH months AS (
         SELECT to_char(date_trunc('month', now()) + make_interval(months => g), 'YYYY_MM') AS ym
           FROM generate_series(0, $1::int) AS g
       ),
       present AS (
         SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_inherits i ON i.inhrelid = c.oid
           JOIN pg_class p ON p.oid = i.inhparent
           JOIN pg_namespace pn ON pn.oid = p.relnamespace
          WHERE n.nspname = $2 AND pn.nspname = $2 AND p.relname = $3
       )
       SELECT $3 || '_' || m.ym AS missing
         FROM months m
        WHERE NOT EXISTS (SELECT 1 FROM present WHERE relname = $3 || '_' || m.ym)
        ORDER BY 1`,
      [monthsAhead, target.schema, target.parent],
    );
    missing.push(...result.rows.map((r) => `${target.schema}.${r.missing}`));
  }

  return missing;
}

/**
 * A non-empty DEFAULT partition means the job stopped and rows are landing
 * outside their month. Recovery is move-then-attach, not attach: ATTACH
 * PARTITION fails while the default holds rows in the new range.
 */
export async function defaultPartitionCounts(
  client: pg.ClientBase,
): Promise<{ platform: number; app: number }> {
  const platform = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM platform.platform_audit_log_default',
  );
  const app = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM app.tenant_audit_log_default',
  );
  return {
    platform: Number(platform.rows[0]?.count ?? '0'),
    app: Number(app.rows[0]?.count ?? '0'),
  };
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: env.ownerDatabaseUrl() });
  await client.connect();

  try {
    const monthsAhead = env.auditPartitionMonthsAhead();

    await client.query('BEGIN');
    const created = await ensureAuditPartitions(client, monthsAhead);
    await client.query('COMMIT');
    console.log(
      `partitions created: platform=${created.platform} app=${created.app} (${monthsAhead} months ahead)`,
    );

    const missing = await missingPartitionMonths(client, monthsAhead);
    if (missing.length > 0) {
      console.error(
        `partition window incomplete after running. Missing:\n  ${missing.join('\n  ')}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`verified: ${monthsAhead + 1} months present for both audit tables`);

    const stranded = await defaultPartitionCounts(client);
    if (stranded.platform > 0 || stranded.app > 0) {
      console.error(
        `DEFAULT partition is not empty (platform=${stranded.platform} app=${stranded.app}). ` +
          `The partition job has been failing. Recover with scripts/recover-default-audit-partition.mts (--dry-run first).`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

// pathToFileURL, not string interpolation: on Windows argv[1] is a drive path,
// so `file://${argv[1]}` never matches import.meta.url and the job silently
// does nothing.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
