/**
 * The permission catalogue. This constant is the source of truth; the
 * platform.permission table is a projection of it, re-seeded idempotently on
 * every deploy.
 *
 * Keys for modules that do not exist yet are catalogue entries only -- they are
 * unreachable until the phase that builds those routes. Listing them here is not
 * scope creep: a permission key is a constant, and a catalogue that grows a key
 * at the same moment a route starts checking it has no way to tell existing
 * roles that something changed.
 *
 * Adding a key here is a deny-by-default event. System roles pick it up on the
 * next deploy from SYSTEM_ROLES; custom roles never do, automatically, ever.
 */

export type RiskClass = 'none' | 'financial' | 'escalation' | 'privacy';

export interface PermissionDefinition {
  readonly key: string;
  readonly module: string;
  readonly name: string;
  readonly description: string;
  /**
   * Omitted means 'none'. One boolean was carrying three meanings with three
   * different audiences and three different controls; a single exception report
   * mixing till fraud with PII access serves neither reader.
   *
   *   financial   reason code mandatory, surfaces in report.exception.view,
   *               read by the owner and loss prevention
   *   escalation  the subset-grant rule applies, approval path, read by security
   *   privacy     logged per record viewed, read by the DPO, and deliberately
   *               NEVER in the loss-prevention report
   *
   * Not itself an access control -- it selects which control applies.
   */
  readonly riskClass?: Exclude<RiskClass, 'none'>;
  /**
   * Required exactly when riskClass is 'financial', forbidden otherwise -- an
   * escalation or privacy key has no transaction/configuration meaning.
   *
   *   transaction   a per-event exception: void, refund, adjustment
   *   configuration a standing change: price, recipe, vendor master
   *
   * report.exception.view derives its two sections from this. An owner scanning
   * for till fraud should not have to page through menu edits.
   */
  readonly riskSubclass?: RiskSubclass;
}

export type RiskSubclass = 'transaction' | 'configuration';

