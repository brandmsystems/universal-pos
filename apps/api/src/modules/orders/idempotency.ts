import { createHash } from 'node:crypto';
import type { TenantContext } from '../../core/database/tenantContext.js';

/**
 * Idempotency for order mutations.
 *
 * A waiter taps "send to kitchen", the network stalls, they tap again. That must
 * not produce two KOTs and double the food.
 *
 * Same mechanism as provisioning -- unique claim, SAVEPOINT, re-read -- at far
 * higher volume, which is why request_claim is hash-partitioned with a retention
 * policy rather than growing forever.
 */

export class IdempotencyConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'idempotency_key_reused';
  constructor(key: string, operation: string) {
    super(
      `idempotency key ${JSON.stringify(key)} was already used for ${operation} with a ` +
        'different payload. Reusing a key with changed parameters is a bug, not a retry.',
    );
    this.name = 'IdempotencyConflictError';
  }
}

export function digestOf(payload: unknown): Buffer {
  // Key order is stabilised so a client serialising the same object differently
  // does not read as a different request.
  return createHash('sha256').update(stableStringify(payload)).digest();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export interface ClaimRequest {
  readonly idempotencyKey: string;
  readonly operation: string;
  /** Null for a sign-in with no branch (the owner at the admin): the column is uuid. */
  readonly branchId: string | null;
  readonly payload: unknown;
}

export type ClaimOutcome<T> =
  | { readonly replayed: false }
  | { readonly replayed: true; readonly result: T };

/**
 * Claims the key, or returns the stored result of the original request.
 *
 * The SAVEPOINT is not optional: a unique violation aborts the transaction, so
 * without it the loser of a concurrent duplicate could only roll back, never read
 * the winner's answer. The loser blocks on the winner's row lock until commit,
 * so by the time the violation is raised the winner's row is visible.
 *
 * Acquired FIRST in the fire transaction's global lock order.
 */
export async function claimOrReplay<T>(
  context: TenantContext,
  request: ClaimRequest,
): Promise<ClaimOutcome<T>> {
  const digest = digestOf(request.payload);

  const existing = await readClaim<T>(context, request, digest);
  if (existing) return { replayed: true, result: existing };

  await context.client.query('SAVEPOINT request_claim');
  try {
    await context.client.query(
      `INSERT INTO app.request_claim
         (tenant_id, idempotency_key, branch_id, operation, request_digest, result)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)`,
      [context.tenantId, request.idempotencyKey, request.branchId, request.operation, digest],
    );
    await context.client.query('RELEASE SAVEPOINT request_claim');
    return { replayed: false };
  } catch (error) {
    await context.client.query('ROLLBACK TO SAVEPOINT request_claim');
    if ((error as { code?: string }).code === '23505') {
      const winner = await readClaim<T>(context, request, digest);
      if (winner) return { replayed: true, result: winner };
    }
    throw error;
  }
}

async function readClaim<T>(
  context: TenantContext,
  request: ClaimRequest,
  digest: Buffer,
): Promise<T | null> {
  const prior = await context.client.query<{ request_digest: Buffer; operation: string; result: T }>(
    `SELECT request_digest, operation, result FROM app.request_claim
      WHERE tenant_id = $1 AND idempotency_key = $2`,
    [context.tenantId, request.idempotencyKey],
  );
  const row = prior.rows[0];
  if (!row) return null;

  // Same key, different payload: raise. Never silently apply the second payload.
  if (row.operation !== request.operation || !row.request_digest.equals(digest)) {
    throw new IdempotencyConflictError(request.idempotencyKey, row.operation);
  }
  return row.result;
}

/**
 * Stores the result so a retry replays it verbatim. The second tap must get the
 * SAME fire number back, not merely "ok".
 */
export async function recordClaimResult(
  context: TenantContext,
  idempotencyKey: string,
  result: unknown,
): Promise<void> {
  await context.client.query(
    `UPDATE app.request_claim SET result = $3::jsonb
      WHERE tenant_id = $1 AND idempotency_key = $2`,
    [context.tenantId, idempotencyKey, JSON.stringify(result)],
  );
}
