import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../database/tenantContext.js';
import { hasFeature, type EntitlementDocument } from '../platform/entitlements.js';

/**
 * Stock deduction, driven by the KOT.
 *
 * Rule 1 of the domain rules: stock deducts at KOT confirm, not at payment. The
 * kitchen consumed the ingredients when it started cooking, so a void or a comp
 * after the fire does not give them back -- and this module offers no way to
 * express that it does. The only reversal-shaped operation in the system is
 * `waste`, which is a second loss rather than the cancellation of a first.
 *
 * Deduction reads recipe_version_expansion, never the recipe tree: the tree was
 * flattened at publish, so a fire is a small number of integer multiplies rather
 * than a recursive traversal on the hot path.
 */

export interface DeductionLine {
  readonly productId: string;
  readonly qtyBase: number;
  readonly recipeVersionId: string;
}

export interface DeductionResult {
  readonly kotId: string;
  readonly applied: boolean;
  readonly lines: readonly DeductionLine[];
  readonly skippedReason?: 'already_applied' | 'inventory_not_entitled';
}

/**
 * The consumer inner-joins the expansion, so a published version with lines but
 * no expansion rows would deduct nothing and report success. Silence is the worst
 * available failure here: the food goes out, stock never moves, and the only
 * symptom is a variance report that slowly stops making sense. Publishing already
 * refuses to create this state; this is the second door.
 */
export class MissingExpansionError extends Error {
  readonly statusCode = 500;
  readonly code = 'missing_expansion';
  constructor(readonly versionIds: readonly string[]) {
    super(
      `recipe version(s) ${versionIds.join(', ')} are published but have no flattened ` +
        'expansion; deduction would silently move no stock.',
    );
    this.name = 'MissingExpansionError';
  }
}

export class UnrecipedFireError extends Error {
  readonly statusCode = 422;
  readonly code = 'unreciped_fire';
  constructor(readonly names: readonly string[]) {
    super(
      `cannot deduct: ${names.join(', ')} has no published recipe. ` +
        'Listing should have blocked this; a fire reaching here means the entitlement ' +
        'was enabled after the item was listed.',
    );
    this.name = 'UnrecipedFireError';
  }
}

/**
 * Idempotent on the KOT.
 *
 * The dedupe key is per (kot, product) because the unique constraint is on a
 * single column and one KOT deducts many products. The pre-check makes the retry
 * cheap; the unique index is what makes it correct, because two workers can pass
 * the pre-check simultaneously.
 */
