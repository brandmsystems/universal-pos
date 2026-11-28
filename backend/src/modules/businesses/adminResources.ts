import {
  BranchRepository, AppUserRepository, RoleRepository, MenuItemRepository,
  DeviceRepository, KitchenStationRepository, PrinterRepository,
  TaxClassRepository, FloorTypeRepository, FloorRepository, DiningTableRepository,
  MenuCategoryRepository,
} from '../../database/repositories.js';
import type { BaseRepository, Value } from '../../database/baseRepository.js';

/**
 * The admin CRUD surface, declared once.
 *
 * ###########################################################################
 * A WRITABLE FIELD IS AN ALLOWLIST, PER RESOURCE, PER OPERATION.
 *
 * The obvious way to write forty CRUD handlers is `repo.update({ id }, body)`.
 * That is mass assignment: `PATCH /admin/devices/:id` with
 * `{ "status": "active" }` un-revokes a stolen terminal, and
 * `PATCH /admin/users/:id` with `{ "status": "active" }` reinstates a suspended
 * one -- both through a route whose permission key is only `device.edit` or
 * `user.edit`. The revocation and suspension routes exist separately, with their
 * own keys, precisely so that authority is separable; a passthrough hands it
 * straight back.
 *
 * So each resource states the fields a create may set and the fields an edit may
 * set, and anything else in the body is REFUSED rather than ignored. Refused,
 * not ignored, because a client sending a field that silently does nothing
 * believes it worked -- and the field it was trying to set is usually the one
 * that matters.
 * ###########################################################################
 *
 * ###########################################################################
 * ARCHIVE IS A STATUS. DELETE IS NOT AVAILABLE.
 *
 * `DELETE /admin/:resource/:id` sets a status column. Nothing here removes a
 * row, and that is not caution -- almost every one of these tables is the target
 * of an ON DELETE RESTRICT foreign key from something that records history, so a
 * real delete fails at the constraint. Declaring the status column puts the
 * behaviour in this table instead of in an error message.
 *
 * A resource with no `archivedBy` cannot be archived, and the generated route
 * table produces no DELETE for it.
 * ###########################################################################
 */

/**
 * A column the HANDLER fills, from the transaction clock or the verified token.
 *
 * Never from the request: that is the same rule the POS handlers follow, and it
 * is the reason a NOT NULL attribution column can be satisfied by a generic
 * write at all. `app.supplier.created_by_user_id` is the case that forced this
 * shape to be named -- see `suppliers` below.
 */
export interface ServerFilledColumn {
  readonly column: string;
  readonly value: string | { readonly from: 'now' | 'actor' };
}

/** Verbs whose handler is written by hand rather than generated. */
export type AdminVerb = 'create' | 'edit' | 'archive';

