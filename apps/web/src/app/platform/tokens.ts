/**
 * Platform vocabulary: the words and the colour LOGIC, not the colour VALUES.
 *
 * ###########################################################################
 * THE VALUES MOVED TO globals.css; THE LOGIC DID NOT MOVE AT ALL.
 *
 * Redesigning the theme (see globals.css) is a styling change. Which status
 * gets which meaning is not -- `tenantStatusTone` deciding that `hard_lock`
 * reads as critical and `active` reads as neutral is a product fact, tested
 * against nothing that changes when the hex values do. So this file keeps
 * exactly the logic it always had and now returns Tailwind class names
 * instead of raw hex, because every screen that reads it is Tailwind-native.
 * ###########################################################################
 *
 * ###########################################################################
 * TWO DIFFERENT VOCABULARIES, AND THE FIRST VERSION OF THIS FILE CONFLATED THEM.
 *
 * `platform.tenant.status` is the SUSPENSION LADDER -- seven rungs from active
 * to purged, describing what the product will still do for that restaurant.
 * `platform.subscription.status` is five values describing the billing
 * agreement. They share the words `active` and `past_due` and nothing else, and
 * a single map covering both is a map that is wrong for one of them.
 * ###########################################################################
 */

/** `platform.tenant.status`: the suspension ladder, worst last. */
const TENANT_STATUS_WORDS: Readonly<Record<string, string>> = {
  active: 'Active',
  past_due: 'Past due',
  soft_lock: 'Soft locked',
  hard_lock: 'Hard locked',
  retention: 'Retention',
  purge_pending: 'Purge pending',
  purged: 'Purged',
  // Not a rung: a Super Admin's decision, with a reason on record. Red all
  // the same -- the product is withholding service, which is what red means.
  deactivated: 'Deactivated',
};

/** `platform.subscription.status`: the billing agreement. */
const SUBSCRIPTION_STATUS_WORDS: Readonly<Record<string, string>> = {
  trialing: 'Trialing',
  active: 'Active',
  past_due: 'Past due',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

/**
 * A value the schema permits and this file has not been taught falls through as
 * itself, spaced out -- visible and ugly rather than blank. A missing rung must
 * never render as nothing, because nothing reads as "fine".
 */
function wordFrom(map: Readonly<Record<string, string>>, status: string): string {
  return map[status] ?? status.replace(/_/g, ' ');
}

export function tenantStatusWord(status: string): string {
  return wordFrom(TENANT_STATUS_WORDS, status);
}

export function subscriptionStatusWord(status: string): string {
  return wordFrom(SUBSCRIPTION_STATUS_WORDS, status);
}

/** `platform.invoice.status`: three values, and none of them is a ladder rung. */
const INVOICE_STATUS_WORDS: Readonly<Record<string, string>> = {
  issued: 'Issued',
  paid: 'Paid',
  void: 'Void',
};

export function invoiceStatusWord(status: string): string {
  return wordFrom(INVOICE_STATUS_WORDS, status);
}

/**
 * How hard the ladder has bitten, as a Tailwind text-colour class.
 *
 * Amber is "money is owed and somebody should call". Red is "the product is
 * withholding service", which is every rung from hard_lock down. An UNKNOWN
 * value is red as well, and deliberately: a rung this file has not been taught
 * is one added to the ladder since it was written, and every rung added so far
 * has been worse than the last. Defaulting to neutral would hide exactly the
 * case nobody has thought about.
 */
export function tenantStatusTone(status: string): string {
  if (status === 'active') return 'text-muted-foreground';
  if (status === 'past_due' || status === 'soft_lock') return 'text-status-warn';
  return 'text-status-critical';
}

/** The billing agreement. Cancelled and expired stop it; past_due warns. */
export function subscriptionStatusTone(status: string): string {
  if (status === 'active' || status === 'trialing') return 'text-muted-foreground';
  if (status === 'past_due') return 'text-status-warn';
  return 'text-status-critical';
}
