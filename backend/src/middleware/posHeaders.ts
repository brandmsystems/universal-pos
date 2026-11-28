import type { FastifyRequest } from 'fastify';

/**
 * Request-shape guards for the POS surface, in their own module because the
 * route registrar needs the lease-token guard and the route table imports the
 * registrar. Keeping them here breaks the cycle without giving either side a
 * reason to declare the header names twice.
 */

export class IdempotencyKeyRequiredError extends Error {
  readonly code = 'idempotency_key_required';
  constructor() {
    super('every POS mutation requires an Idempotency-Key header');
    this.name = 'IdempotencyKeyRequiredError';
  }
}

export class LeaseTokenRequiredError extends Error {
  readonly code = 'lease_token_required';
  constructor(url: string) {
    super(`${url} touches a leased session and requires an X-Lease-Token header`);
    this.name = 'LeaseTokenRequiredError';
  }
}

/**
 * Required, never optional.
 *
 * A tablet that forgets the key gets a 400 rather than a silent double-fire. The
 * failure mode of optional is two KOTs and two stock deductions for one order,
 * discovered by a customer being charged twice.
 */
export function requireIdempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new IdempotencyKeyRequiredError();
  }
  return key.trim();
}

/**
 * ###########################################################################
 * ONE PREDICATE FOR "THIS WRITE MUST BE IDEMPOTENT", READ BY BOTH CALLERS.
 *
 * The header requirement lives in the onRequest hook (so a missing key costs no
 * pooled connection) and the CLAIM lives in the registrar (so it happens inside
 * the mutation's transaction). Those are two different places, and while they
 * each spelled the rule out for themselves they could disagree -- which is
 * exactly what happened in the weaker form: the hook demanded a key on every
 * POS mutation and eleven of the twelve handlers threw it away.
 *
 * Keying on the URL prefix is geography, and this codebase has been bitten by a
 * gate that passed because a file sat one directory over. It is used here only
 * because the alternative -- a per-route `idempotent` flag -- can be forgotten
 * on a new route, whereas a prefix cannot: a POS mutation that is not under
 * `/pos/` would not be a POS route. The gate in tests/http/leaseEnforcement.ts
 * asserts the real route table's coverage rather than trusting the reasoning.
 * ###########################################################################
 */
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * ###########################################################################
 * POS READS THAT HAVE TO BE POSTs, DECLARED RATHER THAN INFERRED.
 *
 * `/pos/customer/lookup` mutates nothing. It is a POST because the phone
 * number travels in the BODY: a GET would put a diner's number in a URL, and
 * URLs are written to the access log of every proxy between a tablet and this
 * server -- which is the exact exposure the privacy posture of the customer
 * feature exists to prevent.
 *
 * Left to the method-and-prefix rule it would be claimed like a mutation, and a
 * claimed read is worse than a pointless one: a retry under the same key
 * REPLAYS the stored answer, so a cashier who taps again gets the balance from
 * a minute ago rather than the balance now. The claim table would also grow by
 * a row per customer lookup, which is the most frequent read at a till.
 *
 * So it is an exception, and it is a DECLARED one. The comment above warns that
 * a per-route flag can be forgotten on a new route while a prefix cannot --
 * true, which is why this is a list of exceptions rather than an `idempotent`
 * flag on every route: forgetting to add to this list leaves a new route
 * CLAIMED, which is the safe direction. The gate in
 * tests/http/leaseEnforcement.test.ts reads this same constant, so the rule has
 * one spelling.
 * ###########################################################################
 */
export const POS_POST_READS: readonly string[] = ['/pos/customer/lookup', '/pos/quote'];

export function requiresIdempotency(method: string, url: string): boolean {
  if (POS_POST_READS.some((read) => url.endsWith(read))) return false;
  return MUTATING.includes(method) && url.includes('/pos/');
}

export function requireLeaseToken(request: FastifyRequest, url: string): string {
  const token = request.headers['x-lease-token'];
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new LeaseTokenRequiredError(url);
  }
  return token.trim();
}
