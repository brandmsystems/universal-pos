import type { RouteDefinition, RoutePlan } from '../core/middleware/routeRegistry.js';
import { handlerLookup, pathId, type Handler } from './lookup.js';
import type { PermissionKey } from '../modules/authz/permissions.js';
import { posRoutes } from './pos.js';

/**
 * The whole route inventory, in one place, so the coverage assertion has
 * something to read.
 */


/* ----------------------------------------------------------------- KDS --- */

/* --------------------------------------------------------------- admin --- */

/** Branch admin. CRUD over functions that already exist and are already tested. */
export const adminRoutes = (handlers: Record<string, Handler> = {}): readonly RouteDefinition[] => {
  const h = handlerLookup(handlers);
  const crud = (
    resource: string,
    keys: { view: PermissionKey; create?: PermissionKey; edit?: PermissionKey; archive?: PermissionKey },
    target: string,
    // `all` gates every generated route (the resource is a plan feature);
    // `create` gates only the insert (the resource counts against a limit).
    // `change` gates edit and archive (the resource is managed only on some plans).
    gates: { all?: RoutePlan; create?: RoutePlan; change?: RoutePlan } = {},
  ): RouteDefinition[] => {
    const changeGate = gates.change ?? gates.all;
    const plan = (gate: RoutePlan | undefined): { plan?: RoutePlan } =>
      gate === undefined ? {} : { plan: gate };
    const out: RouteDefinition[] = [{
      method: 'GET', url: `/admin/${resource}`, plane: 'tenant',
      permission: { plane: 'tenant', key: keys.view }, audit: 'none', handler: h(`${resource}.list`),
      ...plan(gates.all),
    }];
    if (keys.create !== undefined) out.push({
      method: 'POST', url: `/admin/${resource}`, plane: 'tenant',
      permission: { plane: 'tenant', key: keys.create },
      audit: { action: `${target}.created`, target }, handler: h(`${resource}.create`),
      ...plan(gates.create ?? gates.all),
    });
    if (keys.edit !== undefined) out.push({
      method: 'PATCH', url: `/admin/${resource}/:id`, plane: 'tenant',
      permission: { plane: 'tenant', key: keys.edit },
      audit: { action: `${target}.edited`, target }, handler: h(`${resource}.edit`),
      ...plan(changeGate),
    });
    if (keys.archive !== undefined) out.push({
      method: 'DELETE', url: `/admin/${resource}/:id`, plane: 'tenant',
      permission: { plane: 'tenant', key: keys.archive },
      audit: { action: `${target}.archived`, target }, handler: h(`${resource}.archive`),
      ...plan(changeGate),
    });
    return out;
  };

  return [
    ...crud('branches', { view: 'branch.view', create: 'branch.create', edit: 'branch.edit', archive: 'branch.archive' }, 'branch',
      { create: { limit: 'branches' } }),
    // GST registration and the premises class had routes here. They left with
    // the GST registration screen: a branch keeps the position it was
    // provisioned with, and bills are taxed from it exactly as before.
    // Read only: staff accounts are created and managed by the Sales person
    // (/api/platform/tenants/:id/staff), never from the manager screens.
    ...crud('users', { view: 'user.view' }, 'app_user'),
    ...crud('roles', { view: 'role.view', create: 'role.create', edit: 'role.edit', archive: 'role.delete' }, 'role'),
    ...crud('tax-classes', { view: 'tax.class.view', create: 'tax.class.create', edit: 'tax.class.edit', archive: 'tax.class.archive' }, 'tax_class'),
    // Create and edit are purpose-built (modules/restaurants/setup.ts): the
    // create lists the item at its branch, refusing an unroutable kitchen.
    ...crud('menu/items', { view: 'menu.view', create: 'menu.item.create', edit: 'menu.item.edit', archive: 'menu.item.archive' }, 'menu_item'),
    { method: 'GET', url: '/admin/menu/items/:id', plane: 'tenant',
      permission: { plane: 'tenant', key: 'menu.view' }, audit: 'none', handler: h('menuItemDetail') },
    { method: 'POST', url: '/admin/menu/items/:id/listing', plane: 'tenant',
      permission: { plane: 'tenant', key: 'menu.item.edit' },
      audit: { action: 'menu_item.listing.changed', target: 'menu_item', targetId: (r) => String((r.params as Record<string, unknown>)['id']) },
      handler: h('menuItemListing') },
    ...crud('menu/categories', { view: 'menu.view', create: 'menu.category.edit', edit: 'menu.category.edit', archive: 'menu.category.edit' }, 'menu_category'),
    // Add-ons: a group ("Extras") with its options ("Cheese +30"), written together.
    { method: 'GET', url: '/admin/addons', plane: 'tenant',
      permission: { plane: 'tenant', key: 'menu.view' }, audit: 'none', handler: h('addOnList') },
    { method: 'POST', url: '/admin/addons', plane: 'tenant',
      permission: { plane: 'tenant', key: 'menu.item.edit' },
      audit: { action: 'addon.created', target: 'modifier_group' }, handler: h('addOnCreate') },
    { method: 'PATCH', url: '/admin/addons/:id', plane: 'tenant',
      permission: { plane: 'tenant', key: 'menu.item.edit' },
      audit: { action: 'addon.edited', target: 'modifier_group', targetId: (r) => String((r.params as Record<string, unknown>)['id']) }, handler: h('addOnEdit') },
    { method: 'DELETE', url: '/admin/addons/:id', plane: 'tenant',
      permission: { plane: 'tenant', key: 'menu.item.edit' },
      audit: { action: 'addon.archived', target: 'modifier_group', targetId: (r) => String((r.params as Record<string, unknown>)['id']) }, handler: h('addOnArchive') },
    ...crud('stations', { view: 'kitchen.station.view', edit: 'kitchen.station.edit' }, 'kitchen_station'),
    ...crud('printers', { view: 'printer.view', create: 'printer.edit', edit: 'printer.edit', archive: 'printer.edit' }, 'printer'),
    // The local print agent (0085): what reaches a Wi-Fi or Ethernet printer the
    // hosted server cannot. Issuing one hands out a credential for a machine, so
    // it is `device.register`'s, like registering a till. Neither write audits
    // the agent row as an image: it holds the token's hash.
    { method: 'GET', url: '/admin/print-agents', plane: 'tenant',
      permission: { plane: 'tenant', key: 'printer.view' }, audit: 'none', handler: h('printAgentList') },
    { method: 'POST', url: '/admin/print-agents', plane: 'tenant',
      permission: { plane: 'tenant', key: 'device.register' },
      audit: { action: 'print_agent.issued', target: 'print_agent' }, handler: h('printAgentIssue') },
    { method: 'DELETE', url: '/admin/print-agents/:id', plane: 'tenant',
      permission: { plane: 'tenant', key: 'device.revoke' },
      audit: { action: 'print_agent.revoked', target: 'print_agent', targetId: (r) => String((r.params as Record<string, unknown>)['id']) },
      handler: h('printAgentRevoke') },
    { method: 'POST', url: '/admin/printers/:id/test-print', plane: 'tenant',
      permission: { plane: 'tenant', key: 'printer.edit' },
      audit: { action: 'printer.test_print_requested', target: 'printer', targetId: (r) => String((r.params as Record<string, unknown>)['id']) },
      handler: h('printerTestPrint') },
    // Kitchens: the station code, the branch's station and its printer, as one.
    // Restaurant setup from one Excel file. Guarded by the widest setup key and
    // then per sheet against the caller's own keys (setupImport.ts), so it can
    // never write what the caller could not write by hand. The preview is the
    // same run rolled back, and is still audited: a POST that writes, even to
    // undo it, is not one of the lease-churn exceptions.
    { method: 'POST', url: '/admin/setup/import/preview', plane: 'tenant', plan: 'document',
      permission: { plane: 'tenant', key: 'menu.item.create' },
      audit: { action: 'setup.import.previewed', target: 'branch' }, handler: h('setupImportPreview') },
    { method: 'POST', url: '/admin/setup/import', plane: 'tenant', plan: 'document',
      permission: { plane: 'tenant', key: 'menu.item.create' },
      audit: { action: 'setup.imported', target: 'branch' }, handler: h('setupImport') },
    { method: 'GET', url: '/admin/kitchens', plane: 'tenant',
      permission: { plane: 'tenant', key: 'kitchen.station.view' }, audit: 'none', handler: h('kitchenList') },
    { method: 'POST', url: '/admin/kitchens', plane: 'tenant',
      permission: { plane: 'tenant', key: 'kitchen.station.edit' },
      audit: { action: 'kitchen.created', target: 'kitchen_station' }, handler: h('kitchenCreate') },
    { method: 'PATCH', url: '/admin/kitchens/:id', plane: 'tenant',
      permission: { plane: 'tenant', key: 'kitchen.station.edit' },
      audit: { action: 'kitchen.edited', target: 'kitchen_station', targetId: (r) => String((r.params as Record<string, unknown>)['id']) }, handler: h('kitchenEdit') },
    { method: 'DELETE', url: '/admin/kitchens/:id', plane: 'tenant',
      permission: { plane: 'tenant', key: 'kitchen.station.edit' },
      audit: { action: 'kitchen.archived', target: 'kitchen_station', targetId: (r) => String((r.params as Record<string, unknown>)['id']) }, handler: h('kitchenArchive') },
    // The floor plan: floor types, floors, and tables with seats. A plan term
    // (`tables`): Basic has none, and its dine-in is numbered at the counter.
    ...crud('floor-types', { view: 'table.view', create: 'table.edit', edit: 'table.edit', archive: 'table.edit' }, 'floor_type',
      { all: { feature: 'tables' } }),
    ...crud('floors', { view: 'table.view', create: 'table.edit', edit: 'table.edit', archive: 'table.edit' }, 'floor',
      { all: { feature: 'tables' } }),
    ...crud('tables', { view: 'table.view', create: 'table.edit', edit: 'table.edit', archive: 'table.edit' }, 'dining_table',
      { all: { feature: 'tables' } }),
    // How far through setup the restaurant is.
    { method: 'GET', url: '/admin/setup', plane: 'tenant',
      permission: { plane: 'tenant', key: 'tenant.settings.view' }, audit: 'none', handler: h('setupProgress') },
    // No setup codes: a till is the restaurant's computer, registered when the
    // manager signs in on it (POST /api/auth/:tenantSlug/till). Listed and
    // taken out of use here.
    ...crud('devices', { view: 'device.view', archive: 'device.revoke' }, 'device'),

    // Who works here: read only. The Sales person manages staff accounts.
    { method: 'GET', url: '/admin/staff', plane: 'tenant',
      permission: { plane: 'tenant', key: 'user.view' }, audit: 'none', handler: h('staffList') },
    // Who is signed in, for the badge in every screen's header. Keyed on the
    // token's own subject; its key is in every built-in role (EVERY_ROLE).
    { method: 'GET', url: '/me', plane: 'tenant', plan: 'document',
      permission: { plane: 'tenant', key: 'user.self.view' }, audit: 'none', handler: h('whoAmI') },
    { method: 'GET', url: '/admin/access', plane: 'tenant',
      permission: { plane: 'tenant', key: 'user.view' }, audit: 'none', handler: h('accessList') },

    // Reports. audit 'none' -- reading a report is not an event. The two PII
    // routes are the exception and write app.pii_access_log instead, which is a
    // DIFFERENT log with a DPO audience.
    { method: 'GET', url: '/admin/reports/sales', plane: 'tenant',
      permission: { plane: 'tenant', key: 'report.sales.view' }, audit: 'none', plan: { reports: 'basic' }, handler: h('salesReport') },
    { method: 'GET', url: '/admin/reports/sales/export', plane: 'tenant',
      permission: { plane: 'tenant', key: 'report.sales.export' }, audit: 'none', plan: { reports: 'advanced' }, handler: h('salesExport') },
    { method: 'GET', url: '/admin/reports/staff', plane: 'tenant',
      permission: { plane: 'tenant', key: 'report.staff.view' }, audit: 'none', plan: { reports: 'advanced' }, handler: h('staffReport') },
    { method: 'GET', url: '/admin/reports/exception', plane: 'tenant',
      permission: { plane: 'tenant', key: 'report.exception.view' }, audit: 'none', plan: { reports: 'advanced' }, handler: h('exceptionReport') },
    { method: 'GET', url: '/admin/reports/tax/outward-supply', plane: 'tenant',
      permission: { plane: 'tenant', key: 'report.sales.view' }, audit: 'none', plan: { reports: 'advanced' }, handler: h('gstReturn') },
    // What this restaurant's plan includes, for the admin menu. The same
    // document every gated route is checked against, so the menu and the 402
    // cannot disagree.
    {
      // The controlled way back, a manager's decision from the admin: refused
      // once a bill exists. Not under /pos/ -- a manager at the admin holds no
      // tablet, and every /pos/ write is claimed against one. It ends whichever
      // lease is held, so it needs none.
      method: 'POST', url: '/admin/sessions/:id/reopen', plane: 'tenant',
      permission: { plane: 'tenant', key: 'order.reopen' },
      audit: { action: 'order.reopened_for_kot', target: 'table_session' },
      handler: h('reopenOrder'),
    },
    // Every order still open, any day: what is holding a table or still owed.
    { method: 'GET', url: '/admin/sessions/open', plane: 'tenant',
      permission: { plane: 'tenant', key: 'order.view' }, audit: 'none', handler: h('openOrders') },
    {
      // An order nobody will pay for. Refused once money is in (that is a
      // refund); unpaid bills are voided and the tables freed. Under /admin/
      // for the same reason as reopen.
      method: 'POST', url: '/admin/sessions/:id/cancel', plane: 'tenant',
      permission: { plane: 'tenant', key: 'order.cancel' },
      audit: { action: 'order.cancelled', target: 'table_session' },
      handler: h('cancelOrder'),
    },
    // Bill history, manager edits and day end (0086). A manager edits any day's
    // bill; a submitted day only once reopened, with a reason. Not under /pos/:
    // a manager at the admin holds no till.
    { method: 'GET', url: '/admin/bills', plane: 'tenant',
      permission: { plane: 'tenant', key: 'bill.view' }, audit: 'none', handler: h('adminBillHistory') },
    { method: 'GET', url: '/admin/bills/:id', plane: 'tenant',
      permission: { plane: 'tenant', key: 'bill.view' }, audit: 'none', handler: h('adminBillDetail') },
    { method: 'POST', url: '/admin/bills/:id/print', plane: 'tenant',
      permission: { plane: 'tenant', key: 'bill.reprint' },
      audit: { action: 'bill.printed', target: 'bill', targetId: pathId }, handler: h('printBill') },
    { method: 'POST', url: '/admin/bills/:id/revise/preview', plane: 'tenant',
      permission: { plane: 'tenant', key: 'bill.edit.any' },
      audit: { action: 'bill.revision.previewed', target: 'bill', targetId: pathId },
      handler: h('adminPreviewBillRevision') },
    { method: 'POST', url: '/admin/bills/:id/revise', plane: 'tenant',
      permission: { plane: 'tenant', key: 'bill.edit.any' },
      audit: { action: 'bill.revised', target: 'bill', targetId: pathId },
      handler: h('adminReviseBill') },
    { method: 'POST', url: '/admin/days/:date/submit', plane: 'tenant',
      permission: { plane: 'tenant', key: 'payment.settlement.close' },
      audit: { action: 'day.submitted', target: 'day_submission' }, handler: h('adminSubmitDay') },
    { method: 'POST', url: '/admin/days/:date/reopen', plane: 'tenant',
      permission: { plane: 'tenant', key: 'payment.settlement.reopen' },
      audit: { action: 'day.reopened', target: 'day_submission' }, handler: h('reopenDay') },
    // Allow POS Bill Editing (0087): a manager lets the till edit TODAY's
    // submitted bills, and takes it back. The same manager-only key as reopening.
    { method: 'POST', url: '/admin/days/:date/pos-editing/enable', plane: 'tenant',
      permission: { plane: 'tenant', key: 'payment.settlement.reopen' },
      audit: { action: 'day.pos_editing.enabled', target: 'pos_edit_grant' }, handler: h('enablePosEditing') },
    { method: 'POST', url: '/admin/days/:date/pos-editing/disable', plane: 'tenant',
      permission: { plane: 'tenant', key: 'payment.settlement.reopen' },
      audit: { action: 'day.pos_editing.disabled', target: 'pos_edit_grant' }, handler: h('disablePosEditing') },
    { method: 'GET', url: '/admin/entitlements', plane: 'tenant',
      permission: { plane: 'tenant', key: 'tenant.settings.view' }, audit: 'none',
      plan: 'document', handler: h('planEntitlements') },
    { method: 'GET', url: '/admin/tax-splits', plane: 'tenant',
      permission: { plane: 'tenant', key: 'tax.class.view' }, audit: 'none', handler: h('taxSplits') },
    // How a branch charges tax (0083): on/off, account, forward/reverse, VAT
    // number. Not the generic branch PATCH -- it decides what diners are
    // charged, and is refused while the branch has an open order.
    { method: 'POST', url: '/admin/branches/:id/tax', plane: 'tenant',
      permission: { plane: 'tenant', key: 'tax.setting.edit' },
      audit: { action: 'branch.tax_settings.changed', target: 'branch', targetId: (r) => String((r.params as Record<string, unknown>)['id']) },
      handler: h('branchTaxSettings') },
    { method: 'GET', url: '/admin/print/failures', plane: 'tenant',
      permission: { plane: 'tenant', key: 'printer.view' }, audit: 'none', handler: h('printFailures') },

    // Staff PII, on its own path and its own key. Until 0049 this capability
    // was reachable only through the route named for customers, which read
    // app_user -- so this is not a new power, it is the power that route was
    // quietly providing, separated so that granting one does not grant both.
    { method: 'GET', url: '/admin/users/:id/contact', plane: 'tenant',
      permission: { plane: 'tenant', key: 'user.pii.view' },
      audit: { action: 'user.pii.viewed', target: 'app_user' },
      handler: h('revealStaffPii') },
  ];
};

