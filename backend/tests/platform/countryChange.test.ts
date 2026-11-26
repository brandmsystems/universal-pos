import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { assertCheckedSet, ownerClient } from '../helpers/db.js';
import { CONVERTED_MONEY_COLUMNS, KEPT_MONEY_COLUMNS } from '../../src/modules/platform/countries.js';

/**
 * A country change with a rate converts every configured price. The list of
 * columns it converts sits beside a schema that grows, so it is held to the
 * schema here: every money-shaped column in schema `app` is either converted or
 * kept with a reason, never neither and never both. The end-to-end moves
 * (India -> UAE, UAE -> India) are in tests/http/basicTill.test.ts, section 3e.
 */

let db: pg.Client;

beforeAll(async () => {
  db = ownerClient();
  await db.connect();
});

afterAll(async () => {
  await db?.end();
});

const converted = CONVERTED_MONEY_COLUMNS.flatMap((e) => e.columns.map((c) => `${e.table}.${c}`));
const kept = Object.keys(KEPT_MONEY_COLUMNS);

async function moneyColumns(): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    `SELECT c.relname || '.' || a.attname AS name
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname ~ '(_minor|_micro|_cap)$'
      ORDER BY 1`);
  return rows.rows.map((r) => r.name);
}

describe('a country change converts every configured price, and only those', () => {
  it('classifies every money column in schema app exactly once', async () => {
    const columns = await moneyColumns();
    assertCheckedSet({
      label: 'app money columns',
      checked: columns,
      minimum: 30,
      mustInclude: ['menu_item.price_minor', 'branch_menu_price.price_minor', 'bill.total_minor', 'role.discount_amount_cap'],
    });
    expect(columns.filter((c) => !converted.includes(c) && !kept.includes(c)), 'neither converted nor kept').toEqual([]);
    expect(converted.filter((c) => kept.includes(c)), 'both converted and kept').toEqual([]);
    // No phantom entries: a classification of a column that does not exist is a list rotting.
    expect([...converted, ...kept].filter((c) => !columns.includes(c)), 'names no real column').toEqual([]);
  });

  it('notices a column nobody classified', async () => {
    // The synthetic violation: a new price column, inside a transaction rolled back.
    await db.query('BEGIN');
    try {
      await db.query('ALTER TABLE app.menu_item ADD COLUMN takeaway_price_minor bigint');
      const columns = await moneyColumns();
      expect(columns.filter((c) => !converted.includes(c) && !kept.includes(c))).toEqual(['menu_item.takeaway_price_minor']);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