export interface AdminResource {
  readonly repository: () => BaseRepository<Record<string, unknown>>;
  /** Columns the list returns. An allowlist, because `SELECT *` leaks. */
  readonly columns: readonly string[];
  /** Non-null when rows belong to a branch, naming the column to scope by. */
  readonly branchColumn: string | null;
  readonly creatable: readonly string[];
  readonly editable: readonly string[];
  /**
   * ###########################################################################
   * NOT NULL ATTRIBUTION COLUMNS, FILLED FROM THE TOKEN.
   *
   * `app.supplier.created_by_user_id` is NOT NULL with no default and an FK to
   * app.app_user. A generic create that sets only the creatable fields and the
   * minted id is refused by the not-null constraint -- 400 field_required, on
   * every single call, for a route the correspondence gate happily reports as
   * served. That is precisely this repo's recurring defect: built, routed,
   * unreachable.
   *
   * The obvious fix is to put `created_by_user_id` in `creatable`. That is the
   * WRONG fix twice over: it lets the caller name who created the row, and
   * `tests/http/requestProvenance.test.ts` exists because three handlers already
   * did that with money. So the column is declared here and the handler fills it
   * from `claims.sub`, exactly as `archivedBy` fills `revoked_by_user_id`.
   * ###########################################################################
   */
  readonly createdBy: readonly ServerFilledColumn[] | null;
  /**
   * What an archive writes. `now` and `actor` are filled by the handler from the
   * transaction clock and the verified token -- never from the request.
   */
  readonly archivedBy: readonly ServerFilledColumn[] | null;
  /**
   * ###########################################################################
   * VERBS THE GENERIC LAYER DELIBERATELY DOES NOT SERVE.
   *
   * An empty `creatable` or `editable` is ambiguous on its own: it can mean "the
   * permission catalogue has no key for this, so no route is generated" (devices'
   * `editable`, stations' `creatable`) or "the route exists and the generic
   * implementation would be WRONG for it". Those are opposite facts and the
   * second one needs a hand-written handler, so it has to be stated rather than
   * inferred from a route table two files away.
   *
   * Two entries today, both because the operation is not a column write:
   *   devices.create -- enrolment mints a single-use token
   *   recipes.edit   -- a recipe edit is a new published version
   *
   * The gate in tests/http/adminSurface.test.ts checks both directions: a verb
   * named here must NOT be generated, and it must be supplied by hand somewhere.
   * ###########################################################################
   */
  readonly purposeBuilt: readonly AdminVerb[];
  /**
   * True where DELETE really removes the row.
   *
   * One resource has this, and it is not a shortcut: every `app.membership` row
   * references `app.role` with ON DELETE RESTRICT, so a role anybody holds
   * cannot be deleted -- the constraint is the authority and the route is only
   * the request. Nothing with history pointing at it gets this flag.
   */
  readonly hardDelete: boolean;
  readonly orderBy: string;
  /** States a default list hides. */
  readonly hideStates: readonly string[];
}

/** What a printer takes and how a page is set on it (0078). */
const PRINTER_LAYOUT = ['printer_type', 'paper_size', 'orientation', 'margin_mm', 'font_size_px'] as const;

/**
 * Which printer a branch's bill is laid out for, what it shows, which copies print and when (0078),
 * and the heading it prints by how much of it is paid (0088).
 */
const BILL_LAYOUT = [
  'bill_printer_id', 'bill_show_logo', 'bill_show_details', 'bill_show_customer', 'bill_show_tax',
  'bill_show_payments', 'bill_copy_customer', 'bill_copy_kitchen', 'bill_copy_counter', 'bill_auto_print',
  'bill_show_copy_label', 'bill_heading_unpaid', 'bill_heading_part_paid', 'bill_heading_paid',
] as const;

/** What a parcel may be charged for packing (0081): the default the till fills in, the cap it may not pass, and the tax it takes. */
const PARCEL_CHARGE = ['parcel_charge_default_minor', 'parcel_charge_max_minor', 'parcel_charge_tax_class_id'] as const;

/** How a branch charges tax (0083). Listed, never generically editable: its own route refuses mid-service. */
const TAX_SETTINGS = ['tax_enabled', 'tax_account_type', 'tax_calculation_mode', 'tax_registration_no'];

