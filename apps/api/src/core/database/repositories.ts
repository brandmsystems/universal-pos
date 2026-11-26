import { printerAddressProblem } from '@katkitchen/shared';
import { BaseRepository, type Predicate, type Value } from './baseRepository.js';

/**
 * Phase 0 repositories. Every tenant-plane table gets one, and nothing outside
 * this layer is permitted to issue SQL against schema `app` -- enforced by the
 * raw-SQL gate, not by review.
 */

export interface BranchRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  timezone: string;
  status: string;
}

export interface AppUserRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  email: string | null;
  employee_code: string | null;
  full_name: string;
  status: string;
}

export interface CredentialRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  user_id: string;
  type: string;
  status: string;
  failed_attempt_count: number;
  locked_until: Date | null;
}

export interface RoleRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  key: string;
  is_system: boolean;
  assignable_scope: string;
  discount_percent_cap: number;
  discount_amount_cap: string | null;
}

export interface MembershipRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  user_id: string;
  branch_id: string | null;
  role_id: string;
  role_assignable_scope: string;
  status: string;
}

export interface RolePermissionRow extends Record<string, unknown> {
  tenant_id: string;
  role_id: string;
  permission_key: string;
}

export class BranchRepository extends BaseRepository<BranchRow> {
  protected readonly table = 'app.branch';
}

export class AppUserRepository extends BaseRepository<AppUserRow> {
  protected readonly table = 'app.app_user';
}

export class CredentialRepository extends BaseRepository<CredentialRow> {
  protected readonly table = 'app.credential';
}

export class RoleRepository extends BaseRepository<RoleRow> {
  protected readonly table = 'app.role';
}

export class RolePermissionRepository extends BaseRepository<RolePermissionRow> {
  protected readonly table = 'app.role_permission';
}

export class MembershipRepository extends BaseRepository<MembershipRow> {
  protected readonly table = 'app.membership';
}

export interface TenantAuditLogRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  branch_id: string | null;
  actor_kind: string;
  actor_user_id: string | null;
  actor_name: string;
  actor_system_job: string | null;
  impersonation_session_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  payload_truncated: boolean;
  via_impersonation: boolean;
  authorising_membership_id: string | null;
  occurred_at: Date;
}

/**
 * Append-only at the database. The repository exposes insert and reads; UPDATE
 * and DELETE are refused by grant and by trigger regardless of what is called
 * here.
 */
export class TenantAuditLogRepository extends BaseRepository<TenantAuditLogRow> {
  protected readonly table = 'app.tenant_audit_log';
}

export class DeviceRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.device';
}
export class DeviceEnrolmentRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.device_enrolment';
}
export class StaffInviteRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.staff_invite';
}
export class FloorRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.floor';
}
export class FloorTypeRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.floor_type';
}
export class TableTypeRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.table_type';
}
export class DiningTableRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.dining_table';
}
export class KitchenStationRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.kitchen_station';
}
export class PrinterAddressInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'printer_address_invalid';
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'PrinterAddressInvalidError';
  }
}

/**
 * A printer's address is checked on the way in, so a manager is told at the
 * form rather than by a kitchen ticket that never prints. Every writer -- the
 * generic admin create and edit, the Excel import -- comes through here. The
 * print transport checks again before each connection: it is the authority.
 */
function checkPrinterAddress(values: Readonly<Record<string, Value>>, creating: boolean): void {
  const address = values['address'];
  if (typeof address === 'string' && address.trim() !== '') {
    const problem = printerAddressProblem(address);
    if (problem !== null) throw new PrinterAddressInvalidError(problem);
  } else if (creating && values['connection_kind'] === 'network') {
    throw new PrinterAddressInvalidError('A Wi-Fi or Ethernet printer needs its IP address.');
  }
}

export class PrinterRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.printer';

  override async insert(values: Readonly<Record<string, Value>>): Promise<Record<string, unknown>> {
    checkPrinterAddress(values, true);
    return super.insert(values);
  }

  override async update(predicate: Predicate, values: Readonly<Record<string, Value>>): Promise<Record<string, unknown>[]> {
    checkPrinterAddress(values, false);
    return super.update(predicate, values);
  }
}
export class StationPrinterRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.station_printer';
}

export class StationCodeRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.station_code';
}
export class TaxClassRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.tax_class';
}
export class MenuCategoryRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.menu_category';
}
export class MenuItemRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.menu_item';
}
export class ModifierGroupRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.modifier_group';
}
export class ModifierOptionRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.modifier_option';
}
export class MenuItemModifierGroupRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.menu_item_modifier_group';
}
export class ComboChoiceGroupRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.combo_choice_group';
}
export class ComboChoiceOptionRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.combo_choice_option';
}
export class ComboComponentRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.combo_component';
}
export class BranchMenuListingRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.branch_menu_listing';
}
export class BranchMenuPriceRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.branch_menu_price';
}
export class ServicePeriodRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.service_period';
}
export class MenuItemServicePeriodRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.menu_item_service_period';
}
export class BranchItemAvailabilityRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.branch_item_availability';
}
export class BranchItemRoutingRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.branch_item_routing';
}

export class RequestClaimRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.request_claim';
}
export class TableSessionRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.table_session';
}
export class TableSessionTableRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.table_session_table';
}
export class AdjustmentReasonRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.adjustment_reason';
}
export class CustomerRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.customer';
}
export class CustomerConsentRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.customer_consent';
}
export class LoyaltyProgramRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.loyalty_program';
}
export class LoyaltyLedgerRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.loyalty_ledger';
}
export class AdjustmentReasonKindRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.adjustment_reason_kind';
}
export class SalesOrderRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.sales_order';
}
export class OrderLineRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.order_line';
}
export class FireSequenceRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.fire_sequence';
}
export class KotSequenceRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.kot_sequence';
}
export class KotFireRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.kot_fire';
}
export class KotRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.kot';
}
export class KotLineRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.kot_line';
}
export class PrintJobRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.print_job';
}

export class KotRecallRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.kot_recall';
}
export class BillSequenceRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.bill_sequence';
}
export class BillRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.bill';
}
export class BillLineRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.bill_line';
}
export class TenderRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.tender';
}
export class RefundRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.refund';
}

export class UnitRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.unit';
}
export class ProductRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.product';
}
export class ProductUnitRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.product_unit';
}
export class SupplierRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.supplier';
}
export class RecipePublicationSequenceRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.recipe_publication_sequence';
}
export class RecipeRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.recipe';
}
export class RecipeVersionRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.recipe_version';
}
export class RecipeLineRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.recipe_line';
}
export class RecipeVersionExpansionRepository extends BaseRepository<Record<string, unknown>> {
  protected readonly table = 'app.recipe_version_expansion';
}
