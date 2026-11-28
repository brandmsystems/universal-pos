import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { RouteDefinition } from '../../middleware/routeRegistry.js';
import type { Value } from '../../database/baseRepository.js';
import {
  ADMIN_RESOURCES, writableOnly,
  ResourceNotArchivableError, NothingToUpdateError,
  type AdminResource, type ServerFilledColumn,
} from '../../modules/businesses/adminResources.js';
import { requiredFields } from '../../modules/businesses/requiredColumns.js';
import { BranchRepository } from '../../database/repositories.js';

type Handler = RouteDefinition['handler'];

/**
 * Branch admin, generated from `ADMIN_RESOURCES`.
 *
 * ###########################################################################
 * GENERATED FROM A DECLARATION, NOT COPIED SEVEN TIMES.
 *
 * Forty hand-written CRUD handlers are forty chances to forget the branch scope,
 * return a column that should not leave the server, or pass the body straight
 * into an UPDATE. The seventh copy is the one that does all three.
 *
 * So the shape is: one implementation per verb, driven by a table that states
 * per resource which columns leave, which fields may be set, and whether the
 * rows belong to a branch. Adding a resource is a declaration; it cannot forget
 * a rule the implementation applies.
 *
 * The correspondence gate still applies -- every generated route needs a handler
 * name that exists, and every handler needs a route -- so a resource declared
 * here without a route in the table fails at boot, and a route whose resource is
 * missing from the table fails the same way.
 * ###########################################################################
 */

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string') throw new Error(`missing path parameter ${name}`);
  return value;
}

function body(request: FastifyRequest): Record<string, unknown> {
  const raw = request.body;
  return raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

/**
 * The branch, from the verified token, and null only when the token carries
 * none -- a password session, which is the admin path.
 *
 * A branch-scoped resource read with NO branch on the token returns every branch
 * the tenant has, which is right: that session belongs to somebody signed in at
 * the tenant level rather than standing at a till. A branch-scoped resource read
 * WITH a branch is scoped to it, and the client cannot widen that by asking.
 */
function branchOnToken(request: FastifyRequest): string | null {
  const value = (request.claims ?? {})['branch_id'];
  return typeof value === 'string' ? value : null;
}

/**
 * The row is not one this session can see: it does not exist, or it belongs to
 * another restaurant (RLS) or another branch (the scope predicate). ONE answer
 * for all three, so it confirms nothing about another tenant's ids -- a
 * made-up uuid and a neighbour's real one are indistinguishable.
 *
 * It used to be `200 { updated: false }`. That leaked nothing either, but it
 * was a success status for a write that did not happen: a screen reading the
 * status showed "saved", and absence was being reported as a result.
 */
export class AdminRowNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'row_not_found';
  constructor(resource: string) {
    super(`no ${resource} row with that id is visible to this session`);
    this.name = 'AdminRowNotFoundError';
  }
}

export class DeclaredColumnMissingError extends Error {
  readonly code = 'declared_column_missing';
  constructor(resource: string, column: string) {
    super(
      `${resource} declares a column "${column}" that the row does not have. ` +
        'A column that does not exist would otherwise render as "not set", which ' +
        'is the one thing this layer must never do.',
    );
    this.name = 'DeclaredColumnMissingError';
  }
}

/**
 * ###########################################################################
 * A MISSING COLUMN IS NOT A NULL VALUE.
 *
 * This was `out[column] = row[column] ?? null`, and the `??` covered two
 * completely different facts: a real column holding NULL, and a column name that
 * does not exist on the table at all. Both rendered as an em-dash meaning "not
 * set".
 *
 * The declaration for `menu/items` named `tax_class_key` and `is_combo`. Neither
 * exists -- the columns are `tax_class_id` and there is no combo flag on the
 * table -- so two columns of every row read as "not set" and the admin screen
 * looked entirely plausible. Exactly the failure the resource table was written
 * to prevent, made by the resource table.
 *
 * `column in row` distinguishes them. A NULL value passes through as null; an
 * absent key is a programming error and says so loudly. The gate in
 * tests/http/adminSurface.test.ts catches it earlier, against
 * information_schema, so this is the backstop rather than the notice.
 * ###########################################################################
 */
