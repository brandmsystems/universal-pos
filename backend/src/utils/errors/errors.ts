/**
 * The error contract.
 *
 * ###########################################################################
 * `retryable` IS A FIELD, NOT SOMETHING THE TABLET INFERS FROM THE STATUS.
 *
 * A 409 meaning "re-claim your lease and replay" and a 409 meaning "that batch
 * was quarantined, never send it again" demand opposite actions, and inferring
 * from 4xx-versus-5xx gets both wrong. A tablet over bad wifi that guesses either
 * hammers a wall or drops work.
 *
 * So every refusal the domain already distinguishes keeps its own code, and the
 * mapping to (status, retryable) lives in ONE place. A new error class that is
 * not mapped here surfaces as a 500 with retryable=false -- loud and safe --
 * rather than being silently flattened into a generic 400.
 * ###########################################################################
 */

export interface ErrorResponse {
  readonly error: string;
  readonly retryable: boolean;
  readonly detail: string;
}

interface Mapping {
  readonly status: number;
  readonly retryable: boolean;
  /** What the tablet should do. Not sent; it is here so the table is reviewable. */
  readonly clientAction: string;
}

/**
 * Keyed on the `code` each error class already carries.
 *
 * Note what is NOT here: an "insufficient stock" refusal at order time. Negative
 * stock is permitted, flagged and never blocking -- refusing a deduction does not
 * un-cook the food. The only stock refusal in the system is `recordWaste`, an
 * admin action, and it appears on the admin surface rather than the POS one.
 */
