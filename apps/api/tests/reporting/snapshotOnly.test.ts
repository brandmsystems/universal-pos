import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

/**
 * ###########################################################################
 * EVERY REPORT READS SNAPSHOTS. NOTHING RECOMPUTES FROM CURRENT CONFIGURATION.
 *
 * This is the payoff for every snapshot decision made since Phase 2, and it is
 * the single rule that makes a report from last March still true today. A report
 * that dereferences a catalogue price, a live recipe, a current tax rate or a
 * current plan price produces a figure that changes underneath the person who
 * printed it -- and they will not know it changed.
 *
 * Written BEFORE the reports existed, so it constrained them rather than being
 * retrofitted around whatever got built.
 * ###########################################################################
 *
 * ####################### WHY THIS IS AN ALLOWLIST #########################
 * A blocklist of forbidden tables FAILS OPEN. Phase 6 adds a promotion table
 * with discount_price_minor, nobody thinks to edit this file, and a report reads
 * live promotional pricing while every test stays green. That is the same shape
 * as OWNER_WITHHELD and the APP_TABLE regex: a hand-maintained list sitting next
 * to something derived, agreeing with it today and silently diverging tomorrow.
 *
 * So the table gate is inverted. A reporting module may read the tables named
 * here and NOTHING ELSE -- a new table is denied until someone justifies it in
 * this file, which is the same direction as a new permission key defaulting
 * deny.
 * ##########################################################################
 */

/** Raise deliberately with each module added. An exact count: a floor is vacuous. */
const EXPECTED_REPORTING_MODULES = 5;

const REPORTING_DIR = 'src/modules/reporting';

type TableRole =
  /** Written once, never dereferenced again. The figures a report is allowed to use. */
  | 'snapshot'
  /** Joined for a NAME or an id only. Money columns on these are caught below. */
  | 'label'
  /** Immutable data seeded by migration; it cannot move under a finished report. */
  | 'reference';

const ALLOWED_TABLES: ReadonlyArray<{ table: string; role: TableRole; why: string }> = [
  // ---- snapshots: the priced document, and the append-only ledgers ---------
  { table: 'app.sales_order', role: 'snapshot', why: 'carries business_date, stamped at open' },
  { table: 'app.order_line', role: 'snapshot', why: 'unit price, tax rate, modifiers and kind, all snapshotted at order time' },
  { table: 'app.table_session', role: 'snapshot', why: 'guest count and business date for covers' },
  { table: 'app.bill', role: 'snapshot', why: 'party identity and place of supply as they stood when raised' },
  { table: 'app.bill_line', role: 'snapshot', why: 'amount, tax and components as printed' },
  { table: 'app.tender', role: 'snapshot', why: 'what was actually taken, including manual settlements' },
  { table: 'app.refund', role: 'snapshot', why: 'a Section 34 reduction, with its own tax snapshot' },
  { table: 'app.kot', role: 'snapshot', why: 'fire timing for the kitchen reports' },
  { table: 'app.kot_line', role: 'snapshot', why: 'what each station actually received' },
  { table: 'app.stock_movement', role: 'snapshot', why: 'append-only ledger, valued at the time of the movement' },
  { table: 'app.stock_count', role: 'snapshot', why: 'the count document and its business date' },
  { table: 'app.stock_count_line', role: 'snapshot', why: 'expected_qty_base, snapshotted when the sheet was generated' },
  { table: 'app.tenant_audit_log', role: 'snapshot', why: 'append-only; the actor snapshot is the record' },
  { table: 'app.pii_access_log', role: 'snapshot', why: 'append-only, DPO audience' },
  { table: 'app.sync_quarantine', role: 'snapshot', why: 'unresolved batches are a caveat ON the variance figure' },
  { table: 'app.branch_gst_registration_change', role: 'snapshot', why: 'append-only, business-dated, and UPDATE/DELETE are revoked from katkitchen_app. The GST return reads it to REFUSE a period the branch changed position inside -- which is the opposite of recomputing from current configuration: without it the return would resolve one supplier GSTIN off app.branch and report pre-registration turnover under it' },
  { table: 'platform.platform_audit_log', role: 'snapshot', why: 'append-only, control plane' },
  { table: 'platform.invoice', role: 'snapshot', why: 'immutable once issued' },
  { table: 'platform.invoice_line', role: 'snapshot', why: 'what was charged, snapshotted' },
  { table: 'platform.invoice_tax_component', role: 'snapshot', why: 'the component split as applied' },

  // ---- labels: joined for a name, NEVER for a number ----------------------
  // CLAUDE.md is explicit that menu_item_id exists for reporting joins and is
  // never read for arithmetic. These are permitted for exactly that, and the
  // column gate below is what stops the numbers being read off them.
  { table: 'app.menu_item', role: 'label', why: 'name, category and station code; never price' },
  { table: 'app.menu_category', role: 'label', why: 'category name for the category rollup' },
  { table: 'app.branch', role: 'label', why: 'branch name for the branch dimension' },
  { table: 'app.app_user', role: 'label', why: 'actor name for the staff dimension' },
  { table: 'app.product', role: 'label', why: 'product name; never yield or cost' },
  { table: 'app.kitchen_station', role: 'label', why: 'station name for the station dimension' },
  { table: 'app.stock_reason', role: 'label', why: 'reason key, so the exception report can group by it' },
  { table: 'app.adjustment_reason', role: 'label', why: 'reason key, so the exception report can group by it' },

  // ---- reference: seeded by migration, immutable -------------------------
  { table: 'platform.permission', role: 'reference', why: 'risk_class and risk_subclass are seeded reference data; the classification of order.void does not move under a finished report' },
];

