/**
 * "Expiring soon" means the subscription period ends inside this many days.
 *
 * ONE copy, imported by the API (the Sales Persons counts) and by the console
 * (the status badge and dashboard tiles). It used to be two constants kept in
 * step by a test; a value both sides must agree on belongs in one place.
 */
export const EXPIRING_WITHIN_DAYS = 7;
