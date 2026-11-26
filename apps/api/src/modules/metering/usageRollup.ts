import { pathToFileURL } from 'node:url';
import pg from 'pg';

/**
 * The daily usage rollup.
 *
 * ###########################################################################
 * THIS IS THE ONLY THING THAT CROSSES THE PLANE BOUNDARY UPWARD.
 *
 * Entitlements flow DOWN as a cached document; usage flows UP as daily
 * aggregates, and this job is the whole of that second direction. The control
 * plane reads `platform.usage_counter`; it never queries `app.sales_order`.
 *
 * What makes that mechanical rather than a convention is the SHAPE of the
 * destination: usage_counter holds a tenant, a declared metric name, a date and
 * an integer. There is no column an item name, a customer or a row id could
 * travel in. A leak would require a migration, not a mistake.
 * ###########################################################################
 *
 * It runs as katkitchen_app with the tenant GUC set PER TENANT, not as the owner.
 * The owner is exempt from RLS, so an owner-run rollup with a wrong predicate
 * would silently aggregate two tenants into one number. Under RLS the worst a
 * bug can do is count nothing.
 */

export type MetricKind = 'level' | 'flow';

export interface MetricDefinition {
  readonly metric: string;
  readonly kind: MetricKind;
  /**
   * Reads under the tenant GUC. Returns one non-negative integer.
   *
   * A LEVEL is "as of the end of the date"; a FLOW is "during the date".
   */
  readonly sql: string;
}

/**
 * `storage_bytes` is the sum of `pg_column_size` over the tenant's own rows in
 * the largest tables. It is an approximation of LOGICAL row size and excludes
 * indexes, TOAST overhead and free space -- stated here because a number called
 * "storage" that silently means something else is worse than no number.
 *
 * It is a full scan per tenant, which is affordable once a day and would not be
 * affordable per request. If it becomes a problem the answer is sampling, not
 * moving it onto the hot path.
 */
// ENUMERATED-LIST-OK: WHICH tables count toward a tenant's storage is a
// judgement, not a fact the schema knows. Summing every app table would make the
// figure dominated by whatever grows fastest and change meaning as the schema
// does; these five are the ones a tenant's own volume drives. Deriving it from
// information_schema would produce a number nobody could explain to a customer.
const STORAGE_TABLES = [
  'app.tenant_audit_log', 'app.order_line', 'app.stock_movement',
  'app.bill_line', 'app.kot_line',
] as const;

export const METRICS: readonly MetricDefinition[] = [
  {
    metric: 'branches',
    kind: 'level',
    sql: `SELECT count(*)::bigint AS value FROM app.branch WHERE status = 'active'`,
  },
  {
    metric: 'users',
    kind: 'level',
    sql: `SELECT count(*)::bigint AS value FROM app.app_user WHERE status = 'active'`,
  },
  {
    metric: 'orders.created',
    kind: 'flow',
    // ON the date, not up to it. Business date, never calendar date: a rollup
    // that splits Friday night at midnight disagrees with every sales report.
    sql: `SELECT count(*)::bigint AS value FROM app.sales_order
           WHERE business_date = $1::date AND status <> 'cancelled'`,
  },
  {
    // The print failure RATE reaches platform System health as two integers,
    // through the one channel anything crosses the boundary on. System health
    // never reads app.print_job: per-job detail is the BRANCH's screen, because a
    // superadmin cannot walk over and change the paper.
    metric: 'print.jobs.total',
    kind: 'flow',
    sql: `SELECT count(*)::bigint AS value FROM app.print_job
           WHERE created_at >= $1::date AND created_at < ($1::date + 1)`,
  },
  {
    metric: 'print.jobs.failed',
    kind: 'flow',
    sql: `SELECT count(*)::bigint AS value FROM app.print_job
           WHERE status = 'failed'
             AND created_at >= $1::date AND created_at < ($1::date + 1)`,
  },
  {
    metric: 'storage_bytes',
    kind: 'level',
    sql: STORAGE_TABLES
      .map((t) => `SELECT COALESCE(sum(pg_column_size(x.*)), 0)::bigint AS v FROM ${t} x`)
      .reduce((a, b) => `${a} UNION ALL ${b}`),
  },
];

export interface RollupResult {
  readonly asOfDate: string;
  readonly tenantsProcessed: number;
  readonly rowsWritten: number;
  readonly failures: readonly { tenantId: string; metric: string; error: string }[];
}

export class RollupIncompleteError extends Error {
  readonly code = 'rollup_incomplete';
  constructor(readonly missing: readonly string[]) {
    super(
      `usage rollup did not produce a complete period: ${missing.length} tenant/metric ` +
        `pair(s) missing (${missing.slice(0, 5).join(', ')}). A job that exits 0 having ` +
        'done nothing is indistinguishable from one that worked.',
    );
    this.name = 'RollupIncompleteError';
  }
}