const ALLOWED_TABLE_SET = new Set(ALLOWED_TABLES.map((t) => t.table));

/**
 * The second gate, for the handful of label tables that also carry money.
 *
 * The allowlist above is the primary defence; this stops `mi.price_minor` being
 * read off a table that is legitimately joined for its name. Word boundaries do
 * the work: `\bprice_minor\b` does not match `unit_price_minor`, because the
 * preceding underscore is a word character.
 */
const FORBIDDEN_COLUMNS: ReadonlyArray<{ column: string; useInstead: string }> = [
  { column: 'price_minor', useInstead: 'order_line.unit_price_minor or bill_line.amount_minor' },
  { column: 'price_delta_minor', useInstead: 'order_line.modifiers, which snapshots the delta' },
  { column: 'rate_bps', useInstead: 'order_line.tax_rate_bps or bill_line.tax_components' },
  { column: 'yield_bps', useInstead: 'recipe_line.product_yield_bps, recorded at publish' },
  { column: 'last_unit_cost_micro', useInstead: 'stock_movement.value_micro, the cost at the time' },
];

/**
 * ################## THE IMPORT GATE, AND WHY IT EXISTS ####################
 * The table scan is LEXICAL and stops at the directory boundary. A report
 * calling `pricing.currentPrice(itemId)` reads a catalogue price and the scanner
 * sees a function call.
 *
 * So reporting/ may import only from here. Repositories and formatting yes;
 * pricing, recipe, plan, catalogue and billing modules no -- those are where the
 * live-configuration reads live, and reaching one launders a forbidden read
 * through a call the table scan cannot see.
 * ##########################################################################
 */
const ALLOWED_IMPORTS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /^node:/, why: 'standard library' },
  { pattern: /^pg$/, why: 'the driver type' },
  { pattern: /^\.\/[\w./-]+$/, why: 'sibling reporting modules' },
  { pattern: /^\.\.\/\.\.\/core\/database\/tenantContext\.js$/, why: 'the tenant context type' },
  { pattern: /^\.\.\/\.\.\/core\/database\/baseRepository\.js$/, why: 'the repository layer' },
  { pattern: /^\.\.\/\.\.\/core\/database\/unitOfWork\.js$/, why: 'transaction scoping' },
  { pattern: /^\.\.\/authz\/permissions\.js$/, why: 'permission KEYS and risk classes, not prices' },
];