export const ERROR_CONTRACT: Readonly<Record<string, Mapping>> = {
  // ---- the lease -----------------------------------------------------------
  session_leased: {
    status: 409, retryable: false,
    clientAction: 'another device holds this table; show who and stop',
  },
  lease_not_held: {
    status: 409, retryable: false,
    clientAction: 're-claim the lease, then replay the operation',
  },
  lease_token_unknown: {
    // The token named no live lease. Same client action as lease_not_held and
    // deliberately the same shape, because the three ways to get here -- expired,
    // released, force-released -- are only distinguishable to someone guessing
    // tokens.
    status: 409, retryable: false,
    clientAction: 're-claim the lease, then replay the operation',
  },
  lease_subject_mismatch: {
    // A live lease, on the wrong session. Not retryable and NOT a re-claim
    // either: the client is writing to an order it does not hold, which is a
    // client bug or a replayed queue against the wrong table.
    status: 409, retryable: false,
    clientAction: 'a client bug: reload the session, do not replay',
  },
  lease_subject_not_found: {
    status: 404, retryable: false,
    clientAction: 'reload; the order or bill does not exist in this tenant',
  },
  lease_subject_unreadable: {
    status: 400, retryable: false,
    clientAction: 'a client bug: the request omits the id the lease is checked on',
  },

  // ---- offline and sync ----------------------------------------------------
  offline_expired: {
    status: 409, retryable: false,
    clientAction: 'stop queueing; force a sync and reload',
  },
  stale_beyond_window: {
    status: 202, retryable: false,
    clientAction: 'the batch is quarantined; drop it locally and tell the user',
  },
  lease_force_released: {
    status: 202, retryable: false,
    clientAction: 'discard local state for this session and reload',
  },
  lease_conflict: {
    status: 202, retryable: false,
    clientAction: 'the batch is quarantined; reload rather than resend',
  },
  forbidden_operation: {
    status: 202, retryable: false,
    clientAction: 'a client bug: these operations may never be performed offline',
  },

  // ---- entitlement ---------------------------------------------------------
  upgrade_required: {
    status: 402, retryable: false,
    clientAction: 'show the billing banner; retrying will not help',
  },
  entitlement_unavailable: {
    // The one genuinely transient refusal in the set: the cache could not be
    // read, which fails closed but resolves on its own.
    status: 503, retryable: true,
    clientAction: 'back off and retry with the same idempotency key',
  },

  // ---- setup and data ------------------------------------------------------
  unreciped_fire: {
    status: 422, retryable: false,
    clientAction: 'a setup gap, not transient; surface it to a manager',
  },
  missing_expansion: {
    status: 500, retryable: false,
    clientAction: 'ours; page someone',
  },
  insufficient_stock: {
    // ADMIN surface only. A waste entry that would drive the balance negative is
    // a typo by someone looking at the stock; an order-time deduction never
    // refuses.
    status: 409, retryable: false,
    clientAction: 'the counted quantity is wrong; correct it',
  },
  over_receipt_exceeds_tolerance: {
    status: 422, retryable: false,
    clientAction: 'raise the tolerance, amend the order, or record an adjustment',
  },
  over_receipt_reason_required: {
    status: 422, retryable: false,
    clientAction: 'collect a reason and resubmit',
  },
  manual_settlement_incomplete: {
    status: 422, retryable: false,
    clientAction: 'collect the missing reference, reason or authoriser',
  },

  // ---- the admin surface ---------------------------------------------------
  fields_not_writable: {
    // 422 rather than 403: the caller has the permission for this route, and the
    // field they tried to set belongs to a DIFFERENT route with a different key.
    // The message names what the route does accept.
    status: 422, retryable: false,
    clientAction: 'that field has its own route and its own permission; use it',
  },
  field_value_not_scalar: {
    status: 422, retryable: false,
    clientAction: 'a client bug: send a string, number, boolean or null',
  },
  resource_not_archivable: {
    // 405, because it is the METHOD that does not apply to this resource --
    // whatever references the row keeps it, and no state means archived.
    status: 405, retryable: false,
    clientAction: 'this resource has no archive state; there is nothing to retry',
  },
  declared_column_missing: {
    // Ours, and loud. A resource declaration naming a column the table does not
    // have would otherwise render as "not set" on every row.
    status: 500, retryable: false,
    clientAction: 'ours; the admin resource table is out of step with the schema',
  },
  nothing_to_update: {
    status: 400, retryable: false,
    clientAction: 'a client bug: the request body sets no field',
  },


  // ---- the control plane ---------------------------------------------------
  provisioning_key_reused: {
    // The key was seen before with a DIFFERENT request. Retrying is the one
    // thing that must not happen: the client believes two different tenants are
    // the same one, and the alternative to refusing is handing back somebody
    // else's tenant.
    status: 409, retryable: false,
    clientAction: 'a client bug: never reuse an idempotency key for a different tenant',
  },
  platform_role_unknown: {
    status: 422, retryable: false,
    clientAction: 'a client bug: the role key is not one of the fixed five',
  },
  platform_password_too_short: {
    status: 400, retryable: false,
    clientAction: 'show the length requirement and let the granter retype it',
  },
  platform_grant_exceeds_authority: {
    // The subset rule: a granter cannot hand out a permission they do not
    // hold themselves. Same shape as the tenant-side grant refusal.
    status: 403, retryable: false,
    clientAction: 'the granter’s own role does not cover everything the target role holds',
  },
  provision_input_invalid: {
    status: 400, retryable: false,
    clientAction: 'show the field requirement and let the user correct it',
  },
  owner_reset_reason_required: {
    status: 422, retryable: false,
    clientAction: 'ask for a reason: a new link after sign-up resets the manager’s password',
  },
  row_not_found: {
    status: 404, retryable: false,
    clientAction: 'reload the list; that row is not visible to this session',
  },
  slug_invalid: {
    status: 400, retryable: false,
    clientAction: 'show the slug rule and let the user correct it',
  },
  access_invalid: {
    status: 400, retryable: false,
    clientAction: 'show the detail; nothing was changed',
  },
  access_user_unknown: {
    status: 404, retryable: false,
    clientAction: 'reload the access list',
  },
  access_authority_refused: {
    status: 403, retryable: false,
    clientAction: 'show the detail; someone with more authority has to do this',
  },
  printer_address_invalid: {
    // A printer on the restaurant's network: private IPv4, raw-printing port.
    status: 400, retryable: false,
    clientAction: 'show the detail next to the IP address or port',
  },
  setup_invalid: {
    status: 400, retryable: false,
    clientAction: 'show the detail next to the field it names',
  },
  setup_conflict: {
    status: 409, retryable: false,
    clientAction: 'show the detail; choose another name or barcode',
  },
  setup_row_not_found: {
    status: 404, retryable: false,
    clientAction: 'reload the list; the row was removed or belongs elsewhere',
  },
  setup_branch_required: {
    status: 422, retryable: false,
    clientAction: 'choose a branch, then retry with ?branchId=',
  },
  unroutable_at_branch: {
    status: 422, retryable: false,
    clientAction: 'add the kitchen at this branch, or pick one this branch has',
  },
  station_still_routed: {
    status: 409, retryable: false,
    clientAction: 'move the named dishes to another kitchen first',
  },
  branch_conflict: {
    status: 422, retryable: false,
    clientAction: 'do not send branchId from a branch session',
  },
  branding_invalid: {
    status: 400, retryable: false,
    clientAction: 'show the detail next to the address, colour or logo field',
  },
  logo_not_found: {
    status: 404, retryable: false,
    clientAction: 'show the restaurant name instead of a logo',
  },
  grant_branch_unknown: {
    status: 404, retryable: false,
    clientAction: 'reload the branch list; the branch is gone or archived',
  },
  grant_branch_conflict: {
    status: 422, retryable: false,
    clientAction: 'do not send branchId from a branch session; the session branch is used',
  },
  staff_invite_invalid: {
    status: 400, retryable: false,
    clientAction: 'show the detail on the staff form',
  },
  tenant_staff_unknown: {
    status: 404, retryable: false,
    clientAction: 'reload the restaurant\'s staff list',
  },
  tenant_staff_is_manager: {
    status: 409, retryable: false,
    clientAction: 'a manager account signs in with email and password and is not changed here',
  },
  tenant_staff_uses_pin: {
    status: 409, retryable: false,
    clientAction: 'staff sign in with their till PIN; set or reset the PIN instead of a password',
  },
  tenant_staff_invalid: {
    status: 422, retryable: false,
    clientAction: 'correct the field named in the message and send it again',
  },
  staff_identifier_taken: {
    status: 409, retryable: false,
    clientAction: 'show the detail next to the email or staff code',
  },
  staff_invite_unknown: {
    status: 404, retryable: false,
    clientAction: 'reload the staff list',
  },
  slug_unchanged: {
    status: 409, retryable: false,
    clientAction: 'nothing to do: that is already the restaurant\'s address',
  },
  slug_taken: {
    status: 409, retryable: false,
    clientAction: 'show "This restaurant slug is already in use. Please choose another slug."',
  },
  restaurant_not_found: {
    status: 404, retryable: false,
    clientAction: 'show the Restaurant Not Found page',
  },
  owner_invite_missing: {
    status: 409, retryable: false,
    clientAction: 'this restaurant has no owner invite to re-issue',
  },
  plan_status_invalid: {
    status: 400, retryable: false,
    clientAction: 'send active or retired',
  },
  subscription_unknown: {
    status: 404, retryable: false,
    clientAction: 'reload the restaurant list',
  },
  subscription_not_renewable: {
    status: 409, retryable: false,
    clientAction: 'only a trialing, active or past-due subscription can be renewed',
  },
  renewal_periods_invalid: {
    status: 400, retryable: false,
    clientAction: 'choose from 1 to 12 periods',
  },
  restaurant_unknown: {
    // Also the answer a Salesperson gets for a restaurant outside their own
    // book: the list never showed it to them, and a 403 would confirm it exists.
    status: 404, retryable: false,
    clientAction: 'reload the restaurant list; this one is not visible to you',
  },
  tenant_not_deactivatable: {
    status: 409, retryable: false,
    clientAction: 'only an active restaurant can be deactivated; one behind on payment is on the ladder',
  },
  tenant_not_deactivated: {
    status: 409, retryable: false,
    clientAction: 'reload; this restaurant is not deactivated',
  },
  tenant_edit_invalid: {
    status: 400, retryable: false,
    clientAction: 'show the field requirement and let the user correct it',
  },
  plan_unknown: {
    status: 404, retryable: false,
    clientAction: 'reload the plan list',
  },
  plan_retired: {
    status: 409, retryable: false,
    clientAction: 'a retired plan takes no new versions',
  },
  plan_terms_invalid: {
    status: 400, retryable: false,
    clientAction: 'show which price, period, limit or feature was refused',
  },
  platform_user_unknown: {
    status: 404, retryable: false,
    clientAction: 'reload the staff list',
  },
  platform_user_edit_invalid: {
    status: 400, retryable: false,
    clientAction: 'show the field requirement and let the user correct it',
  },
  platform_self_status_change: {
    status: 409, retryable: false,
    clientAction: 'another administrator has to change this account’s status',
  },
  tenant_slug_unknown: {
    status: 404, retryable: false,
    clientAction: 'check the slug; it is public and unique, so this one does not exist',
  },
  tenant_not_impersonable: {
    // Purged: there is nothing left to see. hard_lock is deliberately NOT here --
    // a locked-out tenant is exactly the one support needs to get into.
    status: 409, retryable: false,
    clientAction: 'this tenant is purged; there is no data left to support',
  },
  impersonation_write_not_permitted: {
    // 403, not 422: the request is well-formed and this role may not make it.
    status: 403, retryable: false,
    clientAction: 'start a read-only session, or have someone holding platform.impersonation.write start it',
  },
  impersonation_session_not_revocable: {
    status: 404, retryable: false,
    clientAction: 'reload the session list; it is already revoked or never existed',
  },
  subscription_not_live: {
    status: 409, retryable: false,
    clientAction: 'a cancelled or expired subscription is re-sold as a new one, not edited',
  },
  plan_version_unknown: {
    status: 404, retryable: false,
    clientAction: 're-read the plan list; that version id does not exist',
  },
  plan_version_not_published: {
    status: 422, retryable: false,
    clientAction: 'publish the plan version before selling it',
  },
  plan_change_is_a_no_op: {
    status: 400, retryable: false,
    clientAction: 'a client bug: the request changes neither the plan version nor the quantity',
  },

  // ---- stock and purchasing ------------------------------------------------
  branch_scope_mismatch: {
    // The document is named by a uuid in the URL and the permission was resolved
    // against the branch on the token. 403 rather than 404: the caller holds the
    // key, just not at the branch the document lives at, and saying so is not a
    // probing signal -- they already had to know the id.
    status: 403, retryable: false,
    clientAction: 'switch to the branch the document belongs to; retrying here cannot work',
  },
  supplier_catalogue_incomplete: {
    // A purchase-order line is priced from app.supplier_product, never from the
    // request. Four ways that read yields nothing -- unknown supplier, archived
    // supplier, product not listed, no list price -- and one fix.
    status: 422, retryable: false,
    clientAction: 'list the product against the supplier with a price, then re-raise the order',
  },

  // ---- the reporting surface -----------------------------------------------
  report_range_invalid: {
    status: 400, retryable: false,
    clientAction: 'a client bug: send ?from=YYYY-MM-DD&to=YYYY-MM-DD business dates within the limit',
  },
  report_range_unservable: {
    // Not a client bug and NOT retryable as-is: the range reaches into a business
    // day that is still trading, so the document would be partial and would not
    // match itself tomorrow. Narrowing the range is the fix.
    status: 422, retryable: false,
    clientAction: 'ask again for a range ending before the branch current business date',
  },
  report_branch_required: {
    status: 400, retryable: false,
    clientAction: 'this report is per-branch; sign in at the branch rather than naming one',
  },
  report_dimension_unknown: {
    status: 400, retryable: false,
    clientAction: 'a client bug: use item, category, station, hour, staff or branch',
  },
  stock_count_required: {
    status: 400, retryable: false,
    clientAction: 'name the count sheet with ?countId=; there is no list-counts read yet',
  },

  // ---- privacy -------------------------------------------------------------
  pii_subject_not_found: {
    status: 404, retryable: false,
    clientAction: 'reload the list; that record does not exist in this tenant',
  },
  pii_reason_required: {
    status: 422, retryable: false,
    clientAction: 'collect a reason for the bulk export and resend',
  },
  pii_export_too_wide: {
    status: 422, retryable: false,
    clientAction: 'narrow the export; it is refused rather than silently truncated',
  },

  // ---- grants, credentials and enrolment -----------------------------------
  role_unknown: {
    status: 404, retryable: false,
    clientAction: 'reload the role list; that role is not in this tenant',
  },
  grant_refused: {
    // 403 rather than 422: the request is well formed and it is one this
    // signed-in person may not make. Either the role holds a permission the
    // granter cannot delegate, or the role itself violates separation of duties
    // -- in which case nobody may assign it at any seniority.
    status: 403, retryable: false,
    clientAction: 'a more senior grantor is needed, or the role itself is not assignable',
  },
  grant_scope_mismatch: {
    status: 422, retryable: false,
    clientAction: 'sign in at the branch the role belongs to, or at the tenant level',
  },
  credential_secret_refused: {
    status: 422, retryable: false,
    clientAction: 'a client bug: this route revokes a credential and never sets one',
  },
  credential_type_unknown: {
    status: 422, retryable: false,
    clientAction: 'name password or pin; a manager has both and guessing locks one',
  },
  branch_scope_required: {
    status: 422, retryable: false,
    clientAction: 'sign in at the branch; a tenant-level session names none',
  },

  // ---- recipe revision -----------------------------------------------------
  recipe_unknown: {
    status: 404, retryable: false,
    clientAction: 'reload the recipe list; it does not exist in this tenant',
  },
  recipe_revision_invalid: {
    status: 422, retryable: false,
    clientAction: 'a client bug: state every line, each naming one component and an integer quantity',
  },
  recipe_component_unknown: {
    status: 422, retryable: false,
    clientAction: 'the product is absent or the sub-recipe has no published version; publish it first',
  },

  // ---- request shape -------------------------------------------------------
  idempotency_key_required: {
    status: 400, retryable: false,
    clientAction: 'a client bug: generate a key before sending',
  },
  lease_token_required: {
    status: 400, retryable: false,
    clientAction: 'a client bug: claim a lease before mutating a session',
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: {
    // Fastify's own code, mapped for the same reason as the SQLSTATEs below: a
    // client sending `content-type: application/json` with no body on a DELETE
    // is making a client mistake, and it answered 500. A tablet retrying a 500
    // forever over a missing body is a queue that never drains.
    status: 400, retryable: false,
    clientAction: 'send a body, or omit the JSON content-type',
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    status: 415, retryable: false,
    clientAction: 'send application/json',
  },
  pan_refused: {
    status: 400, retryable: false,
    clientAction: 'a client bug; never retry',
  },

  // ---- ours ----------------------------------------------------------------
  tenant_context_required: {
    status: 500, retryable: false,
    clientAction: 'ours; page someone',
  },

  // ---- the order, and what refuses a line ---------------------------------
  session_not_open: {
    status: 409, retryable: false,
    clientAction: 'reload the table; the session has been closed',
  },
  session_version_conflict: {
    // NOT retryable, and that distinction is the reason `retryable` is a field.
    // The same request with the same key will be refused identically forever:
    // the client has to re-read the session and compose a new one. A queue that
    // retried this would sit on it until someone looked at the tablet.
    status: 409, retryable: false,
    clientAction: 're-read the board and resend with the version it returns',
  },
  session_has_unsettled_money: {
    status: 409, retryable: false,
    clientAction: 'settle or void the outstanding tender before closing',
  },
  table_occupied: {
    status: 409, retryable: false,
    clientAction: 'that table already has a party; reload the floor',
  },
  table_unavailable: {
    status: 422, retryable: false,
    clientAction: 'that table is archived or at another branch; reload the floor',
  },
  table_required: {
    status: 400, retryable: false,
    clientAction: 'choose a table, or open a parcel instead',
  },
  session_last_table: {
    status: 409, retryable: false,
    clientAction: 'the party keeps at least one table; move it instead',
  },
  table_not_in_session: {
    status: 409, retryable: false,
    clientAction: 'that table is not part of this party; reload the floor',
  },
  session_at_counter: {
    status: 409, retryable: false,
    clientAction: 'this order is numbered at the counter; it has no table to change',
  },
  service_type_mismatch: {
    status: 409, retryable: false,
    clientAction: 'dine-in and parcel actions do not mix; reload',
  },
  guest_count_invalid: {
    status: 400, retryable: false,
    clientAction: 'send a guest count from 1 to 500',
  },
  parcel_not_ready: {
    status: 409, retryable: false,
    clientAction: 'send every item and wait for the kitchen to mark it ready',
  },
  parcel_already_picked_up: {
    status: 409, retryable: false,
    clientAction: 'already handed over; reload the parcel list',
  },
  order_in_billing: {
    status: 409, retryable: false,
    clientAction: 'the order is with billing now; ask a manager to reopen it for KOT',
  },
  order_not_ready_for_billing: {
    status: 409, retryable: false,
    clientAction: 'KOT has not handed this order over yet; reload the billing queue',
  },
  nothing_to_bill: {
    status: 409, retryable: false,
    clientAction: 'add items before handing the order to billing',
  },
  items_not_sent: {
    status: 409, retryable: false,
    clientAction: 'send the remaining items to the kitchen, or remove them, then hand over',
  },
  bill_already_made: {
    status: 409, retryable: false,
    clientAction: 'a bill exists; void it before the order can go back to KOT',
  },
  reopen_reason_required: {
    status: 400, retryable: false,
    clientAction: 'send a reason of at least a few words',
  },
  bill_void: {
    status: 409, retryable: false,
    clientAction: 'this bill was voided; print the bill that replaced it',
  },
  cancel_reason_required: {
    status: 400, retryable: false,
    clientAction: 'send a reason of at least a few words',
  },
  order_has_payment: {
    status: 409, retryable: false,
    clientAction: 'money has been taken on this order; refund it instead of cancelling',
  },
  unassigned_guest_lines: {
    status: 422, retryable: false,
    clientAction: 'assign every line to a guest before splitting',
  },
  menu_item_not_orderable: {
    status: 409, retryable: false,
    clientAction: 're-read the menu; this item is not available right now',
  },
  modifier_not_permitted: {
    status: 422, retryable: false,
    clientAction: 'a client bug: that modifier does not belong to this item',
  },
  modifier_selection_out_of_bounds: {
    status: 422, retryable: false,
    clientAction: 'the selection breaks the group minimum or maximum',
  },
  combo_choice_required: {
    status: 422, retryable: false,
    clientAction: 'collect the missing combo choice and resend',
  },
  line_already_fired: {
    status: 409, retryable: false,
    clientAction: 'a fired line cannot be edited; void or comp it instead',
  },
  line_not_fired: {
    status: 409, retryable: false,
    clientAction: 'reload; this line has not reached the kitchen yet',
  },
  nothing_to_fire: {
    status: 409, retryable: false,
    clientAction: 'reload; there is nothing unfired on this order',
  },
  reason_required: {
    status: 422, retryable: false,
    clientAction: 'collect a reason code and resend',
  },
  adjustment_exceeds_original: {
    status: 422, retryable: false,
    clientAction: 'the void, comp or refund is larger than what it references',
  },
  discount_exceeds_authority: {
    // 403 rather than 422: this is not a malformed request, it is one this
    // signed-in person may not make. A manager override is the path.
    status: 403, retryable: false,
    clientAction: 'a manager with a higher cap has to authorise this',
  },
  parcel_charge_not_parcel: {
    status: 409, retryable: false,
    clientAction: 'a parcel charge goes on a parcel order only',
  },
  parcel_charge_above_max: {
    status: 422, retryable: false,
    clientAction: 'enter a parcel charge no higher than the branch allows',
  },
  till_period_unknown: {
    status: 400, retryable: false,
    clientAction: 'ask for day, week or month',
  },
  tax_settings_invalid: {
    status: 400, retryable: false,
    clientAction: 'send taxEnabled, taxAccountType, taxCalculationMode and (for VAT or OTHERS) taxRegistrationNo',
  },
  tax_settings_while_orders_open: {
    status: 409, retryable: false,
    clientAction: 'finish or cancel the open orders at this branch, then change how tax is charged',
  },
  tax_account_not_offered: {
    status: 409, retryable: false,
    clientAction: 'choose a tax account this restaurant\'s country has',
  },
  country_settings_invalid: {
    status: 400, retryable: false,
    clientAction: 'offer at least one known country and pick the default from among them',
  },
  country_not_offered: {
    status: 422, retryable: false,
    clientAction: 'choose an offered country; a Super Admin changes the list in platform settings',
  },
  currency_not_offered: {
    status: 422, retryable: false,
    clientAction: 'choose a currency an offered country bills in',
  },
  country_change_invalid: {
    status: 400, retryable: false,
    clientAction: 'show the field requirement and let the user correct it',
  },
  country_change_not_permitted: {
    status: 403, retryable: false,
    clientAction: 'ask a Super Admin to make the change, or to allow Sales to',
  },
  country_locked_after_billing: {
    status: 409, retryable: false,
    clientAction: 'the restaurant has billed, so its country is fixed; a move is a new restaurant',
  },
  business_type_locked: {
    status: 409, retryable: false,
    clientAction: 'the business has taken orders, so its type is fixed; a different kind of business is a new tenant',
  },
  module_disabled: {
    status: 402, retryable: false,
    clientAction: 'this business has not switched that module on; the Super Admin enables it, retrying will not help',
  },
  tenant_modules_invalid: {
    status: 400, retryable: false,
    clientAction: 'send known module keys, always including pos',
  },
  business_type_unavailable: {
    status: 400, retryable: false,
    clientAction: 'choose a business type the picker offers; planned types cannot be selected yet',
  },
  country_change_while_orders_open: {
    status: 409, retryable: false,
    clientAction: 'finish or cancel the open orders, then change the country',
  },
  country_change_unconfirmed: {
    status: 409, retryable: false,
    clientAction: 'show the preview and send confirm: true once the user agrees',
  },
  till_range_invalid: {
    status: 400, retryable: false,
    clientAction: 'choose a From and To date, From first, neither after today, at most 366 days apart',
  },
  parcel_charge_after_payment: {
    status: 409, retryable: false,
    clientAction: 'money is in on this bill; take the rest, or refund it to change the parcel charge',
  },
  parcel_charge_invalid: {
    status: 400, retryable: false,
    clientAction: 'send the parcel charge as whole paise, zero or more',
  },
  idempotency_key_reused: {
    // The key was seen before with a DIFFERENT body. Retrying is the one thing
    // that must not happen: the client believes two different writes are the
    // same one.
    status: 409, retryable: false,
    clientAction: 'a client bug: never reuse a key for a different request',
  },

  // ---- bill history, bill edits and day end (0086) -------------------------
  history_period_unknown: {
    status: 400, retryable: false,
    clientAction: 'choose today, yesterday, week, month, or a From and To date',
  },
  history_bill_unknown: {
    status: 404, retryable: false,
    clientAction: 'reload the history; that bill is not at this branch',
  },
  bill_edit_unknown: {
    status: 404, retryable: false,
    clientAction: 'reload the history; that bill is not at this branch',
  },
  bill_edit_reason_required: {
    status: 400, retryable: false,
    clientAction: 'ask for the reason for the edit (5 to 500 characters) and send it',
  },
  bill_edit_invalid: {
    status: 400, retryable: false,
    clientAction: 'a client bug: send removals by bill lineId and additions by menuItemId, whole quantities',
  },
  bill_edit_stale: {
    // Retrying would apply the edit to a bill nobody has looked at -- or apply it twice.
    status: 409, retryable: false,
    clientAction: 'reload the bill and make the edit again on what it says now',
  },
  bill_edit_not_editable: {
    status: 409, retryable: false,
    clientAction: 'show the reason; reload the bill (it may have been replaced by an edit)',
  },
  bill_edit_reduces_paid_bill: {
    status: 403, retryable: false,
    clientAction: 'the bill is paid: offer adding items only, and send a removal to a manager',
  },
  bill_edit_empties_bill: {
    status: 409, retryable: false,
    clientAction: 'keep at least one item; a manager cancels or refunds a whole order',
  },
  bill_edit_previous_day: {
    status: 403, retryable: false,
    clientAction: 'the till edits only today\'s bills; ask a manager to edit this one',
  },
  bill_edit_day_submitted: {
    status: 403, retryable: false,
    clientAction: 'the day is submitted and locked for the till; ask a manager to edit it or to allow POS bill editing',
  },
  bill_edit_reopen_first: {
    status: 409, retryable: false,
    clientAction: 'offer Reopen day, with a reason, then make the edit',
  },
  day_has_open_orders: {
    status: 409, retryable: false,
    clientAction: 'take payment for, or cancel, the open orders of the day, then submit',
  },
  day_has_no_bills: {
    status: 409, retryable: false,
    clientAction: 'nothing was billed that day; there is nothing to submit',
  },
  day_changed: {
    // The figures the person confirmed are not the figures now; submitting on
    // a retry would submit a day nobody reviewed.
    status: 409, retryable: false,
    clientAction: 'show the new count and totals and ask for confirmation again',
  },
  day_not_submitted: {
    status: 409, retryable: false,
    clientAction: 'reload; that day is not submitted, so it is already open to managers',
  },
  day_reopen_reason_required: {
    status: 400, retryable: false,
    clientAction: 'ask why the day is being reopened (5 to 500 characters)',
  },
  pos_editing_today_only: {
    status: 409, retryable: false,
    clientAction: 'POS bill editing is allowed for today only; edit a previous day as a manager',
  },
  pos_editing_day_open: {
    status: 409, retryable: false,
    clientAction: 'reload; the day is not submitted, so the till can already edit the bills of today',
  },
  pos_editing_reason_required: {
    status: 400, retryable: false,
    clientAction: 'ask why the till may edit the submitted bills again (5 to 500 characters)',
  },
  business_date_invalid: {
    status: 400, retryable: false,
    clientAction: 'send the business date as YYYY-MM-DD, not after today',
  },
  day_branch_required: {
    status: 422, retryable: false,
    clientAction: 'name the branch whose day it is (branchId)',
  },

  // ---- money ---------------------------------------------------------------
  bill_already_tendered: {
    status: 409, retryable: false,
    clientAction: 're-read the bill; money has already been taken against it',
  },
  payment_invalid: {
    status: 422, retryable: false,
    clientAction: 'fix the amounts or methods and try again',
  },
  payment_exceeds_balance: {
    // Only cash may exceed the balance (the rest is change); a card or UPI
    // amount above it is a keying mistake, never an unexplained credit.
    status: 409, retryable: false,
    clientAction: 're-read the bill and take no more than is still due',
  },
  bill_not_payable: {
    // Settled already, or voided. Retrying would be the double charge.
    status: 409, retryable: false,
    clientAction: 're-read the bill; there is nothing left to pay on it',
  },
  payment_bill_unknown: {
    status: 404, retryable: false,
    clientAction: 'reload; that bill is not at this restaurant',
  },
  invoice_already_issued: {
    status: 409, retryable: false,
    clientAction: 'reload; the invoice exists and is immutable',
  },
  lines_already_billed: {
    status: 409, retryable: false,
    clientAction: 'the table is already billed; a further bill must be a split',
  },
  pending_change_exists: {
    status: 409, retryable: false,
    clientAction: 'resolve the pending change before starting another',
  },

  // ---- the kitchen ---------------------------------------------------------
  cannot_advance: {
    status: 409, retryable: false,
    clientAction: 'the ticket has already moved; the board will refresh',
  },
  no_pending_change: {
    // 404, not a quiet success. "There was nothing to cancel" and "I cancelled
    // it" must not look the same to whoever is on the phone.
    status: 404, retryable: false,
    clientAction: 'nothing was queued, so nothing changed; re-read the subscription',
  },
  mixed_currency_period: {
    // One invoice carries one currency. A period whose segments disagree means
    // a plan was re-priced into another currency mid-period, which is a
    // decision about the customer, not one the invoice run can make.
    status: 422, retryable: false,
    clientAction: 'close the period at the re-pricing date and invoice each part separately',
  },
  guest_no_out_of_range: {
    // Refused at the TAP, not at bill time. The column's CHECK only requires
    // > 0, so guest 9 at a table of four would store fine and then be
    // unsplittable to anybody -- a refusal in front of the customer instead of
    // in front of the waiter.
    status: 422, retryable: false,
    clientAction: 'change the cover count on the table, then assign the line again',
  },
  purchase_order_unknown: {
    // 404, not an empty detail. A receiving clerk holding a paper note needs to
    // know whether the order does not exist or merely has no lines yet.
    status: 404, retryable: false,
    clientAction: 'the order does not exist for this restaurant; go back to the list',
  },
  branch_required: {
    // A head-office session has no branch, and stock in two kitchens does not
    // add up to a number that matches any shelf, so the read refuses instead of
    // summing them.
    status: 400, retryable: false,
    clientAction: 'pick a branch; this figure only means something per branch',
  },
  query_parameter_invalid: {
    // Refused rather than coerced: `below=abc` as NaN makes the predicate
    // `qty_base <= NaN`, which returns nothing and reads on screen as "nothing
    // is low on stock".
    status: 400, retryable: false,
    clientAction: 'the filter value is not a number; clear it and try again',
  },
  order_unknown: {
    // Not an empty ticket list: "nothing sent yet" and "wrong order" must differ.
    status: 404, retryable: false,
    clientAction: 'the order is not at this branch; reload the table',
  },
  print_job_unknown: {
    status: 404, retryable: false,
    clientAction: 'the ticket is not at this branch; reload the order tickets',
  },
  // One answer for unknown, revoked and a restaurant that cannot sign in: the
  // recovery is the same -- set the agent up again with a new token.
  print_agent_token_invalid: {
    status: 401, retryable: false,
    clientAction: 'stop polling and ask a manager for a new print agent token',
  },
  print_agent_unknown: {
    status: 404, retryable: false,
    clientAction: 'reload the print agents',
  },
  print_agent_invalid: {
    status: 400, retryable: false,
    clientAction: 'show the detail beside the agent form',
  },
  test_print_refused: {
    status: 409, retryable: false,
    clientAction: 'show the detail beside the printer',
  },
  station_unknown: {
    // A 404 rather than an empty list, because the kitchen screen that asks this
    // has no other way to tell a wrong station id from a quiet one.
    status: 404, retryable: false,
    clientAction: 'the station id is wrong or belongs to another branch; re-point the screen',
  },
  kds_version_conflict: {
    status: 409, retryable: false,
    clientAction: 're-read the board; another screen moved this ticket',
  },

  // ---- customers, points and consent --------------------------------------
  phone_required: {
    // 400 and not 422: the field is absent, not unacceptable. There is no
    // search, so a lookup without a complete number is not a narrower query --
    // it is no query at all.
    status: 400, retryable: false,
    clientAction: 'ask the diner for their number, or bill without one',
  },
  phone_unusable: {
    // Refused rather than repaired. `normalisePhone` invents exactly one thing
    // -- the country code on a bare ten-digit number -- and anything else that
    // does not parse is a typo. A stored typo is a customer who can never be
    // matched again, which is discovered months later as a diner with no points.
    status: 422, retryable: false,
    clientAction: 'check the digits with the diner and enter it again',
  },
  bill_unknown: {
    status: 404, retryable: false,
    clientAction: 'the bill does not exist for this restaurant; re-read the table',
  },
  customer_unknown: {
    status: 404, retryable: false,
    clientAction: 'the customer does not exist for this restaurant; look them up by phone',
  },
  customer_erased: {
    // 409, because the record EXISTS and cannot be used. A 404 would be a lie
    // that invites the caller to create a second record for the same person,
    // which is precisely what the erasure was meant to prevent.
    status: 409, retryable: false,
    clientAction: 'this person asked to be forgotten; bill without a customer',
  },
  bill_not_attachable: {
    status: 409, retryable: false,
    clientAction: 'the bill is voided, or points have already moved against it; adjust both balances instead',
  },
  bill_has_no_customer: {
    status: 422, retryable: false,
    clientAction: 'attach the diner by phone first, then redeem',
  },
  bill_not_redeemable: {
    status: 409, retryable: false,
    clientAction: 'this bill takes no further tender',
  },
  consent_channel_unknown: {
    status: 400, retryable: false,
    clientAction: 'a client bug: send whatsapp, sms, email or call',
  },
  consent_evidence_required: {
    // An imported grant with no provenance is the row a regulator discounts, so
    // the schema will not hold it and this is the legible half of that refusal.
    status: 422, retryable: false,
    clientAction: 'state where the list came from and when it was collected',
  },
  loyalty_inactive: {
    status: 409, retryable: false,
    clientAction: 'no programme is running; points already earned are kept',
  },
  loyalty_below_minimum: {
    status: 422, retryable: false,
    clientAction: 'redeem at least the programme minimum, or nothing',
  },
  loyalty_insufficient: {
    // The detail names the balance, so the cashier can offer what is actually
    // there instead of guessing downward.
    status: 422, retryable: false,
    clientAction: 'offer the balance the detail names, or take the rest another way',
  },
  loyalty_exceeds_bill: {
    // A tender may not exceed what is owed -- `assert_billing_invariants`
    // refuses it -- so without this the points would be spent and lost.
    status: 422, retryable: false,
    clientAction: 'redeem fewer points; a tender cannot exceed what is outstanding',
  },
  loyalty_already_redeemed: {
    // The partial unique index, reported by name. Two taps on one bill is a
    // person, not a bug, and the honest answer is that the first one worked.
    status: 409, retryable: false,
    clientAction: 'points were already spent on this bill; re-read it',
  },
  loyalty_adjustment_zero: {
    status: 422, retryable: false,
    clientAction: 'an adjustment of zero changes nothing; send a signed amount',
  },
  points_not_an_integer: {
    status: 400, retryable: false,
    clientAction: 'send a whole number of points',
  },
  // `reason_required` is NOT re-declared here: it already exists above for the
  // order adjustments, with the same status and the same instruction, and a
  // second entry would be two spellings of one rule. A manual points
  // adjustment reuses it, which is correct -- it is the same control.
  field_invalid: {
    status: 400, retryable: false,
    clientAction: 'that field is the wrong shape; the detail names it',
  },

  // ---- the branch's GST position ------------------------------------------
  branch_unknown: {
    // 404 and not an empty read. A manager pointed at the wrong branch and a
    // branch that has been archived are different problems, and a null-shaped
    // success made both look like "this branch has no GST details yet".
    status: 404, retryable: false,
    clientAction: 'the branch id is wrong or belongs to another restaurant; re-pick it',
  },
  branch_has_open_trade: {
    // The refusal that keeps one bill on one tax position. A branch mid-service
    // has lines already stamped at the old rate; new lines would take the new
    // one, and the bill would show both with nothing on the paper to explain
    // it. The detail carries the counts so the message is actionable.
    status: 409, retryable: false,
    clientAction: 'bill and close the open tables first, then change the GST position',
  },
  gst_registration_invalid: {
    // 400 and its own name rather than the generic `field_required` the
    // not-null mapping produces: `unstated` is a real column value that this
    // route must not accept, and "the write was refused by
    // branch_gst_change_to_not_unstated" is a constraint name where the honest
    // answer is that the field is wrong.
    status: 400, retryable: false,
    clientAction:
      "send 'registered', 'composition' or 'unregistered'. A composition taxable "
      + 'person holds a GSTIN and may not collect tax, which is why it is its own '
      + "position; 'unstated' is a legacy value nothing may move a branch into",
  },
  gstin_required: {
    // Refused before the transaction, so the owner is told what to do about a
    // number that has not arrived from the department yet -- which the CHECK
    // name cannot tell them.
    status: 400, retryable: false,
    clientAction: 'enter the GSTIN, or leave the branch unregistered until it arrives',
  },
  gst_period_spans_registration_change: {
    // 422 and the same shape as `mixed_currency_period`: the request is
    // well-formed and the data is sound; the PERIOD is the thing that cannot be
    // filed as one. Reported rather than summed, because the sum looks exactly
    // like a period with genuinely exempt items.
    status: 422, retryable: false,
    clientAction: 'run the return for each side of the change date and file them separately',
  },
  gst_position_unchanged: {
    // Reported rather than absorbed as a quiet success: an owner who believes
    // they have registered the branch and has not will find out from a filed
    // return, which is the most expensive place to find out.
    status: 409, retryable: false,
    clientAction: 'the branch already holds that position; nothing needed changing',
  },

  // ---- the tax head, and who the supply was made to ------------------------
  gst_return_not_applicable: {
    // The wrong form, filled in correctly, is the failure mode this refuses. A
    // composition period's buckets all come out at zero and read as a lawful
    // nil return.
    status: 409, retryable: false,
    clientAction:
      'a composition taxable person files CMP-08 and GSTR-4 on turnover, not an '
      + 'outward-supply return; take the turnover from the sales report',
  },
  gst_return_wrong_jurisdiction: {
    // The dangerous outcome here is not an error, it is a SUCCESS: run against a
    // tenant in another regime, every GSTR-1 bucket comes out at zero and reads
    // as a lawful nil return. 409 and not 422 -- nothing about the request is
    // malformed, it is the wrong document for this restaurant.
    status: 409, retryable: false,
    clientAction:
      "this restaurant does not file India's GSTR-1; take the turnover from the "
      + "sales report until its own jurisdiction's return is built",
  },
  gst_period_has_unstated_treatment: {
    // Migration 0050 could not reconstruct the head for a bill that charged tax
    // at a branch with no state code, so it recorded that it could not rather
    // than guessing. Filing those under a guessed head is the failure 0037
    // describes in capitals: the total is right and the document is worthless,
    // because credit under the wrong head is disallowed. 409 and not 422 --
    // nothing about the request is malformed, the data is not filable yet.
    status: 409, retryable: false,
    clientAction:
      'answer the GST question for this branch, then run the return for periods '
      + 'after that date; the earlier bills need a treatment decision',
  },
  // ---- the jurisdiction, and the four ways it can refuse -------------------
  //
  // `tax_rate_does_not_halve` used to be here. It was the backstop for an odd
  // rate that could not split into equal halves -- correct for India and for
  // nowhere else, because a US combined rate of 7.25% is odd in basis points
  // and perfectly lawful. Migration 0052 replaced the halving with a
  // largest-remainder allocation over `share_bps`, so there is no longer a
  // rate this product cannot split, and the code is gone rather than kept as
  // an entry nothing can raise.
  premises_class_invalid: {
    // The body named something other than the two declarable values. 400 and
    // not 422: the field is wrong, rather than the request being well-formed
    // and unprocessable.
    status: 400, retryable: false,
    clientAction: "send premisesClass as 'standard' or 'specified'; there is no 'unstated' to declare",
  },
  premises_year_invalid: {
    status: 400, retryable: false,
    clientAction: 'send fyStartYear as the start year of a financial year, e.g. 2026 for 2026-27',
  },
  premises_class_unchanged: {
    // The row IS the audit trail, so one recording no movement is noise in the
    // one place that must not have any. Same posture as gst_position_unchanged.
    status: 409, retryable: false,
    clientAction: 'the branch already holds that classification for that year; nothing to change',
  },
  premises_year_not_started: {
    // Declaring forward would start charging the override on 1 April with
    // nobody deciding again.
    status: 422, retryable: false,
    clientAction: 'declare the classification for a financial year that is under way',
  },
  tax_jurisdiction_required: {
    // `POST /tenants` with the field omitted. Its own code rather than the
    // not-null mapping, because the useful part of the answer is the catalogue
    // and which entries have rules -- and because "which regime does this
    // restaurant trade under" is a question somebody has to go and ASK, not a
    // field they forgot to type.
    status: 422, retryable: false,
    clientAction:
      'send taxJurisdiction as a two-letter country code; the refusal lists the '
      + 'catalogue and marks which jurisdictions are implemented',
  },
  tenant_regime_missing: {
    // A tenant context pointing at a tenant with no control-plane row. Not the
    // caller's fault and not fixable by them, so 500 and named -- the log says
    // what happened instead of "internal_error". Same posture as
    // tenant_context_missing.
    status: 500, retryable: false,
    clientAction:
      'this is a broken tenant record on our side; nothing the caller can change '
      + 'will fix it',
  },
  tax_jurisdiction_unknown: {
    // A code that is not in the catalogue at all. Almost always a typo or a
    // client sending something other than ISO 3166-1 alpha-2.
    status: 422, retryable: false,
    clientAction:
      'send a two-letter country code from the jurisdiction catalogue; '
      + 'GET /platform/tax-jurisdictions lists them',
  },
  tax_jurisdiction_not_implemented: {
    // Deliberately a DIFFERENT code from the one above. "We have not built
    // Malaysia yet" is a roadmap question; "MY is not a code we recognise" is a
    // typo. Sending both to one code sends two different readers to one wrong
    // place. 422 and not 501: the request is well-formed, and the thing that
    // cannot be processed is this tenant's setup.
    status: 422, retryable: false,
    clientAction:
      'this country\'s tax rules are not built yet, so no bill can be raised '
      + 'under them; the refusal names the jurisdictions that are',
  },
  tax_treatment_unknown: {
    // A treatment the jurisdiction does not define. Reaching this from a route
    // means a client named one; reaching it from the return means a bill holds
    // a value the catalogue lost, which is a migration to write and not
    // something a till can fix.
    status: 422, retryable: false,
    clientAction:
      'the refusal names the treatments this jurisdiction defines; use one of them',
  },
  tax_heads_missing: {
    // A taxable treatment with no head to collect under -- a half-filled
    // jurisdiction catalogue. `platform.assert_tax_shares_whole` refuses that
    // shape at COMMIT, so this fires only on a catalogue that predates the
    // trigger or was loaded around it.
    status: 422, retryable: false,
    clientAction:
      'the jurisdiction catalogue is incomplete for this treatment; this is a '
      + 'platform setup gap, not something the restaurant can correct',
  },
  refund_spans_tax_rates: {
    // Same posture as mixed_currency_period: apportioning a part-refund across
    // two rates is a convention that decides how much output tax is reclaimed,
    // and a write path may not pick one silently.
    status: 409, retryable: false,
    clientAction: 'refund the whole bill, or raise one refund per rate',
  },
  refund_bill_unknown: {
    status: 404, retryable: false,
    clientAction: 'the bill does not exist in this restaurant; nothing to refund',
  },
  recipient_incomplete: {
    // A GSTIN with no legal name is an invoice a company cannot claim credit
    // against, and `bill_b2b_named` refuses the pair half-filled. Its own code
    // rather than `field_required`, which belongs to the not-null mapping.
    status: 400, retryable: false,
    clientAction: 'a B2B bill needs both the company name and its GSTIN',
  },
  gstin_unusable: {
    // A stored typo is a B2B customer whose input credit is disallowed, which is
    // discovered by their accountant months later. Refused at the till.
    status: 400, retryable: false,
    clientAction: 'read the GSTIN back to the customer and re-enter it',
  },
  b2b_capture_disabled: {
    status: 409, retryable: false,
    clientAction:
      'turn on the company-GSTIN option in the tax settings; it is off by default',
  },

  // ---- setup gaps, not transient ------------------------------------------
  missing_recipe: {
    status: 422, retryable: false,
    clientAction: 'a setup gap; surface it to a manager',
  },
  unpublished_sub_recipe: {
    status: 422, retryable: false,
    clientAction: 'publish the sub-recipe first',
  },
  bom_too_deep: {
    status: 422, retryable: false,
    clientAction: 'flatten a sub-recipe; the tree is deeper than the limit',
  },
  no_tax_profile: {
    status: 422, retryable: false,
    clientAction: 'a setup gap: this branch has no tax profile',
  },
  tax_profile_invalid: {
    status: 422, retryable: false,
    clientAction: 'the profile does not sum to its rate; a manager must fix it',
  },

  // ---- offline -------------------------------------------------------------
  unknown_offline_operation: {
    status: 400, retryable: false,
    clientAction: 'a client bug: this operation kind is not in the allowed set',
  },

  // ---- integrations --------------------------------------------------------
  webhook_signature_invalid: {
    status: 401, retryable: false,
    clientAction: 'not a POS refusal; the caller signed the payload wrongly',
  },
  entitlement_warmup_failed: {
    status: 503, retryable: true,
    clientAction: 'transient: the cache could not be warmed; retry',
  },

  // ---- ours ----------------------------------------------------------------
  empty_expansion: {
    status: 500, retryable: false,
    clientAction: 'ours; page someone',
  },
  rollup_incomplete: {
    status: 500, retryable: false,
    clientAction: 'ours; a reporting rollup is missing a period',
  },
  malformed_auth_attempt: {
    status: 500, retryable: false,
    clientAction: 'ours; page someone',
  },
  malformed_public_outcome: {
    status: 500, retryable: false,
    clientAction: 'ours; page someone',
  },
  missing_attempt_resolution: {
    status: 500, retryable: false,
    clientAction: 'ours; page someone',
  },
  unexpected_attempt_resolution: {
    status: 500, retryable: false,
    clientAction: 'ours; page someone',
  },
  conflict_retry: {
    // Serialisation failure or deadlock. The one thing a tablet SHOULD retry
    // immediately, with the same key.
    status: 503, retryable: true,
    clientAction: 'retry immediately with the same idempotency key',
  },
};

/**
 * ###########################################################################
 * THE CODES THAT NEVER REACH A CLIENT, NAMED SO THE GATE CAN TELL THEM APART.
 *
 * These are boot refusals: a route with no audit posture, a permission on the
 * wrong plane, two handler maps claiming one name. The process does not start,
 * so there is no response to map them to -- and an entry in ERROR_CONTRACT would
 * be a claim that a client can see them, which would be worse than nothing
 * because someone would write a handler for it.
 *
 * The point of listing them at all is that the completeness gate has exactly two
 * buckets and no third. A new error class is either something a client is told
 * about, deliberately, with a status and an action -- or it is a refusal to boot.
 * "Nobody got round to it" is not a bucket, and that silence is how 41 named
 * domain refusals spent their lives being flattened into `500 internal_error`,
 * including `session_version_conflict`, which a POS hits on the ordinary path of
 * two waiters at one table.
 * ###########################################################################
 */
export const BOOT_REFUSALS: readonly string[] = [
  'attempt_posture_refused',
  // Raised by reportHandlers() at CONSTRUCTION, when a handler exists for a
  // report the registry does not declare. There is no request to answer.
  'report_not_declared',
  'credential_route_needs_attempt_posture',
  'duplicate_handler_key',
  'permission_plane_mismatch',
  'plan_gate_without_cache',
  'public_route_cannot_be_audited',
  'public_route_refused',
  // agentRoute.ts: a route declared on the print agent plane with a shape it
  // cannot have (a permission, a lease, a plan gate, an audit descriptor).
  'agent_route_refused',
];

/** Postgres codes that mean "try again", as opposed to "you were wrong". */
const RETRYABLE_PG_CODES = new Set(['40001', '40P01', '55P03', '57014']);

/**
 * ###########################################################################
 * A CONSTRAINT REFUSING A WRITE IS NOT AN INTERNAL ERROR.
 *
 * The schema is where a good deal of this system's correctness lives: deferred
 * constraint triggers verify combo allocation and billing invariants at COMMIT,
 * CHECKs bound the lease window, and unique indexes carry the idempotency rules.
 * When one of them fires, the caller did something the domain forbids -- which
 * is a 4xx with an action, not a 500.
 *
 * It reached a client as `500 internal_error` because `toErrorResponse` matched
 * on our own string codes and Postgres errors carry a five-character SQLSTATE.
 * Generating a second whole bill for one table -- refused correctly by
 * `assert_billing_invariants` -- answered "internal error, do not retry", and
 * forwarded the trigger's message with an order line UUID in it.
 *
 * So SQLSTATE is classified, and the message is NOT forwarded. The constraint
 * NAME is (it is a schema identifier, stable and useful in a bug report); the
 * row values are not.
 * ###########################################################################
 */
const CONSTRAINT_PG_CODES: Readonly<Record<string, { status: number; error: string }>> = {
  // A CHECK or a constraint trigger. Almost always one of ours, raised
  // deliberately with a message written for a person -- which is exactly why it
  // must not be forwarded: those messages name rows.
  '23514': { status: 409, error: 'invariant_refused' },
  '23P01': { status: 409, error: 'invariant_refused' },
  // A duplicate. Usually an idempotency or uniqueness rule doing its job.
  '23505': { status: 409, error: 'already_exists' },
  // References something absent, or something still referenced.
  '23503': { status: 422, error: 'reference_invalid' },
  // A required column was absent: the request was incomplete.
  '23502': { status: 400, error: 'field_required' },
  // A malformed uuid, number or date reached SQL. A client bug, and a 500 for it
  // sends someone looking at the server.
  '22P02': { status: 400, error: 'field_malformed' },
  // `app.tenant_id is not set` -- raised by app.current_tenant_id() when an
  // `app` table is touched with no tenant GUC. This is OURS, always: it means a
  // route reached a tenant table on a connection that has no tenant context,
  // and it is exactly how POST /tenants failed silently as a 500. Kept at 500
  // deliberately -- the caller did nothing wrong -- but named, so the log says
  // what happened instead of "internal_error".
  '28000': { status: 500, error: 'tenant_context_missing' },
};

/**
 * A sentence for the constraints a person can actually do something about.
 *
 * ###########################################################################
 * WHY THIS EXISTS.
 *
 * The generic mapping above answers `the write was refused by
 * bill_tax_treatment_consistent`, which is honest, stable, and useless to
 * whoever is holding the tablet. Migration 0048 already named the problem in
 * writing -- "a constraint name where the honest answer is a sentence" -- and
 * solved it there by giving that one route its own error code.
 *
 * The example this comment used to give was `tax_class_rate_halves` and an
 * owner typing 5.01%. That CHECK is gone -- 0052 deleted it, because a rate
 * only has to be even where a head is exactly half. The mechanism survived its
 * first example, which is what keying off the constraint NAME buys.
 *
 * That does not scale to a CHECK reachable through the GENERIC admin writer,
 * which has no per-resource code to raise. So the constraint NAME, which is
 * already safe to forward, gets a sentence keyed off it.
 *
 * It is deliberately small and deliberately not required: a constraint absent
 * from this map still answers with its name, which is the previous behaviour.
 * Only refusals a caller can act on belong here -- naming an internal
 * invariant in a sentence would invite a client to try to satisfy it.
 * ###########################################################################
 */
const CONSTRAINT_DETAIL: Readonly<Record<string, { status?: number; detail: string }>> = {
  // `tax_class_rate_halves` was the first entry here and is deliberately not
  // replaced: migration 0052 DELETED that constraint, because a rate has to be
  // even only where a head is exactly half, and it is not everywhere. The map
  // outlived its motivating example, which is the argument for keying off the
  // constraint name rather than hard-coding one route's refusal.
  bill_line_heads_match_treatment: {
    detail:
      'the tax heads on a bill line contradict the treatment stamped on the '
      + 'bill, or do not sum to the line tax. They are derived at bill time by '
      + 'src/modules/tax/registry.ts from the bill\'s own jurisdiction and must not be '
      + 'written by hand.',
  },
  bill_tax_treatment_consistent: {
    detail:
      'a bill that charges tax must name the state it was supplied in and the '
      + 'state that supplied it, and a bill that charges none must say so. This '
      + 'is stamped by generateBill; a hand-written bill has to state all three.',
  },
  bill_non_collecting_position_carries_no_tax: {
    // Renamed from `bill_unregistered_carries_no_tax` by migration 0051, which
    // widened it to cover the composition scheme. A constraint whose name says
    // one position while it enforces two is the drift this file exists to
    // avoid.
    detail:
      'this branch may not collect tax from a customer, so its bills cannot carry '
      + 'any. That is true of an unregistered branch and equally true of one on '
      + 'the composition scheme, which pays 5% of turnover itself. If the '
      + 'position has changed, state it on the branch first -- the change is '
      + 'refused while tables are open precisely so one bill never shows two.',
  },
  branch_gstin_iff_position_holds_one: {
    detail:
      'a branch holds a GSTIN exactly when its position involves a registration: '
      + 'Registered or Composition scheme. A branch stated Not registered may not '
      + 'carry a number, and either of the other two must.',
  },
  bill_recipient_state_matches_gstin: {
    detail:
      "a recipient's state code must match the first two characters of their "
      + 'GSTIN. It is derived from the GSTIN rather than asked for, so this '
      + 'firing means something wrote them separately.',
  },
  bill_b2b_named: {
    detail:
      'a B2B bill needs both the company GSTIN and its legal name: an invoice a '
      + 'company cannot identify itself on is one it cannot claim credit against.',
  },
  // The parcel charge (0081), set on the branch through the generic admin writer.
  branch_parcel_charge_taxed: {
    detail:
      'choose the tax rate for parcel charges before allowing one: packing on a '
      + 'parcel is taxed with the food, and an untaxed charge would under-collect.',
  },
  branch_parcel_charge_default_within_max: {
    detail: 'the parcel charge the till fills in cannot be more than the most it may charge.',
  },
  // The printer and bill layout (0078), all reachable through the generic admin writer.
  printer_network_is_thermal: {
    detail:
      'a network printer is sent receipt-printer commands by the server, so it '
      + 'must be a thermal printer. A laser or inkjet prints through the till\'s '
      + 'own print dialog: add it as USB.',
  },
  printer_paper_fits_type: {
    detail:
      'that paper does not fit that printer: a 2, 3 or 4-inch roll is for a thermal '
      + 'printer, and A5 or A4 for a laser or inkjet.',
  },
  printer_roll_is_portrait: {
    detail: 'a receipt roll prints portrait only; landscape is for A5 and A4 sheets.',
  },
  table_session_pickup_name_shape: {
    detail: 'the customer name is at most 40 characters; shorten it and confirm again.',
  },
  branch_bill_prints_a_copy: {
    detail: 'choose at least one copy to print: a till that prints nothing hands the kitchen nothing.',
  },
};

export function toErrorResponse(error: unknown): { status: number; body: ErrorResponse } {
  const code = (error as { code?: unknown }).code;

  if (typeof code === 'string' && code in ERROR_CONTRACT) {
    const mapping = ERROR_CONTRACT[code]!;
    return {
      status: mapping.status,
      body: {
        error: code,
        retryable: mapping.retryable,
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (typeof code === 'string' && code in CONSTRAINT_PG_CODES) {
    const mapping = CONSTRAINT_PG_CODES[code]!;
    // A constraint name for a CHECK or a unique index; a COLUMN name for a
    // not-null violation, which carries no constraint. Both are schema
    // identifiers -- safe to name, and the only part of a Postgres error that
    // helps the caller. `error.message` is not forwarded: it quotes row values.
    const named = (error as { constraint?: unknown }).constraint
      ?? (error as { column?: unknown }).column;
    const spelt = typeof named === 'string' ? CONSTRAINT_DETAIL[named] : undefined;
    return {
      status: spelt?.status ?? mapping.status,
      body: {
        error: mapping.error,
        retryable: false,
        detail: spelt?.detail
          ?? (typeof named === 'string' && named.length > 0
            ? `the write was refused by ${named}`
            : 'the write was refused by a database constraint'),
      },
    };
  }

  if (typeof code === 'string' && RETRYABLE_PG_CODES.has(code)) {
    const mapping = ERROR_CONTRACT['conflict_retry']!;
    return {
      status: mapping.status,
      body: {
        error: 'conflict_retry',
        retryable: true,
        detail: 'the write raced another and can be retried with the same key',
      },
    };
  }

  // Unmapped: loud and NOT retryable. A new error class that nobody mapped must
  // not be quietly presented as a client mistake the tablet can fix.
  return {
    status: 500,
    body: {
      error: 'internal_error',
      retryable: false,
      detail: error instanceof Error ? error.message : String(error),
    },
  };
}