export const ADMIN_RESOURCES: Readonly<Record<string, AdminResource>> = {
  branches: {
    repository: () => new BranchRepository(),
    columns: ['id', 'code', 'name', 'timezone', 'status', 'business_day_starts_at',
      // ###################################################################
      // THE GST IDENTITY OF THE PLACE, WITHOUT WHICH NO BILL IS COMPLIANT.
      //
      // `generateBill` stamps `supplier_gstin` and `place_of_supply_state_code`
      // onto every bill from these two columns. They existed since migration
      // 0037 and NOTHING could set them: not this resource, not a purpose-built
      // route, not the provisioning path. So every bill in a real deployment
      // would have carried a null supplier GSTIN and no place of supply, and
      // every credit note would have reported zero tax -- five columns added by
      // a migration that no write path filled.
      //
      // READ HERE, CREATED WITH THE BRANCH, MOVED ONLY BY ITS OWN ROUTE.
      //
      // These three are returned by the list, set once at creation, and
      // thereafter changed only by
      // `POST /admin/branches/:id/gst-registration` -- never by the generic
      // PATCH. Three reasons, all of which the generic handler is
      // structurally unable to satisfy: the write must be refused while the
      // branch is trading, it must leave a row in
      // `app.branch_gst_registration_change` for a GST return that spans it,
      // and it belongs behind `branch.gst.state` rather than `branch.edit`
      // because it decides whether diners are charged tax at all.
      //
      // An earlier version had them in `editable`, which was the honest fix for
      // "nothing can write these" and the wrong fix for "what writing them
      // means".
      // ###################################################################
      'gstin', 'state_code', 'gst_registration',
      // What the printed bill says about the outlet (0069), and how and when it
      // is laid out and printed (0078).
      'phone', 'bill_address', 'bill_footer', ...BILL_LAYOUT, ...PARCEL_CHARGE,
      // The company details the bill prints (0083), and how the branch charges
      // tax -- read here, moved only by POST /admin/branches/:id/tax.
      'email', 'bill_name', ...TAX_SETTINGS],
    // NOT branch-scoped: this is the list OF branches. A branch-scoped token
    // still sees them all, because a manager moving between branches needs to
    // know they exist. What they may do inside one is the membership's job.
    branchColumn: null,
    // ###################################################################
    // THE QUESTION IS ASKED AT CREATION, AND THE SCHEMA MAKES IT UNSKIPPABLE.
    //
    // `gst_registration` is NOT NULL with no DEFAULT, so a create that omits it
    // is refused with `field_required` on the column name. That is the whole
    // mechanism: there is no way to open a branch without answering whether it
    // is GST-registered, and no default quietly deciding on the owner's behalf.
    // (Migration 0048's backfill wrote `unstated` onto rows that predate the
    // question. Nothing can create that value -- `branch_gst_change_to_not_
    // unstated` and this create path both refuse it -- so it drains.)
    //
    // Editable holds none of the three. Correcting the position later is a
    // MOVEMENT: it can be refused mid-service and it has to leave a record for
    // a return that spans it, neither of which a generic column write does.
    // ###################################################################
    creatable: ['code', 'name', 'timezone', 'business_day_starts_at',
      'gst_registration', 'gstin', 'state_code', 'phone', 'bill_address', 'bill_footer'],
    editable: ['name', 'timezone', 'business_day_starts_at', 'phone', 'bill_address', 'bill_footer', ...BILL_LAYOUT,
      ...PARCEL_CHARGE, 'email', 'bill_name'],
    createdBy: null,
    purposeBuilt: [],
    // 'inactive', which is what `branch_status_known` permits. The first
    // version of this table said 'archived' -- a value the schema has never
    // allowed -- and the CHECK refused it. Two vocabularies for the same idea is
    // exactly what a declaration like this is for: the schema's wins.
    archivedBy: [{ column: 'status', value: 'inactive' }],
    hardDelete: false,
    orderBy: 'code',
    hideStates: ['inactive'],
  },

  users: {
    repository: () => new AppUserRepository(),
    // No `email`. Staff email is PII and reading it is an event that belongs in
    // app.pii_access_log, which this generic handler does not write -- so it does
    // not return the field either. The PII routes are separate and deliberate.
    columns: ['id', 'full_name', 'employee_code', 'status', 'last_login_at', 'created_at'],
    branchColumn: null,
    // Read only. Staff are the Sales person's (modules/platform/tenantStaff.ts):
    // a restaurant manager adds, edits and switches off nobody.
    creatable: [],
    editable: [],
    createdBy: null,
    purposeBuilt: [],
    archivedBy: null,
    hardDelete: false,
    orderBy: 'full_name',
    hideStates: ['disabled'],
  },

  roles: {
    repository: () => new RoleRepository(),
    columns: ['id', 'key', 'name', 'is_system', 'assignable_scope'],
    branchColumn: null,
    creatable: ['key', 'name'],
    editable: ['name'],
    createdBy: null,
    purposeBuilt: [],
    // No status column, and a REAL delete -- the only one here. A role nobody
    // holds is a mistake to remove; a role somebody holds is refused by the
    // membership foreign key, which now surfaces as a 422 naming the constraint
    // rather than a 500.
    archivedBy: null,
    hardDelete: true,
    orderBy: 'name',
    hideStates: [],
  },

  // #########################################################################
  // THE TAX CLASSES A MENU ITEM IS PRICED UNDER.
  //
  // `app.menu_item.tax_class_id` is NOT NULL with a foreign key, and until this
  // resource existed there was NO WAY TO CREATE A TAX CLASS: not here, not a
  // purpose-built route, not `provisionTenant`. `seed-demo.mts` inserted one
  // with an owner connection, which is why the demo tenant worked and why the
  // suite passed.
  //
  // So a real restaurant, provisioned through `POST /tenants`, could not add a
  // single dish. The create form asked for a `tax_class_id`, there was nothing
  // to put in it, and no route listed the options. Every gate reported the menu
  // surface as served. Same family as the unbillable subscription in phase 9 and
  // the unreachable adjustment reasons in phase 8: built, routed, and joined to
  // the running system by nothing.
  //
  // `rate_bps` IS editable, for the same reason `menu/items.price_minor` is: an
  // order line snapshots the rate at order time, so changing the class cannot
  // move tax already charged. What it CANNOT do is change a head -- the head is
  // derived per bill by `src/modules/tax/registry.ts` from the bill's own jurisdiction,
  // and there is no component name here to get wrong.
  //
  // ANY rate is accepted, including an odd one. `tax_class_rate_halves` used to
  // refuse those, on the reasoning that CGST and SGST are exactly half each;
  // 0052 deleted it, because a head is a SHARE and a 7.25% combined rate splits
  // three ways at uneven shares without needing to be even. The exactness that
  // constraint was protecting is now the allocator's invariant instead, and it
  // is asserted where it matters: the heads must sum to the line tax, which
  // `bill_line_heads_match_treatment` checks at COMMIT.
  //
  // Archiving a class 40 dishes reference is PERMITTED and harmless: the row
  // stays resolvable, so those dishes keep their rate, and the class simply
  // stops being offered for new ones. That is what archive means everywhere
  // else in this file, and a refusal here would be inventing a rule.
  // #########################################################################
  'tax-classes': {
    repository: () => new TaxClassRepository(),
    columns: ['id', 'key', 'name', 'rate_bps', 'status', 'created_at'],
    branchColumn: null,
    creatable: ['key', 'name', 'rate_bps'],
    editable: ['name', 'rate_bps'],
    createdBy: null,
    purposeBuilt: [],
    archivedBy: [{ column: 'status', value: 'archived' }],
    hardDelete: false,
    orderBy: 'rate_bps',
    hideStates: ['archived'],
  },

  'menu/items': {
    repository: () => new MenuItemRepository(),
    // `tax_class_id`, not `tax_class_key`, and no `is_combo` -- both were in this
    // list and neither exists on the table. `pick()` turned them into null and
    // every row rendered an em-dash, which reads as "not set". The gate in
    // tests/http/adminSurface.test.ts now checks every declared column against
    // information_schema, because a declaration that names a column the table
    // does not have is the same failure this whole file exists to prevent, made
    // by the file itself.
    columns: ['id', 'key', 'name', 'description', 'barcode', 'category_id', 'kind', 'price_minor',
              'prep_minutes', 'tax_class_id', 'station_code', 'status', 'archived_at'],
    branchColumn: null,
    // Empty: create and edit are purpose-built, so the generic layer offers no
    // field list for either -- the setup screen's item form is the only writer.
    creatable: [],
    // `price_minor` IS editable, and that is safe for exactly one reason: an
    // order line snapshots price, modifier deltas and tax rate at order time, so
    // changing the catalogue cannot move money already taken. This field would
    // be unsafe in almost any other schema -- see the priced-document rule.
    editable: [],
    createdBy: null,
    // Purpose-built: a create derives the key from the name, attaches add-ons,
    // writes a combo's dishes and lists the item at its branch -- several rows
    // that must agree. See modules/businesses/setup.ts.
    purposeBuilt: ['create', 'edit'],
    // `menu_item` HAS an archived_at column, so an archive that set only the
    // status would leave the two disagreeing -- the same shape as the device
    // revocation, caught by looking rather than by a constraint this time.
    archivedBy: [
      { column: 'status', value: 'archived' },
      { column: 'archived_at', value: { from: 'now' } },
    ],
    hardDelete: false,
    orderBy: 'name',
    hideStates: ['archived'],
  },

  stations: {
    repository: () => new KitchenStationRepository(),
    columns: ['id', 'branch_id', 'code', 'name', 'display_order', 'status'],
    branchColumn: 'branch_id',
    creatable: [],
    editable: ['name', 'display_order'],
    createdBy: null,
    purposeBuilt: [],
    archivedBy: null,
    hardDelete: false,
    orderBy: 'display_order',
    hideStates: [],
  },

  printers: {
    repository: () => new PrinterRepository(),
    // What the print agent last saw of a network printer, and its last test
    // print (0085): read only, written by the agent's poll.
    columns: ['id', 'branch_id', 'name', 'connection_kind', 'address', 'status', ...PRINTER_LAYOUT,
      'reach_checked_at', 'reachable', 'reach_error', 'test_print_requested_at', 'test_printed_at', 'test_print_error'],
    branchColumn: 'branch_id',
    creatable: ['name', 'connection_kind', 'address', ...PRINTER_LAYOUT],
    // `address` is the printer's host or device path. Editable because a
    // restaurant re-IPs its kitchen printers and that must not need a deploy;
    // `connection_kind` is not, because changing it changes which driver runs.
    // The type and paper are (0078): a till swaps its roll printer for an A4
    // laser without a new row, and the table's CHECKs keep the pair consistent.
    editable: ['name', 'address', ...PRINTER_LAYOUT],
    createdBy: null,
    purposeBuilt: [],
    // A printer still named by a kitchen is refused by station_printer's
    // foreign key only on delete; archiving is a status, so the kitchen screen
    // shows the kitchen without a working printer rather than losing it.
    archivedBy: [{ column: 'status', value: 'archived' }],
    hardDelete: false,
    orderBy: 'name',
    hideStates: ['archived'],
  },

  // ###########################################################################
  // THE MANAGER'S SETUP: FLOOR TYPES, FLOORS, TABLES, MENU CATEGORIES.
  //
  // Single-table writes, so the declared CRUD serves them. Keys (floor types,
  // categories) are derived from the name on the setup screen; the schema's
  // key format CHECK is the authority.
  // ###########################################################################
  'floor-types': {
    repository: () => new FloorTypeRepository(),
    columns: ['id', 'key', 'name', 'status'],
    branchColumn: null,
    creatable: ['key', 'name'],
    editable: ['name'],
    createdBy: null,
    purposeBuilt: [],
    archivedBy: [{ column: 'status', value: 'archived' }],
    hardDelete: false,
    orderBy: 'name',
    hideStates: ['archived'],
  },

  floors: {
    repository: () => new FloorRepository(),
    columns: ['id', 'branch_id', 'name', 'floor_type_id', 'display_order', 'status'],
    branchColumn: 'branch_id',
    creatable: ['name', 'floor_type_id', 'display_order'],
    editable: ['name', 'floor_type_id', 'display_order'],
    createdBy: null,
    purposeBuilt: [],
    archivedBy: [{ column: 'status', value: 'archived' }],
    hardDelete: false,
    orderBy: 'display_order',
    hideStates: ['archived'],
  },

  tables: {
    repository: () => new DiningTableRepository(),
    columns: ['id', 'branch_id', 'floor_id', 'identifier', 'seats', 'status'],
    branchColumn: 'branch_id',
    // The floor must be at the same branch: dining_table_floor_same_branch_fk.
    creatable: ['floor_id', 'identifier', 'seats'],
    editable: ['floor_id', 'identifier', 'seats'],
    createdBy: null,
    purposeBuilt: [],
    archivedBy: [
      { column: 'status', value: 'archived' },
      { column: 'archived_at', value: { from: 'now' } },
    ],
    hardDelete: false,
    orderBy: 'identifier',
    hideStates: ['archived'],
  },

  'menu/categories': {
    repository: () => new MenuCategoryRepository(),
    columns: ['id', 'key', 'name', 'parent_id', 'display_order', 'status'],
    branchColumn: null,
    creatable: ['key', 'name', 'parent_id', 'display_order'],
    editable: ['name', 'parent_id', 'display_order'],
    createdBy: null,
    purposeBuilt: [],
    archivedBy: [{ column: 'status', value: 'archived' }],
    hardDelete: false,
    orderBy: 'display_order',
    hideStates: ['archived'],
  },

  devices: {
    repository: () => new DeviceRepository(),
    // No `fingerprint`. It is the terminal's identifying secret in effect, and a
    // list that returns it turns `device.view` into a way to impersonate one.
    columns: ['id', 'branch_id', 'name', 'status', 'registered_at', 'last_seen_at',
              'revoked_at'],
    branchColumn: 'branch_id',
    // No create: a till becomes a device when the manager signs in on it
    // (registerTillAtSignIn). Tablet setup codes are gone with Basic-only.
    creatable: [],
    // Empty, and NOT because renaming a till is unreasonable -- it is the most
    // ordinary admin task there is. There is no `device.edit` key in the
    // permission catalogue, so the route table generates no PATCH, so a handler
    // here would be dead code the correspondence gate would report. Adding the
    // key is a catalogue change and belongs with the other Phase 1 decisions,
    // not smuggled in behind a CRUD table.
    editable: [],
    createdBy: null,
    purposeBuilt: [],
    // Three columns, together, because `device_revocation_consistent` requires
    // it -- and it requires it because "this till was revoked" with no name
    // against it is not something anyone can follow up.
    archivedBy: [
      { column: 'status', value: 'revoked' },
      { column: 'revoked_at', value: { from: 'now' } },
      { column: 'revoked_by_user_id', value: { from: 'actor' } },
    ],
    hardDelete: false,
    orderBy: 'name',
    hideStates: [],
  },
};