/* ------------------------------------------------------------ platform --- */


export const platformRoutes = (handlers: Record<string, Handler> = {}): readonly RouteDefinition[] => {
  const h = handlerLookup(handlers);
  return [
    { method: 'GET', url: '/tenants', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.view' }, audit: 'none', handler: h('tenants') },
    { method: 'POST', url: '/tenants', plane: 'platform',
      // The ONE control-plane route that needs the owner role: provisioning
      // writes app.branch, app.app_user, app.role and app.membership with no
      // tenant GUC set, which every app table refuses (SQLSTATE 28000). See
      // RouteDefinition.role. `provisionTenant` is already listed in
      // OWNER_POSTURE for exactly this reason -- the pool wiring did not match
      // the posture the gate had recorded, so the route answered 500.
      role: 'owner',
      permission: { plane: 'platform', key: 'platform.tenant.provision' },
      audit: { action: 'tenant.provisioned', target: 'tenant' }, handler: h('provision') },
    // A new address (slug). Super Admin only: it changes what every link,
    // QR code and tablet carries, so it is not part of the everyday edit. The
    // old slug keeps resolving -- see modules/platform/slug.ts.
    { method: 'POST', url: '/tenants/:id/slug', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.rename' },
      audit: { action: 'tenant.slug.changed', target: 'tenant', targetId: pathId, afterIsResult: true },
      handler: h('renameTenantSlug') },
    // A restaurant's country and currency (0084): until its first bill, and
    // never without a confirmed request. The GET is the preview -- what would
    // change, including any price conversion -- and writes nothing. A Sales
    // person also needs the platform setting on and the restaurant in their
    // book; `platform.tenant.country.any` (Super Admin) needs neither.
    { method: 'GET', url: '/tenants/:id/country-change', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.country' }, audit: 'none',
      handler: h('previewCountryChange') },
    { method: 'POST', url: '/tenants/:id/country', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.country' },
      audit: { action: 'tenant.country.changed', target: 'tenant', targetId: pathId, afterIsResult: true },
      handler: h('changeTenantCountry') },
    // A restaurant's staff, managed by the Sales person who sold it (Super Admin:
    // any restaurant). Staff sign in with a 4-digit PIN; the body carries it, and
    // no audit descriptor records the body -- see modules/platform/tenantStaff.ts.
    { method: 'GET', url: '/tenants/:id/staff', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.staff' }, audit: 'none', handler: h('tenantStaff') },
    { method: 'POST', url: '/tenants/:id/staff', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.staff' },
      audit: { action: 'tenant.staff.created', target: 'tenant', targetId: pathId, afterIsResult: true },
      handler: h('createTenantStaff') },
    { method: 'PATCH', url: '/tenants/:id/staff/:userId', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.staff' },
      audit: { action: 'tenant.staff.edited', target: 'tenant', targetId: pathId, afterIsResult: true },
      handler: h('editTenantStaff') },
    // Username and password, for staff and for the manager. The audit row is the
    // RESULT (user id and username), never the body: the body holds the password.
    { method: 'POST', url: '/tenants/:id/staff/:userId/credentials', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.staff' },
      audit: { action: 'tenant.staff.credentials_set', target: 'tenant', targetId: pathId, afterIsResult: true },
      handler: h('setTenantCredentials') },
    { method: 'POST', url: '/tenants/:id/staff/:userId/pin', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.staff' },
      audit: { action: 'tenant.staff.pin_set', target: 'tenant', targetId: pathId, afterIsResult: true },
      handler: h('setTenantStaffPin') },
    { method: 'POST', url: '/tenants/:id/staff/:userId/active', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.staff' },
      audit: { action: 'tenant.staff.access_changed', target: 'tenant', targetId: pathId, afterIsResult: true },
      handler: h('setTenantStaffActive') },
    { method: 'PATCH', url: '/tenants/:id', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.edit' },
      audit: { action: 'tenant.edited', target: 'tenant', targetId: pathId, afterIsResult: true },
      handler: h('editTenant') },
    // The logo. The audit row records the resulting URL, never the image.
    { method: 'POST', url: '/tenants/:id/logo', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.edit' },
      audit: { action: 'tenant.logo.set', target: 'tenant', targetId: pathId, afterIsResult: true },
      handler: h('setTenantLogo') },
    { method: 'DELETE', url: '/tenants/:id/logo', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.edit' },
      audit: { action: 'tenant.logo.removed', target: 'tenant', targetId: pathId, afterIsResult: true },
      handler: h('removeTenantLogo') },
    // Deactivation is `platform.tenant.suspend`: super_admin and billing (which
    // already owns the ladder) hold it; sales and support do not. Switching a
    // restaurant off is a decision about the estate, not a sale.
    { method: 'POST', url: '/tenants/:id/deactivate', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.suspend' },
      audit: { action: 'tenant.deactivated', target: 'tenant', targetId: pathId, afterIsResult: true },
      handler: h('deactivateTenant') },
    { method: 'POST', url: '/tenants/:id/reactivate', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.suspend' },
      audit: { action: 'tenant.reactivated', target: 'tenant', targetId: pathId, afterIsResult: true },
      handler: h('reactivateTenant') },
    // Held by whoever may PROVISION: the setup link is the second half of
    // creating a restaurant. No afterIsResult -- the result is a bearer secret.
    // The create form's live check. Advisory: the unique index decides a race.
    { method: 'GET', url: '/tenants/slug-available', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.provision' }, audit: 'none',
      handler: h('slugAvailability') },
    { method: 'POST', url: '/tenants/:id/owner-invite', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.provision' },
      audit: { action: 'tenant.owner_invite.reissued', target: 'tenant', targetId: pathId },
      handler: h('reissueOwnerInvite') },
    // Answers only "who am I", keyed on the token's own subject. Its key is in
    // every role's base set: a platform route is never guarded by merely
    // holding a token.
    { method: 'GET', url: '/me', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.self.view' }, audit: 'none', handler: h('me') },
    { method: 'GET', url: '/users', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.user.view' }, audit: 'none', handler: h('platformUsers') },
    { method: 'GET', url: '/sales-persons', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.user.view' }, audit: 'none', handler: h('salesPersons') },
    { method: 'PATCH', url: '/users/:id', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.user.edit' },
      audit: { action: 'platform_user.edited', target: 'platform_user', targetId: pathId, afterIsResult: true },
      handler: h('updatePlatformUser') },
    { method: 'POST', url: '/users/:id/status', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.user.suspend' },
      audit: { action: 'platform_user.status_changed', target: 'platform_user', targetId: pathId, afterIsResult: true },
      handler: h('setPlatformUserStatus') },
    // `platform.user.create`: the key that already lets its holder set a
    // platform user's password at creation. Escalation-class, subset-ruled,
    // and the result -- a password -- is never written to the audit row.
    { method: 'POST', url: '/users/:id/password', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.user.create' },
      audit: { action: 'platform_user.password_reset', target: 'platform_user', targetId: pathId },
      handler: h('resetPlatformUserPassword') },
    { method: 'POST', url: '/users', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.user.create' },
      audit: { action: 'platform_user.created', target: 'platform_user' },
      handler: h('createPlatformUser') },
    { method: 'GET', url: '/plans', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.plan.view' }, audit: 'none', handler: h('plans') },
    { method: 'POST', url: '/plans/:id/versions', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.plan.version' },
      audit: { action: 'plan.version_published', target: 'plan', targetId: pathId, afterIsResult: true },
      handler: h('publishPlanVersion') },
    { method: 'POST', url: '/plans/:id/status', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.plan.retire' },
      audit: { action: 'plan.status_changed', target: 'plan', targetId: pathId, afterIsResult: true },
      handler: h('setPlanStatus') },
    { method: 'POST', url: '/subscriptions/:id/renew', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.subscription.change' },
      audit: { action: 'subscription.renewed', target: 'subscription', targetId: pathId, afterIsResult: true },
      handler: h('renewSubscription') },
    { method: 'POST', url: '/subscriptions/:id/change', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.subscription.change' },
      audit: { action: 'subscription.changed', target: 'subscription' }, handler: h('changePlan') },
    // ###################################################################
    // A SCHEDULED CHANGE WAS INVISIBLE AND IRREVOCABLE.
    //
    // A downgrade or a seat decrease does not apply immediately -- it is
    // scheduled for the period end, which is the correct answer to "do not
    // refund what has already been paid for". `pendingChangeFor` and
    // `revokeScheduledChange` implement reading and cancelling it, and both had
    // exactly ONE caller each: a test.
    //
    // So a support agent could schedule a downgrade, could not see that one was
    // pending, and could not undo it -- for a customer who rang back a minute
    // later. Two routes, no new domain code.
    // ###################################################################
    { method: 'GET', url: '/subscriptions/:id/pending-change', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.subscription.view' },
      audit: 'none', handler: h('pendingChange') },
    { method: 'DELETE', url: '/subscriptions/:id/pending-change', plane: 'platform',
      // Revoking a scheduled change is CHANGING the subscription, so it needs
      // the same key as making one. Reading it is a read.
      permission: { plane: 'platform', key: 'platform.subscription.change' },
      audit: { action: 'subscription.change_revoked', target: 'subscription' },
      handler: h('revokePendingChange') },
    { method: 'GET', url: '/invoices', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.invoice.view' }, audit: 'none', handler: h('invoices') },
    { method: 'GET', url: '/dunning', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.payment.view' }, audit: 'none', handler: h('dunning') },
    // Not `platform.payment.view`: that is a READ key, and read_only holds it.
    // Logging the call is a write about a delinquent tenant.
    { method: 'POST', url: '/dunning/:tenantId/outreach', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.dunning.outreach' },
      audit: { action: 'dunning.outreach', target: 'tenant' }, handler: h('outreach') },
    // Audited on BOTH planes: here, and in the tenant's own log for every write.
    { method: 'POST', url: '/impersonation', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.impersonation.start' },
      // The SECOND key, declared rather than checked inside the handler. A
      // read-only support session needs only `start`; a session that can change
      // the tenant's data needs `write` as well, and that request is exactly the
      // one carrying a `write` block in its body.
      escalation: {
        key: 'platform.impersonation.write',
        whenBodyPresent: 'write',
        refusal: 'impersonation_write_not_permitted',
      },
      audit: { action: 'impersonation.started', target: 'tenant' }, handler: h('startImpersonation') },
    { method: 'DELETE', url: '/impersonation/:id', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.impersonation.revoke' },
      audit: { action: 'impersonation.revoked', target: 'impersonation_session' }, handler: h('revoke') },
    { method: 'POST', url: '/tenants/:id/tax-exemption', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.edit' },
      audit: { action: 'tenant.tax_exemption.granted', target: 'tenant_tax_profile' }, handler: h('grantExemption') },
    // The countries offered, the default a new restaurant form starts on, and
    // whether Sales may move a restaurant. Read by whoever may see restaurants
    // (the create form needs it); changed by Super Admin only.
    { method: 'GET', url: '/countries', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.tenant.view' }, audit: 'none', handler: h('countrySettings') },
    { method: 'PATCH', url: '/settings/countries', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.settings.edit' },
      audit: { action: 'platform.countries.changed', target: 'platform_setting', afterIsResult: true },
      handler: h('setCountrySettings') },
    { method: 'GET', url: '/system/jobs', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.settings.view' }, audit: 'none', handler: h('jobHealth') },
    { method: 'GET', url: '/system/health', plane: 'platform',
      permission: { plane: 'platform', key: 'platform.settings.view' }, audit: 'none', handler: h('systemHealth') },
  ];
};

/* ------------------------------------------------------ pre-auth surface --- */

/**
 * The only routes with no plane guard, because no token exists yet.
 *
 * ###########################################################################
 * ALL FOUR DECLARE AN ATTEMPT POSTURE, NOT AN AUDIT POSTURE.
 *
 * They used to declare `audit: { action: 'auth.password.attempted', ... }`, and
 * that declaration was unsatisfiable: `tenant_audit_log_attribution_exact`
 * cannot hold a login, so `registerPublicRoute` refused every one of them. The
 * routes named a destination that could not accept them.
 *
 * DECIDED (CLAUDE.md): credential events go to `platform.auth_attempt`, and the
 * posture says so. `audit: 'none'` would have been the lazy spelling and is
 * refused here on purpose -- silence on the four most security-relevant routes
 * in the product reads as an omission, and the inverted gate exists so a posture
 * shows up in a diff.
 * ###########################################################################
 */
export const authRoutes = (handlers: Record<string, Handler> = {}): readonly RouteDefinition[] => {
  const h = handlerLookup(handlers);
  return [
    // ###################################################################
    // THE TENANT IS IN THE PATH, AND ONLY WHERE IT HAS TO BE.
    //
    // A login has no JWT, so these two cannot obey the rule that a tenant id
    // comes only from a verified token. DECIDED (CLAUDE.md): the slug is a path
    // segment -- public, unique, already format-checked, and typeable -- rather
    // than a body field, so it is part of the route surface instead of being
    // smuggled through a payload.
    //
    // `refresh` deliberately has NO slug: its tenant comes from a token this
    // process signed, so it stays on the original rule. `device/enrol` has none
    // either, because the tenant travels inside the token being redeemed.
    // ###################################################################
    { method: 'POST', url: '/api/auth/:tenantSlug/login', plane: 'public',
      audit: { attempt: 'password' }, handler: h('login') },
    { method: 'POST', url: '/api/auth/:tenantSlug/pin', plane: 'public',
      audit: { attempt: 'pin' }, handler: h('pin') },
    // The POS half of the restaurant's one login page: username (or email) and
    // password; the session is the till's branch and device. A browser that is
    // not a till yet becomes one here for whoever may (deviceAuth.ts).
    { method: 'POST', url: '/api/auth/:tenantSlug/till', plane: 'public',
      audit: { attempt: 'password' }, handler: h('tillPassword') },
    { method: 'POST', url: '/api/auth/refresh', plane: 'public',
      audit: { attempt: 'refresh' }, handler: h('refresh') },
    // No slug, like device/enrol: the tenant is the one the redeemed invite
    // names, found by the token's hash in platform.tenant_owner_invite.
    { method: 'POST', url: '/api/auth/invite/accept', plane: 'public',
      audit: { attempt: 'owner_invite' }, handler: h('acceptInvite') },
    // ###################################################################
    // THE CONTROL PLANE'S OWN FRONT DOOR.
    //
    // Not `/api/auth/:tenantSlug/login` with a special slug, and not a flag on
    // the tenant route: a platform credential is verified against a different
    // table, mints a token with no `tenant_id`, and is recorded against a
    // different column of the attempt log. One route doing both would be one
    // place holding both planes' rules, and a bug in the branch selection would
    // be a bug that crosses the boundary this product is built around.
    //
    // Until this existed, all 28 control-plane routes were reachable only with a
    // hand-signed token -- so `platform_user.password_hash`, `locked_until`,
    // `failed_login_count` and `last_login_at` were four columns written by
    // nothing.
    // ###################################################################
    { method: 'POST', url: '/api/auth/platform/login', plane: 'public',
      audit: { attempt: 'password' }, handler: h('platformLogin') },
    { method: 'POST', url: '/api/auth/platform/refresh', plane: 'public',
      audit: { attempt: 'refresh' }, handler: h('platformRefresh') },
    // Verifies the CURRENT password with login's own lockout before writing the
    // new one, so it is a credential event and is recorded as one.
    { method: 'POST', url: '/api/auth/platform/password', plane: 'public',
      audit: { attempt: 'password' }, handler: h('platformPassword') },
    { method: 'GET', url: '/healthz', plane: 'public', audit: 'none', handler: h('healthz') },
    // The print agent's one call: report what it printed, take the next jobs.
    // Its bearer is the agent token, resolved on every poll (agentRoute.ts).
    { method: 'POST', url: '/api/agent/poll', plane: 'agent', audit: 'none', handler: h('printAgentPoll') },
    // The restaurant's own page, `/{slug}`: its name and whether sign-in is open.
    { method: 'GET', url: '/api/public/restaurants/:tenantSlug', plane: 'public', audit: 'none',
      handler: h('restaurantBySlug') },
    { method: 'GET', url: '/api/public/restaurants/:tenantSlug/logo', plane: 'public', audit: 'none',
      handler: h('restaurantLogo') },
    // The installable POS app (a web app manifest): its home-screen icon opens
    // this restaurant's `/{slug}/pos` and nothing else. Names only, like the lookup.
    { method: 'GET', url: '/api/public/restaurants/:tenantSlug/manifest', plane: 'public', audit: 'none',
      handler: h('posAppManifest') },
    // The names a till shows before the PIN keypad. A read, not a sign-in, so it
    // is off /api/auth/ (where every route records an attempt). The fingerprint
    // travels in a header, never the query string, so it stays out of access logs.
    { method: 'GET', url: '/api/public/restaurants/:tenantSlug/till/staff', plane: 'public',
      audit: 'none', handler: h('tillStaff') },
  ];
};

/* ------------------------------------------------------------ the whole --- */

export function allRoutes(handlers: Record<string, Handler> = {}): readonly RouteDefinition[] {
  return [
    ...posRoutes(handlers),
    ...adminRoutes(handlers),
    ...platformRoutes(handlers),
    ...authRoutes(handlers),
  ];
}

/**
 * Permission keys with no route YET.
 *
 * A RATCHET, not an exemption: an entry leaving this list is progress and a
 * new entry needs a reason. It is empty when Phase 7 is finished, and the
 * coverage test fails if a key is listed here that DOES have a route -- so the
 * list cannot rot into a permanent excuse.
 */
export const KEYS_WITHOUT_ROUTES: readonly string[] = [
  'tenant.settings.edit',
  'tenant.billing.view',
  'user.credential.unlock',
  'membership.view',
  'membership.revoke',
  'audit.view',
  'menu.price.edit',
  'menu.availability.toggle',
  'table.session.merge',
  'printer.job.retry',
  'order.line.add',
  'order.transfer',
  'kot.recall',
  'bill.split',
  'bill.merge',
  'bill.void',
  'payment.view',
  'payment.settlement.view',
  'inventory.transfer',
  // ###################################################################
  // RETIRED WITH MIGRATION 0064, NOT "NOT YET".
  //
  // Stock, purchasing, suppliers, recipes, customers, loyalty and the GST
  // registration screens were taken out of the product; their routes went with
  // them. The keys stay in the catalogue for now because the separation-of-
  // duties rules are written in them (vendor master versus approval, the till
  // versus adjustments) and existing custom roles hold them through foreign
  // keys -- removing them is a catalogue change with its own migration, not a
  // side effect of removing screens. Until then they grant nothing.
  // ###################################################################
  'branch.premises.state', 'branch.gst.state', 'bill.recipient.set',
  'customer.view', 'customer.create', 'customer.edit', 'customer.pii.view',
  'customer.pii.export', 'customer.erase', 'customer.consent.record',
  'loyalty.redeem', 'loyalty.adjust', 'loyalty.program.edit',
  'inventory.view', 'inventory.waste', 'inventory.adjust',
  'inventory.count.perform', 'inventory.count.approve',
  'product.view', 'product.create', 'product.edit', 'product.archive',
  'recipe.view', 'recipe.edit',
  'supplier.view', 'supplier.create', 'supplier.edit',
  'purchase.order.view', 'purchase.order.create', 'purchase.order.approve', 'purchase.receive',
  'report.inventory.view',
  // ###################################################################
  // RETIRED WITH MIGRATION 0077 (Basic only).
  //
  // The kitchen screen, tablet setup codes and the manager's staff management
  // were taken out. Staff are the Sales person's (platform.tenant.staff).
  // `device.register` left this list with 0085: setting up a print agent is a
  // route that declares it (and registerTillAtSignIn still reads it). Same
  // position as 0064: the rest grant nothing until a catalogue migration
  // removes them.
  // ###################################################################
  'user.invite', 'user.edit', 'user.suspend', 'user.credential.reset', 'membership.grant',
  'kds.view', 'kds.item.advance', 'kds.item.bump', 'kds.item.recall',
];

/**
 * Platform keys with no route yet. Same ratchet as the tenant list: an entry
 * leaving it is progress, and the test refuses an entry that already has a route.
 */
export const PLATFORM_KEYS_WITHOUT_ROUTES: readonly string[] = [
  'platform.tenant.purge',
  'platform.tenant.export',
  'platform.plan.create',
  'platform.subscription.create',
  'platform.subscription.cancel',
  'platform.subscription.credit',
  'platform.entitlement.view',
  'platform.entitlement.republish',
  'platform.refund.issue',
  'platform.role.assign',
  'platform.impersonation.write',
  'platform.impersonation.view',
  'platform.audit.view',
  'platform.usage.view',
  // Not a route key: it widens platform.tenant.staff from the restaurants a
  // Sales person sold to every restaurant (tenantStaff.ts restaurantFor), the
  // same shape as platform.impersonation.write widening a session.
  'platform.tenant.staff.any',
  // Not a route key either: it widens platform.tenant.country to every
  // restaurant and past the Sales setting (countries.ts resolveChange).
  'platform.tenant.country.any',
];

/**
 * ###########################################################################
 * ROUTES DECLARED BUT NOT YET SERVED. A RATCHET, EXACTLY LIKE THE TWO ABOVE.
 *
 * The route table declares the WHOLE surface so the coverage assertion can read
 * it; only some of it has a handler. A route with no handler falls back to the
 * stub, and the audit middleware would then record `tenant.provisioned` for a
 * request that provisioned nothing -- which is why `buildServer` refuses to
 * register one at all, and why this list exists rather than the stub being
 * quietly acceptable.
 *
 * The gate enforces it in both directions: an entry here that IS served fails
 * (so the list cannot rot into a permanent excuse), and a route missing from
 * here that is unserved fails (so the surface cannot grow stubs silently).
 *
 * This list is the honest state of the surface: POS, KDS, sync, the standalone
 * menu read and the whole pre-auth surface are served; admin CRUD and the
 * control plane are declared and not built.
 *
 * Nothing on it is blocked on a decision any more -- what remains is a screen
 * that has not been built to call it.
 * ###########################################################################
 */
export const ROUTES_WITHOUT_HANDLERS: readonly string[] = [
  // EMPTY, for the first time. Every route this table declares has a handler.
  //
  // It stays here rather than being deleted, and stays a ratchet: the boot gate
  // reads it to decide what it is allowed to refuse to start over, and the
  // correspondence gate reads it to distinguish "declared unbuilt" from
  // "silently detached by a rename". An empty list is the strongest state it can
  // be in and a new entry is a deliberate, visible admission.
];