function pick(
  resource: string,
  row: Record<string, unknown>,
  columns: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    if (!(column in row)) throw new DeclaredColumnMissingError(resource, column);
    out[column] = row[column] ?? null;
  }
  return out;
}

function pagination(request: FastifyRequest): { limit: number; offset: number } {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const asked = Number(query['limit'] ?? PAGE_DEFAULT);
  const skip = Number(query['offset'] ?? 0);
  return {
    // Clamped rather than refused: an admin list is not a place to argue about a
    // query string, and an unbounded limit is how one screen reads a whole
    // tenant's menu into memory.
    limit: Number.isFinite(asked) ? Math.min(Math.max(1, Math.trunc(asked)), PAGE_MAX) : PAGE_DEFAULT,
    offset: Number.isFinite(skip) ? Math.max(0, Math.trunc(skip)) : 0,
  };
}

function scope(resource: AdminResource, request: FastifyRequest): Record<string, Value> {
  const predicate: Record<string, Value> = {};
  if (resource.branchColumn !== null) {
    const branchId = branchOnToken(request);
    if (branchId !== null) predicate[resource.branchColumn] = branchId;
  }
  return predicate;
}

export class AdminBranchUnknownError extends Error {
  readonly statusCode = 404;
  readonly code = 'branch_unknown';
  constructor(branchId: string) {
    super(`no active branch ${branchId} in this restaurant`);
    this.name = 'AdminBranchUnknownError';
  }
}

export class AdminBranchConflictError extends Error {
  readonly statusCode = 422;
  readonly code = 'branch_conflict';
  constructor() {
    super('this session is signed in at a branch, so it works there; it cannot name another.');
    this.name = 'AdminBranchConflictError';
  }
}

/**
 * The branch a branch-LESS session names, from the query string -- the same
 * rule as the stock screens and staff invites. A branch-scoped session always
 * uses its own and may not name another.
 */
function namedBranch(request: FastifyRequest): string | null {
  const value = (request.query as Record<string, unknown> | undefined)?.['branchId'];
  const named = typeof value === 'string' && value.length > 0 ? value : null;
  const own = branchOnToken(request);
  if (own !== null && named !== null && named !== own) throw new AdminBranchConflictError();
  return own ?? named;
}

/**
 * The branch a write lands in: the session's own, or an ACTIVE branch of this
 * restaurant that a branch-less session names. Null when neither is given.
 */
export async function activeBranchFor(request: FastifyRequest): Promise<string | null> {
  const branchId = namedBranch(request);
  if (branchId === null || branchId === branchOnToken(request)) return branchId;
  const branch = await new BranchRepository().findOne({ id: branchId, status: 'active' });
  if (!branch) throw new AdminBranchUnknownError(branchId);
  return branchId;
}

/** List scope: the session's branch, or the one a branch-less session names. */
function listScope(resource: AdminResource, request: FastifyRequest): Record<string, Value> {
  if (resource.branchColumn === null) return {};
  const branchId = namedBranch(request);
  return branchId === null ? {} : { [resource.branchColumn]: branchId };
}

