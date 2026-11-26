import { ApiError } from '../../../services/api.js';

/**
 * A refusal, in the words that fit the thing that was refused.
 *
 * ###########################################################################
 * ONE VOCABULARY, BECAUSE THE SAME CODE MEANS THE SAME THING ON EVERY SCREEN.
 *
 * `Bill.tsx` grew its own `describe` and the adjustment, split and table screens
 * would each have grown another. Three copies drift, and a waiter reading
 * "settle or void it first" on one screen and "there is money on this table" on
 * the next has to work out whether those are the same problem.
 *
 * Every string here says what happened and what to do next. A code with no
 * recovery path gets a sentence that says so rather than a cheerful "try again"
 * -- `unassigned_guest_lines` cannot be recovered from on this build, and
 * telling a waiter to assign guests on a screen that has no way to assign them
 * is worse than telling them the split is unavailable.
 * ###########################################################################
 */

/**
 * What the caller was doing, which decides only what OFFLINE means -- and that
 * is the one thing a shared vocabulary must not get wrong.
 *
 *   queued  the operation is in the queue. Offline is a delay: it will go.
 *   now     the operation waited for the server and did NOT happen. Offline
 *           means nothing was changed, and saying "it will go as soon as it
 *           can" here would be a straightforward lie -- there is nothing
 *           holding it.
 *   money   the same as `now`, plus the one alternative that exists for a
 *           whole-service outage: an audited manual settlement. Only tender and
 *           bill generation get this, because `settle-manual` is about tender.
 */
export type RefusalContext = 'queued' | 'now' | 'money';

export function describeRefusal(error: unknown, context: RefusalContext): string {
  if (!(error instanceof ApiError)) {
    return 'That did not go through. Nothing was changed.';
  }

  if (error.failure.kind === 'offline') {
    switch (context) {
      case 'queued':
        return 'This tablet cannot reach the till. The work is held on the tablet '
          + 'and will go as soon as it can.';
      case 'money':
        return 'This tablet cannot reach the till, and money is the one thing it will '
          + 'not take on trust. If the network is down for the whole service, a manager '
          + 'can authorise a manual settlement with the card machine’s reference.';
      case 'now':
        return 'This tablet cannot reach the till, and this is not something it will '
          + 'do on its own later. Nothing was changed — try again once it is back on '
          + 'the network.';
    }
  }
  if (error.failure.kind === 'signed-out') return 'The shift ended. Sign in again.';

  switch (error.failure.code) {
    // ---- the lease -------------------------------------------------------
    case 'lease_token_unknown':
    case 'lease_not_held':
      return 'This tablet is no longer holding this table. Pick it up from the floor.';
    case 'lease_force_released':
      return 'A manager took this table off this tablet. Pick it up from the floor '
        + 'again — anything unsent was refused deliberately.';
    case 'lease_subject_mismatch':
      return 'That belongs to a different table. Go back to the floor and reload.';
    case 'lease_token_required':
      return 'A client bug: this write went out without the table’s lease token.';

    // ---- the order -------------------------------------------------------
    case 'line_already_fired':
      return 'The kitchen already has this line, so it cannot be edited. '
        + 'Void it if the food was not delivered, or comp it if it was.';
    case 'line_not_fired':
      return 'The kitchen has not seen this line yet, so there is nothing to void '
        + 'or comp. Change the quantity or remove it instead.';
    case 'nothing_to_fire':
      return 'There is nothing unfired on this order. The board will refresh.';
    case 'session_version_conflict':
      return 'Another tablet changed this table while this was waiting. '
        + 'The board has re-read; check it and send again.';
    case 'reason_required':
      return 'This needs a reason code, and there is no route on this build that '
        + 'lists them. Nothing was changed.';
    case 'adjustment_exceeds_original':
      return 'That is larger than what is left of the line. Re-read the order: '
        + 'some of it has already been voided, comped or discounted.';
    case 'discount_exceeds_authority':
      // 403, and the recovery is a PERSON, not a retry. Saying "try again" here
      // would be telling the waiter to tap until it works.
      return 'This discount is above what this sign-in is allowed to give. '
        + 'A manager with a higher cap has to authorise it — end the shift and have '
        + 'them sign in, or ask them to do it on their own tablet. '
        + 'Nothing was changed.';
    case 'menu_item_not_orderable':
      return 'That item is not available right now. The menu will refresh.';
    case 'parcel_charge_above_max':
      return 'That parcel charge is more than this branch allows. Enter a smaller one, '
        + 'or ask a manager to raise the most under Printed bill.';
    case 'parcel_charge_invalid':
      return 'Enter the parcel charge as an amount, like 20 or 20.50.';
    case 'parcel_charge_not_parcel':
      return 'A parcel charge goes on a parcel order only.';
    case 'parcel_charge_after_payment':
      return 'Money has been taken on this bill, so its parcel charge can no longer change.';
    case 'idempotency_key_reused':
      return 'A client bug: two different writes went out under one key. '
        + 'Nothing was changed.';
    case 'idempotency_key_required':
      return 'A client bug: that write went out with no idempotency key.';

    // ---- money -----------------------------------------------------------
    case 'bill_already_tendered':
      return 'Money has already been taken against this bill. Reload before taking more.';
    case 'lines_already_billed':
      return 'These lines are already on a bill. A further bill for this table has '
        + 'to be a split over what is left, not another whole one.';
    case 'unassigned_guest_lines':
      // The honest version. There is no route that sets `order_line.guest_no`,
      // so "assign them first" is advice the UI cannot act on.
      return 'A split by guest needs every line attributed to a guest, and no line '
        + 'on this table is. Nothing on this build can attribute them — there is no '
        + 'route that sets a line’s guest. Split by line instead.';
    case 'session_has_unsettled_money':
      return 'There is still money outstanding on this table, so it cannot be '
        + 'closed. Take the rest of the payment, or void the tender, first.';
    case 'session_not_open':
      return 'This table is already closed. Go back to the floor.';
    case 'table_occupied':
      return 'That table already has a party on it. Reload the floor and pick '
        + 'another.';

    default:
      return error.message;
  }
}
