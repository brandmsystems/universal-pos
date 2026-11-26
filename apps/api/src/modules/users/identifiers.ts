import type { TenantContext } from '../../core/database/tenantContext.js';

/**
 * How a person is named for sign-in, shared by the staff invite and the self
 * PIN set-up so the two cannot accept different codes.
 */

export const STAFF_CODE = /^[A-Z0-9]{1,12}$/;

export class StaffIdentifierTakenError extends Error {
  readonly statusCode = 409;
  readonly code = 'staff_identifier_taken';
  constructor(what: 'email' | 'staff code') {
    super(`this ${what} already belongs to someone on the staff, or to a pending invite.`);
    this.name = 'StaffIdentifierTakenError';
  }
}

/** Free among people AND live invites: an invite reserves its code until it expires. */
export async function assertIdentifierFree(
  context: TenantContext, column: 'email' | 'employee_code', value: string,
): Promise<void> {
  const taken = await context.client.query(
    `SELECT 1 FROM app.app_user WHERE tenant_id = $1 AND ${column} = $2
     UNION ALL
     SELECT 1 FROM app.staff_invite
      WHERE tenant_id = $1 AND ${column} = $2 AND status = 'pending' AND expires_at > now()`,
    [context.tenantId, value]);
  if ((taken.rowCount ?? 0) > 0) {
    throw new StaffIdentifierTakenError(column === 'email' ? 'email' : 'staff code');
  }
}