export const PERMISSIONS = [
  // ---------------------------------------------------------------- tenant
  { key: 'tenant.settings.view', module: 'tenant', name: 'View tenant settings', description: 'Read tenant-level configuration.' },
  { key: 'tenant.settings.edit', module: 'tenant', name: 'Edit tenant settings', description: 'Change tenant name, timezone, currency and locale defaults.' },
  { key: 'tenant.billing.view', module: 'tenant', name: 'View subscription', description: 'Read the tenant’s own plan, invoices and payment status.' },

  // ---------------------------------------------------------------- branch
  { key: 'branch.view', module: 'branch', name: 'View branches', description: 'List and read branches.' },
  { key: 'branch.create', module: 'branch', name: 'Create branch', description: 'Open a new branch.' },
  { key: 'branch.edit', module: 'branch', name: 'Edit branch', description: 'Change branch name, code, timezone.' },
  { key: 'branch.archive', module: 'branch', name: 'Archive branch', description: 'Mark a branch inactive. Never deletes data.' },
  // Its own key, and financial/configuration rather than a plain branch edit.
  // This is the switch that decides whether every diner at this branch is
  // charged GST -- the same class of act as editing prices, and emphatically
  // not the same as renaming the place. A Branch Admin may do the latter and
  // must not be able to do this: the system roles list their keys explicitly,
  // so leaving it out of `branch_admin` is what withholds it.
  { key: 'branch.premises.state', module: 'branch', name: 'State the premises classification', description: 'Declare a branch a specified premises for a financial year. Every line sold there is then taxed at the jurisdiction override rate instead of the dish tax class.', riskClass: 'financial', riskSubclass: 'configuration' },
  { key: 'branch.gst.state', module: 'branch', name: 'State the branch GST position', description: 'Declare a branch GST-registered or unregistered. Decides whether GST is charged to diners; refused while the branch has open tables.', riskClass: 'financial', riskSubclass: 'configuration' },

  // ------------------------------------------------------------------ user
  { key: 'user.view', module: 'user', name: 'View staff', description: 'List and read staff records.' },
  { key: 'user.self.view', module: 'user', name: 'View own details', description: 'Read who you are signed in as: your own name, staff code, roles, branch and tablet. Never anyone else. Held by every built-in role, the same way the console self-read is.' },
  { key: 'user.invite', module: 'user', name: 'Invite staff', description: 'Send a staff invitation. Governed by the subset rule.' },
  { key: 'user.edit', module: 'user', name: 'Edit staff', description: 'Change a staff member’s name, contact details or employee code.' },
  { key: 'user.suspend', module: 'user', name: 'Suspend staff', description: 'Suspend or reinstate a staff account.' },
  { key: 'user.credential.reset', module: 'user', name: 'Reset credentials', description: 'Issue a new password-set or PIN-set flow for a staff member. Cannot set a secret directly.', riskClass: 'escalation' },
  { key: 'user.credential.unlock', module: 'user', name: 'Clear a lockout', description: 'Manager override for an exponentially backed-off PIN lockout.' },

  // ------------------------------------------------------------------ role
  { key: 'role.view', module: 'role', name: 'View roles', description: 'List roles and their permission sets.' },
  { key: 'role.create', module: 'role', name: 'Create role', description: 'Author a custom role by cloning. Governed by the subset rule.', riskClass: 'escalation' },
  { key: 'role.edit', module: 'role', name: 'Edit role', description: 'Change a custom role’s permission set. Governed by the subset rule.', riskClass: 'escalation' },
  { key: 'role.delete', module: 'role', name: 'Delete role', description: 'Remove a custom role that holds no active memberships.' },

  // ------------------------------------------------------------ membership
  { key: 'membership.view', module: 'membership', name: 'View assignments', description: 'See who holds which role at which scope.' },
  { key: 'membership.grant', module: 'membership', name: 'Assign a role', description: 'Grant a role at a scope. Governed by the subset rule.', riskClass: 'escalation' },
  { key: 'membership.revoke', module: 'membership', name: 'Revoke a role', description: 'Revoke a role assignment. Retains the record.' },

  // ----------------------------------------------------------------- audit
  { key: 'audit.view', module: 'audit', name: 'View audit log', description: 'Read the tenant’s own audit log.' },

  // ------------------------------------------------------------------ menu
  { key: 'menu.view', module: 'menu', name: 'View menu', description: 'Read categories, items and prices.' },
  { key: 'menu.category.edit', module: 'menu', name: 'Edit categories', description: 'Create, rename and reorder menu categories.' },
  { key: 'menu.item.create', module: 'menu', name: 'Create menu item', description: 'Add a new item to the menu.' },
  { key: 'menu.item.edit', module: 'menu', name: 'Edit menu item', description: 'Change an item’s name, description, modifiers or station routing.' },
  { key: 'menu.item.archive', module: 'menu', name: 'Archive menu item', description: 'Retire an item without deleting its history.' },
  { key: 'menu.price.edit', module: 'menu', name: 'Edit prices', description: 'Change menu prices.', riskClass: 'financial', riskSubclass: 'configuration' },
  { key: 'menu.availability.toggle', module: 'menu', name: 'Mark items unavailable', description: 'Eighty-six an item for the session. Needed by floor and kitchen staff.' },

  // ---------------------------------------------------------------- device
  { key: 'device.view', module: 'device', name: 'View registered terminals', description: 'List devices registered at a branch and their last-seen time.' },
  { key: 'device.register', module: 'device', name: 'Register a terminal', description: 'Issue a single-use enrolment token. A rogue terminal can accept PINs, so this is an escalation vector.', riskClass: 'escalation' },
  { key: 'device.revoke', module: 'device', name: 'Revoke a terminal', description: 'Immediately stop a device accepting PIN logins. Used when a terminal is lost or stolen.' },

  // ----------------------------------------------------------------- table
  { key: 'table.view', module: 'table', name: 'View floor plan', description: 'Read floors, sections and tables.' },
  { key: 'table.edit', module: 'table', name: 'Edit floor plan', description: 'Create and arrange floors, sections and tables.' },
  { key: 'table.session.open', module: 'table', name: 'Open a table', description: 'Seat a table and start a session.' },
  { key: 'table.session.close', module: 'table', name: 'Close a table', description: 'Close a settled table session.' },
  { key: 'table.session.transfer', module: 'table', name: 'Transfer a table', description: 'Move a session to another table or server.' },
  { key: 'table.session.merge', module: 'table', name: 'Merge tables', description: 'Combine sessions.' },
  { key: 'table.session.lease.force_release', module: 'table', name: 'Force-release a session lease', description: 'Take a session away from a device that holds its lease -- a dead or lost tablet. Writes arriving later from that device are QUARANTINED, never merged. Requires a reason code.', riskClass: 'escalation' },

  // --------------------------------------------------------------- kitchen
  { key: 'kitchen.station.view', module: 'kitchen', name: 'View stations', description: 'Read kitchen station configuration.' },
  { key: 'kitchen.station.edit', module: 'kitchen', name: 'Edit stations', description: 'Configure kitchen stations and their routing.' },

  // --------------------------------------------------------------- printer
  { key: 'printer.view', module: 'printer', name: 'View printers', description: 'Read printer configuration and job queue state.' },
  { key: 'printer.edit', module: 'printer', name: 'Edit printers', description: 'Configure printers, stations and fallbacks.' },
  { key: 'printer.job.retry', module: 'printer', name: 'Retry a print job', description: 'Requeue a failed print job.' },

  // ----------------------------------------------------------------- order
  { key: 'order.view', module: 'order', name: 'View orders', description: 'Read orders and their lines.' },
  { key: 'order.create', module: 'order', name: 'Create order', description: 'Start an order against a table session.' },
  { key: 'order.handover', module: 'order', name: 'Send order to billing', description: 'Mark an order ready for billing. From then on KOT can no longer change it; Billing owns it.' },
  { key: 'order.line.add', module: 'order', name: 'Add order line', description: 'Add an item to an open order.' },
  { key: 'order.line.remove', module: 'order', name: 'Remove a line before fire', description: 'Correct a mis-keyed line before the KOT fires. Not a cost event.' },
  { key: 'order.void', module: 'order', name: 'Void after fire', description: 'Void a line the kitchen has already started. Writes off cooked food; requires a reason code.', riskClass: 'financial', riskSubclass: 'transaction' },
  { key: 'order.comp', module: 'order', name: 'Comp an item', description: 'Give an item away. Requires a reason code.', riskClass: 'financial', riskSubclass: 'transaction' },
  { key: 'order.discount', module: 'order', name: 'Apply a discount', description: 'Discount an order. Bounded by the role’s discount cap, which is the real control.', riskClass: 'financial', riskSubclass: 'transaction' },
  { key: 'order.transfer', module: 'order', name: 'Transfer an order', description: 'Move an order between table sessions.' },
  { key: 'order.reopen', module: 'order', name: 'Reopen a closed order', description: 'Reopen an order after it was closed. Requires a reason code.', riskClass: 'financial', riskSubclass: 'transaction' },
  { key: 'order.cancel', module: 'order', name: 'Cancel an unpaid order', description: 'Cancel an order nobody will pay for: its unpaid bills are voided and its tables freed. Refused once any money has been taken -- that is a refund. Requires a written reason.', riskClass: 'financial', riskSubclass: 'transaction' },

  // ------------------------------------------------------------------- kot
  { key: 'kot.view', module: 'kot', name: 'View tickets', description: 'Read kitchen tickets.' },
  { key: 'kot.fire', module: 'kot', name: 'Fire a ticket', description: 'Send the ticket to the kitchen. Deducts stock.' },
  { key: 'kot.reprint', module: 'kot', name: 'Reprint a ticket', description: 'Ask for another paper copy of a fired ticket. A NEW print job, attributed to the requester -- never a retry of the original, which is the system attempting one delivery. Logged so a reprinting kitchen is not mistaken for failing hardware.' },
  { key: 'kot.ready', module: 'kot', name: 'Mark a ticket ready', description: 'In a restaurant without a kitchen screen, mark a fired ticket\'s food ready from KOT. Refused where a kitchen screen runs: there the kitchen marks it.' },
  { key: 'kot.recall', module: 'kot', name: 'Recall a ticket', description: 'Pull back a fired ticket. Requires a reason code.', riskClass: 'financial', riskSubclass: 'transaction' },

  // ------------------------------------------------------------------- kds
  { key: 'kds.view', module: 'kds', name: 'View the kitchen display', description: 'Read the station queue.' },
  { key: 'kds.item.advance', module: 'kds', name: 'Advance an item', description: 'Move an item to the next preparation state.' },
  { key: 'kds.item.bump', module: 'kds', name: 'Bump an item', description: 'Mark an item ready and clear it from the display.' },
  { key: 'kds.item.recall', module: 'kds', name: 'Recall a bumped item', description: 'Bring a bumped item back onto the display.' },

  // ------------------------------------------------------------------ bill
  { key: 'bill.view', module: 'bill', name: 'View bills', description: 'Read bills.' },
  { key: 'bill.generate', module: 'bill', name: 'Generate a bill', description: 'Produce a bill for a session.' },
  { key: 'bill.split', module: 'bill', name: 'Split a bill', description: 'Split a bill across covers.' },
  { key: 'bill.merge', module: 'bill', name: 'Merge bills', description: 'Combine bills within a session.' },
  { key: 'payment.settle.manual', module: 'payment', name: 'Record money taken outside the system', description: 'Key in a payment that a manual card machine or cash envelope took while the terminal was offline. NOT offline settlement: the bill and tender are recorded online, after the fact. Mandatory operator reference and reason code; surfaces in the exception report.', riskClass: 'financial', riskSubclass: 'transaction' },
  { key: 'bill.reprint', module: 'bill', name: 'Reprint a bill', description: 'Reprint an existing bill. Logged.' },
  { key: 'bill.void', module: 'bill', name: 'Void a bill', description: 'Void an issued bill. Requires a reason code.', riskClass: 'financial', riskSubclass: 'transaction' },
  { key: 'bill.edit', module: 'bill', name: 'Edit a bill of today', description: 'Correct a bill of the current business day until the day is submitted: an unpaid bill is reissued, a paid one may only gain items, collected as a supplementary bill. Requires a reason; never a previous day, never a submitted one.', riskClass: 'financial', riskSubclass: 'transaction' },
  { key: 'bill.edit.any', module: 'bill', name: 'Edit any bill', description: 'Edit a bill of any business day, including taking items off a paid bill (a refund). A submitted day must be reopened first. Requires a reason; recorded as a manager edit.', riskClass: 'financial', riskSubclass: 'transaction' },

  // --------------------------------------------------------------- payment
  { key: 'payment.view', module: 'payment', name: 'View payments', description: 'Read payment records.' },
  { key: 'payment.collect', module: 'payment', name: 'Take payment', description: 'Collect a tender against a bill. The till action.' },
  { key: 'till.summary.view', module: 'payment', name: 'View my takings', description: 'The till’s own X-read: the bills and payments THIS person took, by day, week or month. Never anyone else’s, and not a report: it travels with the till.' },
  { key: 'payment.tender.void', module: 'payment', name: 'Void a tender before close', description: 'Correct a mis-keyed tender in the same open session, before close. Not a refund.', riskClass: 'financial', riskSubclass: 'transaction' },
  { key: 'payment.refund', module: 'payment', name: 'Refund a closed bill', description: 'Refund against a closed bill. Requires a reason code and the original bill reference. Cash above threshold escalates.', riskClass: 'financial', riskSubclass: 'transaction' },
  { key: 'payment.settlement.view', module: 'payment', name: 'View cash-up', description: 'Read day-end settlement figures.' },
  { key: 'payment.settlement.close', module: 'payment', name: 'Submit the day’s bills', description: 'Day end: submit the business day once its bills are reviewed, with the bill count and totals as they stand. After it, no till can change that day’s bills.', riskClass: 'financial', riskSubclass: 'transaction' },
  { key: 'payment.settlement.reopen', module: 'payment', name: 'Reopen a submitted day', description: 'Reopen a submitted business day so its bills can be edited by a manager. Requires a reason; the submission is kept and stamped, never removed.', riskClass: 'financial', riskSubclass: 'transaction' },

  // -------------------------------------------------------------- customer
  { key: 'customer.view', module: 'customer', name: 'View customers', description: 'Read customer records without contact details.' },
  { key: 'customer.create', module: 'customer', name: 'Create customer', description: 'Register a customer, phone-identified.' },
  { key: 'customer.edit', module: 'customer', name: 'Edit customer', description: 'Amend a customer record.' },
  { key: 'customer.pii.view', module: 'customer', name: 'Reveal one customer’s contact details', description: 'Reveal phone and address for a SINGLE customer. One request, one record, one audit row. List endpoints return masked projections and never require this.', riskClass: 'privacy' },
  { key: 'customer.pii.export', module: 'customer', name: 'Bulk export customer contact details', description: 'Owner only. Mandatory reason code. The audit payload is a query descriptor plus a result count, never an id list.', riskClass: 'privacy' },
  // Erasure is not archiving. It destroys the name and replaces the phone with
  // an unmatchable token, keeping the row so the bills a GST return depends on
  // stay intact. Privacy-class because it is performed in answer to a DPDP
  // request and the DPO is the audience for the record of it.
  { key: 'customer.erase', module: 'customer', name: 'Erase a customer on request', description: 'Destroy a customer’s name and phone in place, answering a deletion request without deleting the bills that reference them. Irreversible.', riskClass: 'privacy' },
  // A legal act, and NOT part of customer.edit. Whoever may correct a
  // misspelled name must not thereby be able to record that a diner agreed to
  // marketing -- that statement is the restaurant's defence in a TRAI or DPDP
  // complaint, and it needs to have been made by somebody accountable for it.
  { key: 'customer.consent.record', module: 'customer', name: 'Record marketing consent', description: 'State that a customer agreed to, or withdrew from, contact on a channel. Append-only; a withdrawal is as consequential as a grant.' },

  // --------------------------------------------------------------- loyalty
  // Spending points is taking money off a bill, so it is financial and
  // transaction-class -- the same family as a discount, and it belongs to the
  // till.
  { key: 'loyalty.redeem', module: 'loyalty', name: 'Redeem points', description: 'Spend a customer’s points against a bill, as a tender. Bounded by their balance and by what is outstanding.', riskClass: 'financial', riskSubclass: 'transaction' },
  // DELIBERATELY NOT the same key as redeem. A cashier who can spend points
  // and also grant them can grant themselves points and spend them, which is
  // a till with no counterparty -- the same separation as void versus adjust
  // in stock, and vendor master versus purchase approval.
  { key: 'loyalty.adjust', module: 'loyalty', name: 'Adjust a points balance', description: 'Grant or remove points by hand, either direction, with a mandatory reason code. Never available to a role that can also redeem.', riskClass: 'financial', riskSubclass: 'transaction' },
  // Changing the earn rate re-prices every future bill's reward, which is the
  // same class of act as editing menu prices.
  { key: 'loyalty.program.edit', module: 'loyalty', name: 'Set the loyalty programme', description: 'Set the earn rate, the value of a point and the redemption minimum. Changes what every future bill grants.', riskClass: 'financial', riskSubclass: 'configuration' },

  // ------------------------------------------------------------------- tax
  // #########################################################################
  // THE RATES A MENU IS PRICED UNDER, WHICH NOBODY COULD SET.
  //
  // `app.menu_item.tax_class_id` is NOT NULL with a foreign key, and before
  // migration 0050 no route created a tax class and `provisionTenant` seeded
  // none. A restaurant provisioned through the product could not add a dish.
  //
  // There is deliberately no key for a component NAME. The head -- CGST+SGST or
  // IGST -- is derived per bill from the place of supply by
  // `src/modules/tax/registry.ts`, so there is nothing here for an owner to type and
  // nothing for them to get wrong. That is the whole point of 0050.
  // #########################################################################
  { key: 'tax.class.view', module: 'tax', name: 'View tax rates', description: 'Read the tax classes a menu item can be priced under.' },
  { key: 'tax.class.create', module: 'tax', name: 'Add a tax rate', description: 'Create a tax class. Orders snapshot the rate when they are taken, so a later change never moves tax already charged.', riskClass: 'financial', riskSubclass: 'configuration' },
  // Editing a rate is safe in exactly the way editing a menu price is: an order
  // line snapshots the rate at order time, so nothing already charged moves.
  { key: 'tax.class.edit', module: 'tax', name: 'Change a tax rate', description: 'Change a tax class name or rate. Applies to future orders only -- an order line snapshots its rate when it is added.', riskClass: 'financial', riskSubclass: 'configuration' },
  { key: 'tax.class.archive', module: 'tax', name: 'Retire a tax rate', description: 'Stop offering a tax class for new menu items. Dishes already priced under it keep their rate.', riskClass: 'financial', riskSubclass: 'configuration' },
  // How a branch charges tax (0083): on or off, GST / VAT / other / none,
  // forward or reverse. Configuration class for the same reason branch.gst.state
  // is: it changes what future documents charge and say about themselves.
  { key: 'tax.setting.edit', module: 'tax', name: 'Set the tax options', description: 'Decide whether and how a branch charges tax: on or off, the tax account (GST, VAT, other or none), whether prices include tax, and the VAT number on its bills. Refused while the branch has open orders.', riskClass: 'financial', riskSubclass: 'configuration' },

  // ------------------------------------------------------------------ bill
  // Not a till key and not an adjustment: typing the company name and GSTIN a
  // diner hands over is clerical, and it happens BEFORE the first tender because
  // `deny_tendered_bill_mutation` freezes the tax identity then. Being a till
  // key would have made `till-vs-record` refuse it to a manager, who has every
  // business doing it.
  { key: 'bill.recipient.set', module: 'bill', name: 'Record a company on a bill', description: 'Write the recipient GSTIN and legal name onto a bill, making it a B2B supply. Refused once the bill has been tendered against.' },

  // ------------------------------------------------------------- staff PII
  // Split out of customer.pii.view by migration 0049. Until then the route
  // named for customers read app_user, so one key revealed both -- and an
  // owner granting "look up a diner's phone" was also granting the staff
  // directory.
  { key: 'user.pii.view', module: 'user', name: 'Reveal one staff member’s contact details', description: 'Reveal email and phone for a SINGLE staff record. One request, one record, one privacy-log row. Separate from the customer key on purpose.', riskClass: 'privacy' },

  // ------------------------------------------------------------- inventory
  { key: 'inventory.view', module: 'inventory', name: 'View stock', description: 'Read stock levels.' },
  { key: 'inventory.waste', module: 'inventory', name: 'Record wastage', description: 'Write off stock that was consumed and produced no revenue -- spoilage, a returned dish, a staff meal, breakage. Separate from inventory.adjust ON PURPOSE: merging them would let whoever records spoilage also adjust the count that spoilage is measured against, which is the vendor-master-versus-approval shape. Requires a reason code.', riskClass: 'financial', riskSubclass: 'transaction' },
  { key: 'inventory.adjust', module: 'inventory', name: 'Adjust stock', description: 'Write a manual stock adjustment. Requires a reason code.', riskClass: 'financial', riskSubclass: 'transaction' },
  { key: 'inventory.count.perform', module: 'inventory', name: 'Perform a stock count', description: 'Record counted quantities.' },
  { key: 'inventory.count.approve', module: 'inventory', name: 'Approve a stock count', description: 'Commit a count and post its variance.', riskClass: 'financial', riskSubclass: 'transaction' },
  { key: 'inventory.transfer', module: 'inventory', name: 'Transfer stock', description: 'Move stock between branches or stores.' },

  // --------------------------------------------------------------- product
  { key: 'product.view', module: 'product', name: 'View products', description: 'Read the raw product list.' },
  { key: 'product.create', module: 'product', name: 'Create product', description: 'Add a purchasable product.' },
  { key: 'product.edit', module: 'product', name: 'Edit product', description: 'Change a product, its unit or its conversions.' },
  { key: 'product.archive', module: 'product', name: 'Archive product', description: 'Retire a product without deleting its history.' },

  // ---------------------------------------------------------------- recipe
  { key: 'recipe.view', module: 'recipe', name: 'View recipes', description: 'Read the bill of materials for menu items.' },
  { key: 'recipe.edit', module: 'recipe', name: 'Edit recipes', description: 'Change recipe lines. Directly changes stock deduction.', riskClass: 'financial', riskSubclass: 'configuration' },

  // -------------------------------------------------------------- supplier
  { key: 'supplier.view', module: 'supplier', name: 'View suppliers', description: 'Read suppliers.' },
  { key: 'supplier.create', module: 'supplier', name: 'Create supplier', description: 'Add a supplier.', riskClass: 'financial', riskSubclass: 'configuration' },
  { key: 'supplier.edit', module: 'supplier', name: 'Edit supplier', description: 'Amend supplier details and terms.', riskClass: 'financial', riskSubclass: 'configuration' },

  // -------------------------------------------------------------- purchase
  { key: 'purchase.order.view', module: 'purchase', name: 'View purchase orders', description: 'Read purchase orders.' },
  { key: 'purchase.order.create', module: 'purchase', name: 'Raise a purchase order', description: 'Draft a purchase order.' },
  { key: 'purchase.order.approve', module: 'purchase', name: 'Approve a purchase order', description: 'Commit spend against a supplier.', riskClass: 'financial', riskSubclass: 'transaction' },
  { key: 'purchase.receive', module: 'purchase', name: 'Receive goods', description: 'Record a goods receipt against a purchase order.' },

  // ---------------------------------------------------------------- report
  { key: 'report.sales.view', module: 'report', name: 'View sales reports', description: 'Read sales reporting.' },
  { key: 'report.sales.export', module: 'report', name: 'Export sales reports', description: 'Export sales data out of the system.' },
  { key: 'report.staff.view', module: 'report', name: 'View staff reports', description: 'Read per-staff activity reporting.' },
  { key: 'report.inventory.view', module: 'report', name: 'View stock reports', description: 'Read stock movement and variance reporting.' },
  { key: 'report.exception.view', module: 'report', name: 'View the exception report', description: 'Voids, comps, discounts, refunds and reopens with their reason codes. This is the control that makes the dangerous keys survivable.' },
] as const satisfies readonly PermissionDefinition[];

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