function listHandler(name: string, resource: AdminResource): Handler {
  return async (request, _reply, context) => {
    const { limit, offset } = pagination(request);
    const rows = await resource.repository().findMany(
      listScope(resource, request),
      { orderBy: resource.orderBy, limit, offset },
    );
    // Hidden states are filtered here rather than in SQL because the predicate
    // builder takes equality only, and a NOT IN belongs in a purpose-built read
    // rather than in the generic predicate language. The cost is that a page can
    // come back short; `limit`/`offset` are the caller's, and the count is not
    // claimed to be exact.
    const visible = resource.hideStates.length === 0
      ? rows
      : rows.filter((row) => !resource.hideStates.includes(String(row['status'] ?? '')));

    return {
      resource: name,
      rows: visible.map((row) => pick(name, row, resource.columns)),
      limit,
      offset,
      /** True when the page filled, so a client knows to ask for another. */
      more: rows.length === limit,
      /**
       * ###################################################################
       * THE LIST TELLS THE CLIENT WHAT IS WRITABLE, AND WHAT A DELETE MEANS.
       *
       * Without this, an admin form has two bad options: render every column as
       * an input and have the whole request refused because one of them is not
       * writable, or keep its own copy of the writable set -- a second
       * declaration, which drifts.
       *
       * Sending it means the allowlist stays a single fact on the server and the
       * client can be honest about what it offers. It leaks nothing: a caller
       * who can read this list can already discover the writable set by trying,
       * and `fields_not_writable` names it in the refusal anyway.
       *
       * `deletes` matters because "Archive" and "Delete" are different words to
       * put in front of a manager, and only the server knows which one this
       * resource does.
       * ###################################################################
       */
      editable: resource.editable,
      creatable: resource.creatable,
      // Which of those must have a value, from the table's own NOT NULLs, so a
      // form can mark them rather than learn it from a refusal.
      required: await requiredFields(context, resource),
      deletes: resource.archivedBy !== null
        ? 'archive'
        : resource.hardDelete ? 'remove' : 'none',
    };
  };
}

/**
 * The subject of the request, from the VERIFIED token.
 *
 * Never from the body. `archivedBy` already relied on this for
 * `revoked_by_user_id`; `createdBy` needs the same value for
 * `supplier.created_by_user_id`, so the read is named once instead of twice.
 */
function actorOnToken(request: FastifyRequest): string {
  const actor = (request.claims ?? {})['sub'];
  if (typeof actor !== 'string') throw new Error('no subject on the request');
  return actor;
}

/**
 * Resolves the columns the SERVER fills, from the transaction clock and the
 * token. Shared by create and archive because they are the same rule applied at
 * two moments, and two copies of it is how one of them ends up reading a body.
 */
function serverFilled(
  request: FastifyRequest,
  assignments: readonly ServerFilledColumn[],
): Record<string, Value> {
  const values: Record<string, Value> = {};
  for (const assignment of assignments) {
    if (typeof assignment.value === 'string') {
      values[assignment.column] = assignment.value;
      continue;
    }
    // The application clock, not the database's, only because the repository
    // takes values rather than expressions. Both are the server's; neither is
    // the caller's, which is the property that matters.
    values[assignment.column] =
      assignment.value.from === 'now' ? new Date() : actorOnToken(request);
  }
  return values;
}

function createHandler(name: string, resource: AdminResource): Handler {
  return async (request) => {
    const values = writableOnly(name, body(request), resource.creatable);
    if (Object.keys(values).length === 0) throw new NothingToUpdateError(name);
    // The branch is the token's when the resource has one. Never the body's:
    // that is the same rule the POS handlers follow, for the same reason.
    if (resource.branchColumn !== null) {
      const branchId = await activeBranchFor(request);
      if (branchId === null) {
        throw new NothingToUpdateError(
          `${name} (this session names no branch: sign in at one, or name it with ?branchId=)`);
      }
      values[resource.branchColumn] = branchId;
    }
    // The id is minted HERE, not accepted from the body. A caller-supplied
    // primary key is a way to probe for existing rows (insert and read the
    // conflict) and, worse, a way to collide deliberately with a row another
    // tenant's write is about to create.
    values['id'] = randomUUID();
    // NOT NULL attribution columns, from the token. Without this the generic
    // create cannot satisfy `app.supplier.created_by_user_id` and every
    // POST /admin/suppliers is refused by the not-null constraint -- a served
    // route that never once worked.
    if (resource.createdBy !== null) {
      Object.assign(values, serverFilled(request, resource.createdBy));
    }
    const row = await resource.repository().insert(values);
    return pick(name, row, resource.columns);
  };
}