export class UnwritableFieldsError extends Error {
  readonly statusCode = 422;
  readonly code = 'fields_not_writable';
  constructor(resource: string, fields: readonly string[], permitted: readonly string[]) {
    super(
      `${fields.join(', ')} cannot be set on ${resource} through this route. ` +
        `It accepts ${permitted.length === 0 ? 'nothing' : permitted.join(', ')}. ` +
        'A field refused here usually has its own route and its own permission, ' +
        'which is the point.',
    );
    this.name = 'UnwritableFieldsError';
  }
}

export class ResourceNotArchivableError extends Error {
  readonly statusCode = 405;
  readonly code = 'resource_not_archivable';
  constructor(resource: string) {
    super(`${resource} has no archive state; whatever references it keeps it`);
    this.name = 'ResourceNotArchivableError';
  }
}

export class FieldValueNotScalarError extends Error {
  readonly statusCode = 422;
  readonly code = 'field_value_not_scalar';
  constructor(resource: string, field: string) {
    super(
      `${field} on ${resource} was given an object or an array. A column takes a ` +
        'string, number, boolean, timestamp or null; anything structured belongs ' +
        'to a purpose-built route that knows what the structure means.',
    );
    this.name = 'FieldValueNotScalarError';
  }
}

export class NothingToUpdateError extends Error {
  readonly statusCode = 400;
  readonly code = 'nothing_to_update';
  constructor(resource: string) {
    super(`the request sets no field on ${resource}`);
    this.name = 'NothingToUpdateError';
  }
}

/**
 * Refuses, rather than filtering.
 *
 * Of the three options -- apply it, drop it silently, refuse it -- dropping is
 * the worst: the caller gets a 200 and believes the change landed.
 */
export function writableOnly(
  resource: string,
  body: Record<string, unknown>,
  permitted: readonly string[],
): Record<string, Value> {
  const refused = Object.keys(body).filter((field) => !permitted.includes(field));
  if (refused.length > 0) throw new UnwritableFieldsError(resource, refused, permitted);

  const out: Record<string, Value> = {};
  for (const field of permitted) {
    if (!(field in body)) continue;
    const value = body[field];
    // Scalars only, checked rather than cast. A cast here would let a nested
    // object reach a jsonb column through a route that has no idea the column is
    // jsonb, and let an array reach a text column as a Postgres array literal.
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      throw new FieldValueNotScalarError(resource, field);
    }
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)
        && !(value instanceof Date)) {
      throw new FieldValueNotScalarError(resource, field);
    }
    out[field] = value as Value;
  }
  return out;
}
