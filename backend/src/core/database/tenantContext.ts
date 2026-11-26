import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';

/**
 * The tenant context is the only place a tenant_id may come from, and it is only
 * ever populated from a verified JWT -- never from a body, query param or header.
 *
 * It carries the client as well as the id, so a repository call cannot be issued
 * against a connection that has not had the GUC set on it. The two travel
 * together or not at all.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly client: pg.ClientBase;
  /** Set once the acting membership is known; the audit writer requires it. */
  readonly actor: ActorContext | null;
}

export interface ActorContext {
  readonly userId: string;
  readonly branchId: string | null;
  /** The membership whose role held the permission that allowed this request. */
  readonly authorisingMembershipId: string | null;
  readonly viaImpersonation: boolean;
}

export class MissingTenantContextError extends Error {
  constructor(operation: string) {
    super(
      `${operation} was attempted with no tenant context. ` +
        'Every tenant-plane query must run inside withTenantTransaction.',
    );
    this.name = 'MissingTenantContextError';
  }
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runInTenantContext<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

/** Null rather than throwing, for callers that legitimately need to ask. */
export function peekTenantContext(): TenantContext | null {
  return storage.getStore() ?? null;
}

/**
 * Throws rather than returning null. An unset tenant context must fail loudly at
 * the point of use -- the alternative is a query that runs without a predicate,
 * or one that RLS silently filters to zero rows.
 */
export function requireTenantContext(operation: string): TenantContext {
  const context = storage.getStore();
  if (!context) throw new MissingTenantContextError(operation);
  return context;
}