function editHandler(name: string, resource: AdminResource): Handler {
  return async (request) => {
    const values = writableOnly(name, body(request), resource.editable);
    if (Object.keys(values).length === 0) throw new NothingToUpdateError(name);
    // Scoped by id AND by branch where there is one, so a branch-scoped session
    // cannot edit another branch's station by naming its id.
    const rows = await resource.repository().update(
      { id: param(request, 'id'), ...scope(resource, request) },
      values,
    );
    const row = rows[0];
    if (!row) throw new AdminRowNotFoundError(name);
    return pick(name, row, resource.columns);
  };
}

function archiveHandler(name: string, resource: AdminResource): Handler {
  return async (request) => {
    const archive = resource.archivedBy;
    if (archive === null) throw new ResourceNotArchivableError(name);

    const values = serverFilled(request, archive);

    const rows = await resource.repository().update(
      { id: param(request, 'id'), ...scope(resource, request) },
      values,
    );
    // Not a delete, and the response says which state the row is in now rather
    // than `{ deleted: true }` -- a caller told "deleted" about a row that still
    // exists will build on that.
    if (rows.length === 0) throw new AdminRowNotFoundError(name);
    const [statusColumn] = archive;
    return {
      id: param(request, 'id'),
      [statusColumn!.column]: values[statusColumn!.column],
      archived: true,
    };
  };
}

function deleteHandler(name: string, resource: AdminResource): Handler {
  return async (request) => {
    // A real DELETE. Safe only because the referencing constraint refuses one
    // that is in use -- see `hardDelete` in the declaration.
    const removed = await resource.repository().delete(
      { id: param(request, 'id'), ...scope(resource, request) });
    if (removed === 0) throw new AdminRowNotFoundError(name);
    return { id: param(request, 'id'), deleted: true };
  };
}

/* ------------------------------------------------- the purpose-built ones --- */

/** Hand-written handlers, keyed exactly as the declaration's `purposeBuilt` says. */
const PURPOSE_BUILT: Readonly<Record<string, Handler>> = {
  // `devices.create` is the enrolment token and lives in http/handlers/staff.ts,
  // with the other two actions that mint or destroy a credential. It is NOT
  // listed here: one handler name must come from exactly one map, or
  // `mergeHandlers` refuses the collision at boot -- which is the behaviour that
  // caught the POS board serving the kitchen's data.
};

export function adminHandlers(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  for (const [name, resource] of Object.entries(ADMIN_RESOURCES)) {
    handlers[`${name}.list`] = listHandler(name, resource);
    const generated = (verb: 'create' | 'edit' | 'archive'): boolean =>
      !resource.purposeBuilt.includes(verb);

    // A verb is supplied only where the declaration supports it: a resource with
    // no creatable fields gets no create handler, so the correspondence gate
    // reports the generated POST route as unserved instead of the handler
    // silently refusing every call at runtime.
    //
    // A verb named in `purposeBuilt` is skipped even if fields were declared for
    // it, so the two can never both answer. That is a guard against the shape
    // where somebody adds a column to `editable` for convenience and silently
    // takes the route back off the hand-written implementation.
    if (generated('create') && resource.creatable.length > 0) {
      handlers[`${name}.create`] = createHandler(name, resource);
    }
    if (generated('edit') && resource.editable.length > 0) {
      handlers[`${name}.edit`] = editHandler(name, resource);
    }
    // Archive and hard delete are the same ROUTE with different meanings, so
    // they share the handler name and the declaration picks which one runs. A
    // resource declaring both would be ambiguous; the type does not prevent it,
    // so the gate in tests/http/adminSurface.test.ts does.
    if (generated('archive')) {
      if (resource.archivedBy !== null) {
        handlers[`${name}.archive`] = archiveHandler(name, resource);
      } else if (resource.hardDelete) {
        handlers[`${name}.archive`] = deleteHandler(name, resource);
      }
    }

    // And the hand-written ones, for the verbs this map owns. `devices.create`
    // is declared purpose-built and served elsewhere, so a missing entry here is
    // not an error -- the correspondence gate is what checks it is served at all.
    for (const verb of resource.purposeBuilt) {
      const built = PURPOSE_BUILT[`${name}.${verb}`];
      if (built !== undefined) handlers[`${name}.${verb}`] = built;
    }
  }
  return handlers;
}
