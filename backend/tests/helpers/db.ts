import pg from 'pg';
import { expect } from 'vitest';

export function ownerClient(): pg.Client {
  const connectionString = process.env['DATABASE_URL_OWNER'];
  if (!connectionString) throw new Error('DATABASE_URL_OWNER is not set');
  return new pg.Client({ connectionString });
}

export function appClient(): pg.Client {
  const connectionString = process.env['DATABASE_URL_APP'];
  if (!connectionString) throw new Error('DATABASE_URL_APP is not set');
  return new pg.Client({ connectionString });
}

/**
 * Guards against the failure mode that greens forever: a filter that matches
 * nothing still reports "no violations". Over-matching fails loudly and gets
 * fixed; under-matching is invisible.
 *
 * Every set-based assertion states what it looked at before stating what it
 * found, so "zero violations across zero rows" cannot pass.
 */
export function assertCheckedSet(opts: {
  label: string;
  checked: readonly string[];
  minimum: number;
  mustInclude: readonly string[];
}): void {
  const absent = opts.mustInclude.filter((name) => !opts.checked.includes(name));
  expect(absent, `${opts.label}: required names missing from the checked set`).toEqual([]);
  expect(
    opts.checked.length,
    `${opts.label}: checked only ${opts.checked.length} item(s), expected at least ${opts.minimum}`,
  ).toBeGreaterThanOrEqual(opts.minimum);
}

export const APP_TABLES = [
  'branch',
  'app_user',
  'credential',
  'role',
  'role_permission',
  'membership',
  'tenant_audit_log',
  'device',
  'device_enrolment',
  'staff_invite',
  'floor',
  'table_type',
  'floor_type',
  'credential_setup',
  'parcel_sequence',
  'dining_table',
  'kitchen_station',
  'printer',
  'station_printer',
  'station_code',
  'tax_class',
  'tenant_tax_setting',
  'menu_category',
  'menu_item',
  'modifier_group',
  'modifier_option',
  'menu_item_modifier_group',
  'combo_choice_group',
  'combo_choice_option',
  'combo_component',
  'branch_menu_listing',
  'branch_menu_price',
  'service_period',
  'menu_item_service_period',
  'branch_item_availability',
  'branch_item_routing',
  'request_claim',
  'table_session',
  'table_session_table',
  'adjustment_reason',
  'adjustment_reason_kind',
  'sales_order',
  'order_line',
  'fire_sequence',
  'kot_sequence',
  'kot_fire',
  'kot',
  'kot_line',
  'print_job',
  'kot_recall',
  'bill_sequence',
  'bill',
  'bill_line',
  'bill_print',
  'tender',
  'refund',
  'unit',
  'product',
  'product_unit',
  'recipe_publication_sequence',
  'recipe',
  'recipe_version',
  'recipe_line',
  'recipe_version_expansion',
  'stock_reason',
  'stock_reason_kind',
  'stock_movement',
  'stock_balance',
  'stock_count',
  'stock_count_line',
  'supplier',
  'supplier_product',
  'purchase_order',
  'purchase_order_line',
  'goods_receipt',
  'goods_receipt_line',
  'table_session_lease',
  'sync_batch',
  'sync_quarantine',
] as const;

export const AUDIT_PARENTS = [
  'platform.platform_audit_log',
  'app.tenant_audit_log',
] as const;
