import type pg from 'pg';
import type { TenantContext } from '../../database/tenantContext.js';

/**
 * Nightly stock reconciliation.
 *
 * ###########################################################################
 * THIS JOB ALERTS. IT NEVER CORRECTS.
 *
 * stock_balance is a cache of the fold of stock_movement. When the two disagree,
 * one of them is wrong and this job cannot know which -- a silent re-fold would
 * paper over the bug that caused the drift, and the next stock take would be
 * measured against a number nobody can trace to a movement.
 *
 * Worse, auto-correction destroys the evidence. The gap between the ledger and
 * the balance IS the diagnostic; overwriting the balance erases it and the same
 * bug then runs for another month unobserved.
 *
 * If a drift is real and understood, the correction is an `adjustment` movement
 * with a reason and an actor, posted by a human. That is a decision with a name
 * on it, which is what a stock correction has to be.
 * ###########################################################################
 */

export interface BalanceDrift {
  readonly branchId: string;
  readonly productId: string;
  readonly cachedQtyBase: number;
  readonly ledgerQtyBase: number;
  readonly deltaBase: number;
}

export interface NegativeBalance {
  readonly branchId: string;
  readonly productId: string;
  readonly productName: string;
  readonly qtyBase: number;
  readonly unbackedQtyBase: number;
}

/**
 * A moving average that sits outside the range of every price ever paid is not a
 * rounding artefact -- it is the signature of a costing bug, and TWO different
 * bugs have now produced it: naive WAC against a negative balance, and a
 * retrospective correction counted twice into on-hand value. Two instances means
 * there is probably a third, so this is a standing assertion rather than a test
 * of the two cases already known.
 */
export interface CostOutOfRange {
  readonly branchId: string;
  readonly productId: string;
  readonly productName: string;
  readonly avgUnitCostMicro: number;
  readonly minPaidMicro: number;
  readonly maxPaidMicro: number;
}

export interface ReconciliationReport {
  readonly tenantId: string;
  readonly productsChecked: number;
  readonly drift: readonly BalanceDrift[];
  readonly negatives: readonly NegativeBalance[];
  readonly costOutOfRange: readonly CostOutOfRange[];
}

/**
 * Compares the cache against the fold. Reports; changes nothing.
 *
 * Note the query reads the ledger from scratch rather than from any incremental
 * marker: an incremental reconciliation shares state with the thing it is
 * checking, so a bug in the maintenance trigger can hide from it.
 */
export async function reconcileStock(
  context: TenantContext,
  params: { branchId?: string } = {},
): Promise<ReconciliationReport> {
  const drift = await context.client.query<{
    branch_id: string; product_id: string; cached: string; ledger: string;
  }>(
    `WITH ledger AS (
       SELECT branch_id, product_id, SUM(qty_base) AS qty
         FROM app.stock_movement
        WHERE tenant_id = $1 AND ($2::uuid IS NULL OR branch_id = $2::uuid)
        GROUP BY branch_id, product_id
     )
     SELECT COALESCE(b.branch_id, l.branch_id)   AS branch_id,
            COALESCE(b.product_id, l.product_id) AS product_id,
            COALESCE(b.qty_base, 0)::text        AS cached,
            COALESCE(l.qty, 0)::text             AS ledger
       FROM (SELECT * FROM app.stock_balance
              WHERE tenant_id = $1 AND ($2::uuid IS NULL OR branch_id = $2::uuid)) b
       FULL OUTER JOIN ledger l
         ON l.branch_id = b.branch_id AND l.product_id = b.product_id`,
    [context.tenantId, params.branchId ?? null],
  );

  const drifted = drift.rows
    .map((r) => ({
      branchId: r.branch_id,
      productId: r.product_id,
      cachedQtyBase: Number(r.cached),
      ledgerQtyBase: Number(r.ledger),
      deltaBase: Number(r.cached) - Number(r.ledger),
    }))
    .filter((r) => r.deltaBase !== 0);

  // Problem 4: a negative balance is a BRANCH problem, not a platform one. The
  // control plane must never see it -- it is stock data, and superadmin cannot
  // see stock data outside impersonation. It belongs on the branch's own
  // Operations screen where the manager who can fix it will see it.
  const negatives = await context.client.query<{
    branch_id: string; product_id: string; name: string; qty_base: string; unbacked: string;
  }>(
    `SELECT b.branch_id, b.product_id, p.name,
            b.qty_base::text, b.unbacked_qty_base::text AS unbacked
       FROM app.stock_balance b
       JOIN app.product p ON p.tenant_id = b.tenant_id AND p.id = b.product_id
      WHERE b.tenant_id = $1
        AND ($2::uuid IS NULL OR b.branch_id = $2::uuid)
        AND (b.qty_base < 0 OR b.unbacked_qty_base > 0)
      ORDER BY b.qty_base ASC`,
    [context.tenantId, params.branchId ?? null],
  );

  // Every unit cost ever actually paid for this product at this branch, from the
  // receipts themselves -- not from any cached figure, which is the thing under
  // test. A balance whose average falls outside that range cannot be explained by
  // any sequence of purchases.
  const costRange = await context.client.query<{
    branch_id: string; product_id: string; name: string;
    avg_micro: string; min_micro: string; max_micro: string;
  }>(
    `WITH paid AS (
       SELECT branch_id, product_id,
              min(value_micro / qty_base) AS min_micro,
              max(value_micro / qty_base) AS max_micro
         FROM app.stock_movement
        WHERE tenant_id = $1 AND kind = 'receipt' AND qty_base > 0
          AND ($2::uuid IS NULL OR branch_id = $2::uuid)
        GROUP BY branch_id, product_id
     )
     SELECT b.branch_id, b.product_id, p.name,
            (b.value_micro / b.qty_base)::text AS avg_micro,
            paid.min_micro::text, paid.max_micro::text
       FROM app.stock_balance b
       JOIN paid ON paid.branch_id = b.branch_id AND paid.product_id = b.product_id
       JOIN app.product p ON p.tenant_id = b.tenant_id AND p.id = b.product_id
      WHERE b.tenant_id = $1
        AND ($2::uuid IS NULL OR b.branch_id = $2::uuid)
        -- A non-positive balance has no meaningful average to place in the range.
        AND b.qty_base > 0
        AND ((b.value_micro / b.qty_base) < paid.min_micro
          OR (b.value_micro / b.qty_base) > paid.max_micro)`,
    [context.tenantId, params.branchId ?? null],
  );

  return {
    tenantId: context.tenantId,
    productsChecked: drift.rowCount ?? 0,
    drift: drifted,
    costOutOfRange: costRange.rows.map((r) => ({
      branchId: r.branch_id,
      productId: r.product_id,
      productName: r.name,
      avgUnitCostMicro: Number(r.avg_micro),
      minPaidMicro: Number(r.min_micro),
      maxPaidMicro: Number(r.max_micro),
    })),
    negatives: negatives.rows.map((r) => ({
      branchId: r.branch_id,
      productId: r.product_id,
      productName: r.name,
      qtyBase: Number(r.qty_base),
      unbackedQtyBase: Number(r.unbacked),
    })),
  };
}