/** Named explicitly so the failure message can say what was reached for. */
const FORBIDDEN_IMPORT_HINTS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /pricing/i, why: 'live pricing' },
  { pattern: /recipe/i, why: 'the live recipe' },
  { pattern: /\bplan\b|platform\/entitlements/i, why: 'current plan configuration' },
  { pattern: /catalogue|menu\//i, why: 'the live catalogue' },
  { pattern: /billing\//i, why: 'control-plane tax logic, which must never be shared' },
  { pattern: /inventory\//i, why: 'live stock and costing' },
];

export interface Violation {
  readonly file: string;
  readonly rule: 'table_not_allowlisted' | 'forbidden_column' | 'forbidden_import';
  readonly detail: string;
}

function stripComments(source: string): string {
  // Comments stripped first: a module EXPLAINING that it never reads a catalogue
  // price must not trip its own assertion. That mistake was already made once in
  // the webhook/ladder check, where the test matched prose.
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** `app.foo` used as a relation. `app.current_tenant_id(` is a function, not a table. */
function tableReferences(code: string): readonly string[] {
  const found = new Set<string>();
  const pattern = /\b(app|platform)\.([a-z_][a-z0-9_]*)\b(\s*\()?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    if (match[3]) continue; // followed by '(' -- a function call
    found.add(`${match[1]}.${match[2]}`);
  }
  return [...found];
}

function importSpecifiers(code: string): readonly string[] {
  const found = new Set<string>();
  for (const pattern of [/from\s+'([^']+)'/g, /import\s*\(\s*'([^']+)'\s*\)/g]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) found.add(match[1]!);
  }
  return [...found];
}

export function scanForNonSnapshotReads(file: string, source: string): readonly Violation[] {
  const code = stripComments(source);
  const violations: Violation[] = [];

  for (const table of tableReferences(code)) {
    if (ALLOWED_TABLE_SET.has(table)) continue;
    violations.push({
      file, rule: 'table_not_allowlisted',
      detail:
        `reads ${table}, which is not on the reporting allowlist. Reports read snapshots; ` +
        'if this table is a snapshot or a label join, add it to ALLOWED_TABLES with the ' +
        'reason. Denied until justified, deliberately -- a blocklist would have let it in.',
    });
  }

  for (const { column, useInstead } of FORBIDDEN_COLUMNS) {
    if (new RegExp(`\\b${column}\\b`).test(code)) {
      violations.push({
        file, rule: 'forbidden_column',
        detail: `reads '${column}', which is current configuration. Use ${useInstead}.`,
      });
    }
  }

  for (const specifier of importSpecifiers(code)) {
    if (ALLOWED_IMPORTS.some((a) => a.pattern.test(specifier))) continue;
    const hint = FORBIDDEN_IMPORT_HINTS.find((h) => h.pattern.test(specifier));
    violations.push({
      file, rule: 'forbidden_import',
      detail:
        `imports '${specifier}'` +
        (hint ? `, which is ${hint.why}. ` : ', which is not on the reporting import allowlist. ') +
        'The table scan is lexical: a call like pricing.currentPrice(id) reads a catalogue ' +
        'price and looks like a function call, so the import graph is gated too.',
    });
  }

  return violations;
}

function reportingModules(): readonly string[] {
  if (!existsSync(REPORTING_DIR)) return [];
  return readdirSync(REPORTING_DIR).filter((f) => f.endsWith('.ts'));
}

/* ------------------------------------------------- the scanner, proven --- */

describe('the snapshot-only scanner catches what it claims to', () => {
  // An assertion about a rule is tested against a fixture CONSTRUCTED to violate
  // it, never against production code that happens to comply.

  it('denies a table nobody has justified -- the Phase 6 promotion case', () => {
    // The exact scenario a blocklist fails open on: a table that does not exist
    // yet, added by someone who never opens this file.
    const v = scanForNonSnapshotReads('fake.ts',
      `const r = await c.query(\`SELECT p.discount_price_minor FROM app.promotion p\`);`);
    expect(v.map((x) => x.rule)).toContain('table_not_allowlisted');
    expect(v[0]!.detail).toMatch(/app\.promotion/);
  });

  it('allows the snapshot and label tables that are justified', () => {
    const v = scanForNonSnapshotReads('fake.ts',
      `SELECT ol.unit_price_minor, mi.name
         FROM app.order_line ol
         JOIN app.menu_item mi ON mi.id = ol.menu_item_id
        WHERE ol.tenant_id = app.current_tenant_id()`);
    // app.current_tenant_id() is a FUNCTION, not a table, and must not be flagged.
    expect(v).toEqual([]);
  });

  it('still denies a money column on a table joined for its name', () => {
    // menu_item is allowlisted as a LABEL. That must not make its price readable.
    const v = scanForNonSnapshotReads('fake.ts',
      `SELECT mi.price_minor FROM app.menu_item mi`);
    expect(v.map((x) => x.rule)).toEqual(['forbidden_column']);
  });

  it('does NOT catch the snapshot columns that merely look similar', () => {
    // If the scanner over-matches here it bans exactly the columns reports must
    // use, and someone deletes the scanner rather than the report.
    const v = scanForNonSnapshotReads('fake.ts',
      `SELECT ol.unit_price_minor, ol.tax_rate_bps FROM app.order_line ol`);
    expect(v).toEqual([]);
  });

  it('denies the live balance and the live catalogue by omission, not by listing them', () => {
    for (const table of ['app.stock_balance', 'app.branch_menu_price', 'app.tax_class',
                         'app.recipe_version_expansion', 'platform.plan_version']) {
      const v = scanForNonSnapshotReads('fake.ts', `SELECT 1 FROM ${table}`);
      expect(v.map((x) => x.rule), table).toContain('table_not_allowlisted');
    }
  });

  it('catches a forbidden import, which the table scan cannot see', () => {
    // The hole this closes: the call reads a catalogue price and the lexical scan
    // sees only an identifier.
    const v = scanForNonSnapshotReads('fake.ts',
      `import { currentPrice } from '../pricing/currentPrice.js';
       export async function itemSales(p: { fromDate: string }) {
         return currentPrice('x');
       }`);
    expect(v.map((x) => x.rule)).toEqual(['forbidden_import']);
    expect(v[0]!.detail).toMatch(/live pricing/);
  });

  it('names what was reached for, per forbidden area', () => {
    const cases: ReadonlyArray<[string, RegExp]> = [
      ["import { x } from '../inventory/reconcile.js';", /live stock and costing/],
      ["import { x } from '../billing/placeOfSupply.js';", /never be shared/],
      ["import { x } from '../menu/comboAllocation.js';", /live catalogue/],
      ["import { x } from '../inventory/recipes.js';", /live recipe|live stock/],
    ];
    for (const [source, expected] of cases) {
      const v = scanForNonSnapshotReads('fake.ts', source);
      expect(v.map((x) => x.rule), source).toContain('forbidden_import');
      expect(v[0]!.detail, source).toMatch(expected);
    }
  });

  it('allows the imports a report legitimately needs', () => {
    const v = scanForNonSnapshotReads('fake.ts',
      `import type { TenantContext } from '../../core/database/tenantContext.js';
       import { PERMISSIONS } from '../authz/permissions.js';
       import { REPORTS } from './registry.js';
       import { randomUUID } from 'node:crypto';`);
    expect(v).toEqual([]);
  });

  it('is not fooled by a comment mentioning the forbidden thing', () => {
    const v = scanForNonSnapshotReads('fake.ts',
      `// This report never reads price_minor from app.tax_class.
       /* nor app.recipe_line, nor ../pricing/current.js */
       const q = 'SELECT ol.unit_price_minor FROM app.order_line ol';`);
    expect(v).toEqual([]);
  });

  it('names every rule it can emit, so a silently-dropped rule is visible', () => {
    const emitted = new Set<string>();
    for (const source of [
      `SELECT 1 FROM app.promotion`,
      `SELECT price_minor FROM app.menu_item`,
      `import { x } from '../pricing/x.js';`,
    ]) {
      for (const v of scanForNonSnapshotReads('fake.ts', source)) emitted.add(v.rule);
    }
    expect([...emitted].sort()).toEqual([
      'forbidden_column', 'forbidden_import', 'table_not_allowlisted',
    ]);
  });

  it('checks a non-trivial allowlist covering every role', () => {
    const roles = new Set(ALLOWED_TABLES.map((t) => t.role));
    expect([...roles].sort()).toEqual(['label', 'reference', 'snapshot']);
    expect(ALLOWED_TABLES.length).toBeGreaterThanOrEqual(25);
    expect(ALLOWED_TABLES.every((t) => t.why.length > 10)).toBe(true);
    // Every entry justified, and no duplicates hiding a second opinion.
    expect(new Set(ALLOWED_TABLES.map((t) => t.table)).size).toBe(ALLOWED_TABLES.length);
  });
});

/* ------------------------------------------- the directory, ratcheted --- */

describe('no reporting module recomputes from current configuration', () => {
  it('holds an EXACT module count, so a new report cannot land unexamined', () => {
    const modules = reportingModules();
    expect(
      modules.length,
      `src/modules/reporting/ has ${modules.length} module(s) but EXPECTED_REPORTING_MODULES is ` +
        `${EXPECTED_REPORTING_MODULES}. Raise the constant deliberately -- it exists so a ` +
        'report cannot be added without someone reading the snapshot-only rule.',
    ).toBe(EXPECTED_REPORTING_MODULES);
  });

  it('finds no violation in any reporting module', () => {
    const violations = reportingModules().flatMap((file) =>
      scanForNonSnapshotReads(file, readFileSync(`${REPORTING_DIR}/${file}`, 'utf8')));

    expect(
      violations.map((v) => `${v.file}: ${v.detail}`),
      'a report that recomputes from current configuration produces a figure that ' +
        'changes underneath the person who printed it',
    ).toEqual([]);
  });

  it('confirms the reports actually read the snapshot sources', () => {
    // The other direction of non-vacuity: a scan finds nothing forbidden in a
    // module that queries nothing at all, which is how the audit assertion once
    // greened over an empty set.
    const modules = reportingModules();
    const combined = modules
      .map((f) => readFileSync(`${REPORTING_DIR}/${f}`, 'utf8'))
      .join('\n');
    const snapshots = ALLOWED_TABLES.filter((t) => t.role === 'snapshot');
    const used = snapshots.filter((t) => combined.includes(t.table));
    expect(
      used.length,
      'reporting modules reference no snapshot table at all; the scan above is passing ' +
        'over modules that read nothing',
    ).toBeGreaterThanOrEqual(5);
  });
});
