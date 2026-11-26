import { beforeEach, describe, expect, it } from 'vitest';
import { createStore } from '../src/services/storage.js';
import { ApiError, type Api, type ApiFailure } from '../src/services/api.js';
import { createLeases } from '../src/services/lease.js';

/**
 * A renewal the server refuses with `lease_not_held` can never succeed, so the
 * lease is forgotten -- before this, the tablet renewed a dead lease every
 * minute for as long as it stayed open. Every OTHER failure keeps it: offline,
 * the window is still running down and queued work still carries the token.
 */

const SESSION = '11111111-1111-4111-8111-111111111111';
const DEVICE = 'd1';

let renewal: () => never;

function leasesWith(): ReturnType<typeof createLeases> {
  const api = {
    mutate: async (_path: string, body: { renew?: boolean }) => {
      if (body.renew === true) renewal();
      return {
        sessionId: SESSION, deviceId: DEVICE, token: 't1',
        expiresAt: '2026-10-01 10:15:00+00', claimedAt: '2026-10-01 10:00:00+00',
      };
    },
  } as unknown as Api;
  return createLeases(createStore(), api);
}

const failing = (failure: ApiFailure) => (): never => { throw new ApiError(failure, 'refused'); };

beforeEach(() => window.localStorage.clear());

describe('a refused renewal', () => {
  it('is forgotten when the server holds no live lease for this tablet', async () => {
    const leases = leasesWith();
    await leases.claim(SESSION, 'b1', DEVICE);
    expect(leases.tokenFor(SESSION)).toBe('t1');

    renewal = failing({ kind: 'refused', status: 409, code: 'lease_not_held', retryable: false });
    expect(await leases.renew(SESSION, DEVICE)).toBeNull();
    expect(leases.tokenFor(SESSION)).toBeNull();
    expect(leases.held()).toEqual([]);
  });

  it.each<[string, ApiFailure]>([
    ['offline', { kind: 'offline' }],
    ['signed out', { kind: 'signed-out' }],
    ['a server fault', { kind: 'refused', status: 500, code: 'internal_error', retryable: false }],
    ['another refusal', { kind: 'refused', status: 409, code: 'order_in_billing', retryable: false }],
  ])('is kept when the failure is %s', async (_name, failure) => {
    const leases = leasesWith();
    await leases.claim(SESSION, 'b1', DEVICE);

    renewal = failing(failure);
    expect(await leases.renew(SESSION, DEVICE)).toBeNull();
    expect(leases.tokenFor(SESSION)).toBe('t1');
  });
});