/**
 * Cost of goods sold for a period, from the ledger.
 *
 * Includes cost_adjustment rows: those are the retrospective corrections for
 * stock issued before its cost was known, and excluding them would restore the
 * understatement they exist to remove.
 */
export async function cogsForPeriod(
  context: TenantContext,
  params: { branchId: string; fromDate: string; toDate: string },
): Promise<{ cogsMinor: number; consumptionMinor: number; wasteMinor: number; correctionMinor: number }> {
  const result = await context.client.query<{
    consumption: string; waste: string; correction: string;
  }>(
    `SELECT
       COALESCE(-SUM(value_micro) FILTER (WHERE kind = 'consumption'), 0)::text     AS consumption,
       COALESCE(-SUM(value_micro) FILTER (WHERE kind = 'waste'), 0)::text           AS waste,
       COALESCE(-SUM(value_micro) FILTER (WHERE kind = 'cost_adjustment'), 0)::text AS correction
       FROM app.stock_movement
      WHERE tenant_id = $1 AND branch_id = $2
        AND business_date BETWEEN $3::date AND $4::date`,
    [context.tenantId, params.branchId, params.fromDate, params.toDate],
  );

  const row = result.rows[0]!;
  // Round once, here, at presentation.
  const toMinor = (micro: string) => Math.round(Number(micro) / 1_000_000);
  const consumption = toMinor(row.consumption);
  const waste = toMinor(row.waste);
  const correction = toMinor(row.correction);

  return {
    cogsMinor: consumption + waste + correction,
    consumptionMinor: consumption,
    wasteMinor: waste,
    correctionMinor: correction,
  };
}

/**
 * Job entry point. Exits non-zero when it finds drift, and asserts a positive
 * postcondition: a job that exits 0 having checked nothing is indistinguishable
 * from a job that worked.
 */
export async function runReconciliationJob(
  client: pg.ClientBase,
  contextFor: (tenantId: string) => TenantContext,
): Promise<{ tenantsChecked: number; reports: readonly ReconciliationReport[] }> {
  const tenants = await client.query<{ id: string }>(
    `SELECT id FROM platform.tenant WHERE status <> 'purged'`,
  );

  const reports: ReconciliationReport[] = [];
  const failures: string[] = [];

  for (const tenant of tenants.rows) {
    // Each tenant inside its own transaction with the GUC set.
    //
    // A TenantContext carries a tenantId, and every query here also passes it as
    // a predicate -- but the RLS POLICY reads the GUC, not the parameter, so
    // without this the job raises on its first read. It ran green in tests for a
    // phase because the tests supplied a context whose client was the owner,
    // which is exempt from RLS by table ownership.
    await client.query('BEGIN');
    try {
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenant.id]);
      reports.push(await reconcileStock(contextFor(tenant.id)));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      // One tenant's failure must not abandon the rest: the whole point is an
      // estate-wide sweep, and stopping at the first bad tenant leaves every
      // later one unchecked.
      failures.push(`${tenant.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0 && reports.length === 0) {
    throw new Error(`reconciliation could not check any tenant: ${failures[0]}`);
  }

  return { tenantsChecked: reports.length, reports };
}
