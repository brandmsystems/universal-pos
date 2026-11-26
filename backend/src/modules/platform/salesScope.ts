import type pg from 'pg';
import { TenantUnknownError } from './tenantAdmin.js';

/**
 * A Salesperson's book, enforced on routes that address a subscription by id.
 *
 * ###########################################################################
 * THE LIST WAS SCOPED; THE ROUTES BEHIND IT WERE NOT.
 *
 * `GET /tenants` answers a `sales` token with the restaurants that rep
 * provisioned, and has done since the Sales Person screens were built. But
 * `POST /subscriptions/:id/change`, the pending-change read and revoke, the
 * invoice ledger and the dunning queue took an id -- or no filter at all --
 * and never asked whose it was. `sales` holds the keys for all of them, so a
 * rep could reprice a colleague's customer by guessing a subscription id, or
 * read every restaurant's invoices. The screen hid the rows; nothing stopped
 * the request.
 *
 * One check, called by every such handler before the domain function, rather
 * than a predicate threaded through five billing functions that have nothing
 * to do with who sold what.
 * ###########################################################################
 *
 * Out-of-book answers as UNKNOWN, never forbidden: a 403 would confirm that the
 * id belongs to somebody.
 */
export async function assertSubscriptionInBook(
  client: pg.ClientBase,
  subscriptionId: string,
  platformUserId: string,
): Promise<void> {
  const found = await client.query(
    `SELECT 1
       FROM platform.subscription s
       JOIN platform.provisioning_request pr ON pr.tenant_id = s.tenant_id
      WHERE s.id = $1 AND pr.requested_by_platform_user_id = $2`,
    [subscriptionId, platformUserId]);
  if (found.rowCount === 0) throw new TenantUnknownError(subscriptionId);
}

