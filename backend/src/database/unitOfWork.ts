import type pg from 'pg';
import {
  runInTenantContext,
  type ActorContext,
  type TenantContext,
} from './tenantContext.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantIdError extends Error {
  constructor(value: string) {
    super(`refusing to open a tenant transaction for a non-uuid tenant id: ${JSON.stringify(value)}`);
    this.name = 'InvalidTenantIdError';
  }
}

export interface TenantTransactionOptions {
  readonly actor?: ActorContext;
  /** Rolls back instead of committing. Used by tests and by read-only probes. */
  readonly rollback?: boolean;
}

/**
 * One transaction, one tenant, one connection.
 *
 * set_config($1, $2, true) rather than `SET LOCAL app.tenant_id = ...`: SET takes
 * no bind parameters at all, so the only way to carry a value safely is the
 * function form. is_local => true makes it transaction-scoped exactly as
 * SET LOCAL would, which is why transaction-scoped pooling is a hard requirement
 * and is asserted at startup.
 *
 * The GUC is set as the first statement after BEGIN, so no query in the callback
 * can run before RLS has a tenant to compare against.
 */
export async function withTenantTransaction<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (context: TenantContext) => Promise<T>,
  options: TenantTransactionOptions = {},
): Promise<T> {
  if (!UUID.test(tenantId)) throw new InvalidTenantIdError(tenantId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);

    const context: TenantContext = {
      tenantId,
      client,
      actor: options.actor ?? null,
    };

    try {
      const result = await runInTenantContext(context, () => fn(context));
      await client.query(options.rollback === true ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Adopts a tenant into a transaction that is ALREADY OPEN.
 *
 * ###########################################################################
 * FOR THE PRE-AUTH PATH ONLY, AND IT IS NOT A SECOND WAY TO OPEN A TRANSACTION.
 *
 * `withTenantTransaction` takes a pool and owns the BEGIN, which is what makes
 * "the GUC is set as the first statement after BEGIN" true by construction. The
 * credential surface cannot use it: the public registrar has already opened the
 * transaction that must span the credential verify and the auth_attempt row, and
 * the tenant is not known until a slug or a composite token has been resolved
 * INSIDE that transaction.
 *
 * So the GUC is set later than the first statement here -- deliberately, and the
 * statements that ran before it are the two control-plane reads that carry no
 * RLS (`platform.tenant`, `platform.auth_attempt`). Any tenant-table query in a
 * pre-auth handler must come after this call, and the tenant id must come from
 * a resolved slug or a verified token, never straight from a body.
 * ###########################################################################
 */
export async function adoptTenantContext(
  client: pg.ClientBase,
  tenantId: string,
): Promise<TenantContext> {
  if (!UUID.test(tenantId)) throw new InvalidTenantIdError(tenantId);
  await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
  return { tenantId, client, actor: null };
}
