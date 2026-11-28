import { randomUUID } from 'node:crypto';
import { BaseRepository } from '../../database/baseRepository.js';
import { AppUserRepository } from '../../database/repositories.js';

/**
 * Reading a contact detail, and the record of having read it.
 *
 * ###########################################################################
 * THE LOG WRITE AND THE READ ARE ONE FUNCTION. THEY CANNOT BE SEPARATED.
 *
 * `app.pii_access_log` is a DIFFERENT log from `app.tenant_audit_log` and it has
 * a DIFFERENT audience: the DPO, not loss prevention. The exception report
 * derives its two sections from `permission.risk_subclass` and privacy-class keys
 * are in neither, deliberately -- an owner scanning for till fraud must not have
 * to page through customer lookups.
 *
 * The reason this lives in a domain module rather than in the handler is that a
 * log write a handler performs is a log write a handler can omit. There is no
 * exported way to obtain a contact detail from this module WITHOUT the row being
 * written, and both run in the caller's transaction: a failed insert rolls the
 * response back, so a revealed record cannot be unlogged, and a rolled-back
 * request cannot leave a phantom reveal.
 *
 * `src/modules/businesses/adminResources.ts` drops `email` from the generic users projection for
 * exactly this reason -- the generic CRUD handler cannot write here, so it does
 * not return the field. That must stay true; these two functions are the only
 * way the column leaves the server.
 * ###########################################################################
 *
 * ---------------------------------------------------------------------------
 * THERE ARE TWO SUBJECTS NOW, AND THE LOG SAYS WHICH.
 *
 * This module used to note that `app.customer` did not exist, so
 * `GET /admin/customers/:id/contact` -- a route named for customers, behind a
 * permission described as revealing a customer's phone -- read `app_user` and
 * logged staff reveals under `customer.pii.view`.
 *
 * Migration 0049 created the table, so the customer route reveals a CUSTOMER,
 * and staff reveals moved to their own route behind their own key,
 * `user.pii.view`. Both write here; `permission_key` is what distinguishes the
 * two, and `pii_access_shape_exact` now admits all three keys with the shape
 * each one requires.
 *
 * `pii_access_log.customer_id` still carries NO foreign key, deliberately. It
 * holds either kind of subject, and every row written before today refers to a
 * staff member -- adding the FK would invalidate the existing log, which is the
 * one thing an append-only privacy record must never permit.
 * ---------------------------------------------------------------------------
 */

export interface PiiAccessLogRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  branch_id: string | null;
  actor_user_id: string;
  permission_key: string;
  customer_id: string | null;
  query_descriptor: unknown;
  result_count: number | null;
  reason: string | null;
  occurred_at: Date;
}

/**
 * Append-only at the database: UPDATE and DELETE are revoked from
 * `katkitchen_app` and refused by trigger regardless of what is called here.
 */
export class PiiAccessLogRepository extends BaseRepository<PiiAccessLogRow> {
  protected readonly table = 'app.pii_access_log';
}

export class PiiSubjectNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'pii_subject_not_found';
  constructor(subjectId: string) {
    super(
      `no contact record ${subjectId} in this tenant. Nothing was revealed, so ` +
        'nothing was written to the privacy log -- the attempt is in the tenant ' +
        'audit log, which is where an enumeration attempt belongs.',
    );
    this.name = 'PiiSubjectNotFoundError';
  }
}

export interface RevealedContact {
  readonly subjectId: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly employeeCode: string | null;
}

function stringOrNull(row: Record<string, unknown>, name: string): string | null {
  const raw = row[name];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function staffContactOf(row: Record<string, unknown>): RevealedContact {
  return {
    subjectId: String(row['id']),
    fullName: String(row['full_name']),
    email: stringOrNull(row, 'email'),
    phone: stringOrNull(row, 'phone'),
    employeeCode: stringOrNull(row, 'employee_code'),
  };
}

/**
 * The same act for a member of STAFF, and a separate permission because it is a
 * separate decision.
 *
 * `src/modules/businesses/adminResources.ts` drops `email` from the generic users projection
 * because reading staff PII is a logged event -- and until 0049 the only route
 * that could read it was the one named for customers. So this is not a new
 * capability; it is the capability that route was quietly providing, given its
 * own key so that granting somebody the ability to look up a diner's phone does
 * not also hand them the staff directory.
 */
export async function revealStaffContact(params: {
  readonly subjectId: string;
  readonly actorUserId: string;
  readonly branchId: string | null;
  readonly reason: string | null;
}): Promise<{ readonly subject: RevealedContact; readonly accessLogId: string }> {
  const row = await new AppUserRepository().findOne({ id: params.subjectId });
  if (!row) throw new PiiSubjectNotFoundError(params.subjectId);

  const accessLogId = randomUUID();
  await new PiiAccessLogRepository().insert({
    id: accessLogId,
    branch_id: params.branchId,
    actor_user_id: params.actorUserId,
    permission_key: 'user.pii.view',
    customer_id: params.subjectId,
    query_descriptor: null,
    result_count: null,
    reason: params.reason,
  });

  return { subject: staffContactOf(row), accessLogId };
}