async function activeTenants(
  client: pg.ClientBase,
  only?: readonly string[],
): Promise<readonly string[]> {
  const result = await client.query<{ id: string }>(
    // A purged tenant has nothing left to meter. Everything on the ladder still
    // does: a hard-locked tenant still has branches, and a downgrade check
    // against a stale count would be wrong in the dangerous direction.
    `SELECT id FROM platform.tenant
      WHERE status <> 'purged' AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
      ORDER BY id`,
    [only ?? null],
  );
  return result.rows.map((r) => r.id);
}

/**
 * Idempotent by upsert on the primary key, so a retried run recomputes rather
 * than double-counting. That matters more for a flow than a level: re-adding a
 * day's orders to itself is invisible in the number.
 */
export async function rollUpUsage(
  client: pg.ClientBase,
  /** `tenantIds` scopes a backfill to named tenants; omitted, it does all of them. */
  params: { asOfDate: string; tenantIds?: readonly string[] },
): Promise<RollupResult> {
  const tenants = await activeTenants(client, params.tenantIds);
  const failures: { tenantId: string; metric: string; error: string }[] = [];
  let rowsWritten = 0;

  for (const tenantId of tenants) {
    for (const definition of METRICS) {
      await client.query('BEGIN');
      try {
        // Per tenant, under RLS. The GUC is the only thing scoping these reads,
        // which is why the job runs as the application role and not the owner.
        await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);

        const measured = await client.query<{ value: string }>(
          definition.metric === 'storage_bytes'
            ? `SELECT COALESCE(sum(v), 0)::bigint AS value FROM (${definition.sql}) totals`
            : definition.sql,
          definition.sql.includes('$1') ? [params.asOfDate] : [],
        );

        await client.query(
          `INSERT INTO platform.usage_counter
             (tenant_id, metric, metric_kind, as_of_date, value, recorded_at)
           VALUES ($1, $2, $3, $4::date, $5, now())
           ON CONFLICT (tenant_id, metric, as_of_date)
           DO UPDATE SET value = EXCLUDED.value, recorded_at = now()`,
          [tenantId, definition.metric, definition.kind, params.asOfDate,
           measured.rows[0]!.value],
        );
        await client.query('COMMIT');
        rowsWritten += 1;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        // One tenant's failure must not abandon the rest: a rollup that stops at
        // the first bad tenant leaves every later tenant's quota check reading a
        // stale number, which is the failure this job exists to prevent.
        failures.push({
          tenantId, metric: definition.metric,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    asOfDate: params.asOfDate,
    tenantsProcessed: tenants.length,
    rowsWritten,
    failures,
  };
}

/**
 * The postcondition, asserted against the DATABASE rather than against what the
 * loop believes it did.
 *
 * Same shape as the partition job: a job that exits 0 having done nothing is
 * indistinguishable from a job that worked, so it verifies the state it was
 * supposed to produce and exits non-zero if that state is absent.
 */
export async function verifyRollup(
  client: pg.ClientBase,
  params: { asOfDate: string; tenantIds?: readonly string[] },
): Promise<readonly string[]> {
  const expected = await client.query<{ tenant_id: string; metric: string }>(
    `SELECT t.id AS tenant_id, m.metric
       FROM platform.tenant t
       CROSS JOIN platform.usage_metric m
      WHERE t.status <> 'purged'
        AND ($2::uuid[] IS NULL OR t.id = ANY($2::uuid[]))
        AND NOT EXISTS (
          SELECT 1 FROM platform.usage_counter c
           WHERE c.tenant_id = t.id AND c.metric = m.metric AND c.as_of_date = $1::date)
      ORDER BY t.id, m.metric`,
    [params.asOfDate, params.tenantIds ?? null],
  );
  return expected.rows.map((r) => `${r.tenant_id}:${r.metric}`);
}

export async function main(): Promise<void> {
  // The APP role, deliberately. Running the rollup as the owner would exempt it
  // from RLS and let a predicate bug merge two tenants into one number.
  const url = process.env['DATABASE_URL_APP'];
  if (!url) throw new Error('DATABASE_URL_APP is required: the rollup runs as katkitchen_app');

  const asOfDate = process.argv[2]
    ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await rollUpUsage(client, { asOfDate });
    console.log(
      `usage rollup ${asOfDate}: ${result.rowsWritten} row(s) across ` +
        `${result.tenantsProcessed} tenant(s)`,
    );

    for (const failure of result.failures) {
      console.error(`FAILED ${failure.tenantId} ${failure.metric}: ${failure.error}`);
    }

    const missing = await verifyRollup(client, { asOfDate });
    if (missing.length > 0) {
      console.error(new RollupIncompleteError(missing).message);
      process.exitCode = 1;
      return;
    }
    if (result.failures.length > 0) {
      process.exitCode = 1;
      return;
    }
    console.log(`verified: every active tenant has every metric for ${asOfDate}`);
  } finally {
    await client.end();
  }
}

// pathToFileURL, not string interpolation: on Windows argv[1] is a drive path, so
// `file://${argv[1]}` never matches import.meta.url and the job silently does
// nothing.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