export async function deductForKot(
  context: TenantContext,
  params: {
    kotId: string;
    entitlement: EntitlementDocument;
    actorUserId?: string | null;
    /** Off by default: a tenant without published recipes must not have its fires blocked. */
    strict?: boolean;
  },
): Promise<DeductionResult> {
  if (!hasFeature(params.entitlement, 'inventory')) {
    return { kotId: params.kotId, applied: false, lines: [], skippedReason: 'inventory_not_entitled' };
  }

  const existing = await context.client.query(
    `SELECT 1 FROM app.stock_movement
      WHERE tenant_id = $1 AND source_kot_id = $2 AND kind = 'consumption' LIMIT 1`,
    [context.tenantId, params.kotId],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    return { kotId: params.kotId, applied: false, lines: [], skippedReason: 'already_applied' };
  }

  const head = await context.client.query<{ branch_id: string; business_date: string }>(
    `SELECT branch_id, business_date::text AS business_date
       FROM app.kot WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, params.kotId],
  );
  const kot = head.rows[0];
  if (!kot) throw new Error(`kot ${params.kotId} not found`);

  if (params.strict) {
    const gaps = await context.client.query<{ name: string }>(
      `SELECT DISTINCT kl.name_snapshot AS name
         FROM app.kot_line kl
         JOIN app.order_line ol ON ol.tenant_id = kl.tenant_id AND ol.id = kl.order_line_id
         LEFT JOIN app.recipe r
           ON r.tenant_id = kl.tenant_id AND r.status = 'active'
          AND ((kl.source = 'item'     AND r.menu_item_id = ol.menu_item_id)
            OR (kl.source = 'modifier' AND r.modifier_option_id = kl.modifier_option_id))
         LEFT JOIN app.recipe_version rv
           ON rv.tenant_id = r.tenant_id AND rv.recipe_id = r.id AND rv.status = 'published'
        WHERE kl.tenant_id = $1 AND kl.kot_id = $2 AND rv.id IS NULL`,
      [context.tenantId, params.kotId],
    );
    if (gaps.rowCount && gaps.rowCount > 0) {
      throw new UnrecipedFireError(gaps.rows.map((r) => r.name));
    }
  }

  // A resolved version with no expansion rows deducts nothing through the inner
  // join below. Raise rather than no-op.
  const unexpanded = await context.client.query<{ id: string }>(
    `SELECT DISTINCT rv.id
       FROM app.kot_line kl
       JOIN app.order_line ol ON ol.tenant_id = kl.tenant_id AND ol.id = kl.order_line_id
       JOIN app.recipe r
         ON r.tenant_id = kl.tenant_id AND r.status = 'active'
        AND ((kl.source = 'item'     AND r.menu_item_id = ol.menu_item_id)
          OR (kl.source = 'modifier' AND r.modifier_option_id = kl.modifier_option_id))
       JOIN app.recipe_version rv
         ON rv.tenant_id = r.tenant_id AND rv.recipe_id = r.id AND rv.status = 'published'
      WHERE kl.tenant_id = $1 AND kl.kot_id = $2 AND kl.state <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM app.recipe_version_expansion e
                         WHERE e.tenant_id = rv.tenant_id AND e.recipe_version_id = rv.id)`,
    [context.tenantId, params.kotId],
  );
  if (unexpanded.rowCount && unexpanded.rowCount > 0) {
    throw new MissingExpansionError(unexpanded.rows.map((r) => r.id));
  }

  // One row per product: a dish and its modifier can both consume onion, and two
  // movements for the same product on one ticket is noise in every report that
  // reads this table.
  const demand = await context.client.query<{
    product_id: string;
    qty_base: string;
    recipe_version_id: string;
  }>(
    `SELECT e.product_id,
            SUM(e.consumed_base * kl.quantity)::text AS qty_base,
            MIN(rv.id::text)                         AS recipe_version_id
       FROM app.kot_line kl
       JOIN app.order_line ol ON ol.tenant_id = kl.tenant_id AND ol.id = kl.order_line_id
       JOIN app.recipe r
         ON r.tenant_id = kl.tenant_id AND r.status = 'active'
        AND ((kl.source = 'item'     AND r.menu_item_id = ol.menu_item_id)
          OR (kl.source = 'modifier' AND r.modifier_option_id = kl.modifier_option_id))
       JOIN app.recipe_version rv
         ON rv.tenant_id = r.tenant_id AND rv.recipe_id = r.id AND rv.status = 'published'
       JOIN app.recipe_version_expansion e
         ON e.tenant_id = rv.tenant_id AND e.recipe_version_id = rv.id
      WHERE kl.tenant_id = $1 AND kl.kot_id = $2 AND kl.state <> 'cancelled'
      GROUP BY e.product_id`,
    [context.tenantId, params.kotId],
  );

  const lines: DeductionLine[] = [];
  for (const row of demand.rows) {
    const qty = Number(row.qty_base);
    if (qty <= 0) continue;

    await context.client.query('SAVEPOINT deduct_line');
    try {
      await context.client.query(
        `INSERT INTO app.stock_movement
           (id, tenant_id, branch_id, product_id, business_date, kind, qty_base,
            dedupe_key, source_kot_id, recipe_version_id, actor_user_id)
         VALUES ($1, $2, $3, $4, $5::date, 'consumption', $6, $7, $8, $9, $10)`,
        [
          randomUUID(), context.tenantId, kot.branch_id, row.product_id, kot.business_date,
          -qty, `kot:${params.kotId}:${row.product_id}`, params.kotId,
          row.recipe_version_id, params.actorUserId ?? null,
        ],
      );
      await context.client.query('RELEASE SAVEPOINT deduct_line');
      lines.push({ productId: row.product_id, qtyBase: qty, recipeVersionId: row.recipe_version_id });
    } catch (error) {
      await context.client.query('ROLLBACK TO SAVEPOINT deduct_line');
      // 23505: another worker got there first. That is the mechanism working.
      if ((error as { code?: string }).code !== '23505') throw error;
    }
  }

  return { kotId: params.kotId, applied: lines.length > 0, lines };
}
