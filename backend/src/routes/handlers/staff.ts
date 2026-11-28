import type { RouteDefinition } from '../../middleware/routeRegistry.js';
import { listStaff } from '../../modules/users/staffList.js';

/**
 * Who works here, for the manager screens: READ ONLY. Staff accounts are
 * created and managed by the Sales person (`/api/platform/tenants/:id/staff`),
 * never from the restaurant's own screens -- the manager's invite, staff-login,
 * grant, reset and tablet setup-code routes were removed with the Basic-only
 * product.
 */

type Handler = RouteDefinition['handler'];

/**
 * A request that needs a branch from a session that names none -- a POS or sync
 * write from a tenant-level password session. Kept here because the POS and
 * sync handlers share it.
 */
export class BranchScopeRequiredError extends Error {
  readonly statusCode = 422;
  readonly code = 'branch_scope_required';
  constructor(what: string) {
    super(
      `${what} belongs to a branch and this session names none. A tenant-level ` +
        'password session has no branch scope, so sign in at the branch instead ' +
        'of naming one in the request.',
    );
    this.name = 'BranchScopeRequiredError';
  }
}

export function staffHandlers(): Record<string, Handler> {
  return {
    staffList: async (_request, _reply, context) => listStaff(context),
  };
}