function keysWithRisk(riskClass: RiskClass): ReadonlySet<PermissionKey> {
  return new Set(
    PERMISSIONS.filter((p) => ('riskClass' in p ? p.riskClass : 'none') === riskClass).map(
      (p) => p.key,
    ),
  );
}

export function riskSubclassOf(key: PermissionKey): RiskSubclass | null {
  const found = PERMISSIONS.find((p) => p.key === key);
  if (!found) throw new Error(`unknown permission ${key}`);
  return 'riskSubclass' in found ? found.riskSubclass : null;
}

/** The two sections of report.exception.view, derived rather than enumerated. */
export function keysInExceptionSection(section: RiskSubclass): readonly PermissionKey[] {
  return PERMISSIONS.filter(
    (p) => ('riskSubclass' in p ? p.riskSubclass : null) === section,
  ).map((p) => p.key);
}

export function riskClassOf(key: PermissionKey): RiskClass {
  const found = PERMISSIONS.find((p) => p.key === key);
  if (!found) throw new Error(`unknown permission ${key}`);
  return 'riskClass' in found ? found.riskClass : 'none';
}

/**
 * Reason code mandatory; appears in report.exception.view.
 *
 * menu.price.edit and recipe.edit sit here but are config-class rather than
 * transaction-class: a standing change, not a per-event exception. That
 * distinction wants a second dimension eventually. Not now.
 */
export const FINANCIAL_KEYS = keysWithRisk('financial');

/** The subset-grant rule applies; needs an approval path. */
export const ESCALATION_KEYS = keysWithRisk('escalation');

/** Logged per record viewed. Never joined into the loss-prevention report. */
export const PRIVACY_KEYS = keysWithRisk('privacy');

/** Retained as the union of the three classes, for callers that only need "is this risky". */
export const DANGEROUS_KEYS: ReadonlySet<PermissionKey> = new Set([
  ...FINANCIAL_KEYS,
  ...ESCALATION_KEYS,
  ...PRIVACY_KEYS,
]);

export const PERMISSION_MODULES: readonly string[] = [
  ...new Set(PERMISSIONS.map((p) => p.module)),
];
