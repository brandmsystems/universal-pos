import type { Store } from './storage.js';

/**
 * The API client. The ONLY thing in the app that calls fetch.
 *
 * ###########################################################################
 * TWO TOKENS, TWO LIFETIMES, AND THE REFRESH TOKEN IS NOT A BEARER CREDENTIAL.
 *
 * Access tokens last 15 minutes; refresh tokens 12 hours, about a shift. The
 * server rejects a refresh token presented as a bearer with its own error code,
 * so it lives here and never goes near an Authorization header.
 *
 * Refresh happens on a 401 and AT MOST ONCE per failed request -- never on a
 * timer. A timer plus a sleeping tablet produces a thundering refresh at every
 * shift change, and a POS has a whole restaurant of tablets waking at once.
 * ###########################################################################
 */

export interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** The restaurant. Learned at enrolment and the last thing to forget. */
  readonly tenantSlug: string;
  readonly branchId: string | null;
  readonly userId: string;
}

/** Learned at enrolment, before any user signs in. Outlives every session. */
export interface DeviceIdentity {
  readonly tenantSlug: string;
  readonly deviceId: string;
  readonly branchId: string;
  readonly fingerprint: string;
}

const DEVICE_KEY = 'device.v1';
const SESSION_KEY = 'session.v1';

export type ApiFailure =
  | { readonly kind: 'refused'; readonly status: number; readonly code: string; readonly retryable: boolean }
  | { readonly kind: 'offline' }
  | { readonly kind: 'signed-out' };

export class ApiError extends Error {
  constructor(readonly failure: ApiFailure, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The refusal body, as the server actually sends it.
 *
 * ###########################################################################
 * `detail` IS THE FIELD, AND IT USED TO BE THROWN AWAY.
 *
 * `toErrorResponse` in src/core/errors/errors.ts answers `{ error, retryable, detail }`
 * and has since the contract was written. This type read `message`, which the
 * server has never sent, so every refusal reached every screen carrying its
 * bare code as the message: `fields_not_writable`, `field_required`,
 * `reference_invalid`, `guest_no_out_of_range`.
 *
 * Those are precisely the refusals whose entire value is the sentence.
 * `fields_not_writable` names the fields the route DOES accept;
 * `reference_invalid` names the constraint that refused the write. A screen
 * told only "fields_not_writable" says "that did not go through", and the
 * person tries the same thing again.
 *
 * `message` is kept in the type and read as a fallback: Fastify's own errors
 * (a malformed JSON body, a 404 from the router) use it, and those are real
 * responses this client can receive.
 * ###########################################################################
 */
interface Refused {
  error?: string;
  detail?: string;
  message?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
}

export function createApi(store: Store) {
  let session: Session | null = store.get<Session>(SESSION_KEY);
  // Told when the SERVER ends the session -- a refused refresh -- so a screen
  // returns to sign-in instead of showing "not loaded" on every panel (FRONTEND
  // §8: a refused refresh is a re-authentication, not an error).
  const sessionEnded = new Set<() => void>();
  let device: DeviceIdentity | null = store.get<DeviceIdentity>(DEVICE_KEY);
  let refreshing: Promise<boolean> | null = null;

  const saveSession = (next: Session | null): void => {
    session = next;
    if (next) store.set(SESSION_KEY, next);
    else store.remove(SESSION_KEY);
  };

  async function raw(
    path: string,
    init: RequestInit & { readonly idempotencyKey?: string; readonly leaseToken?: string | null },
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    // Only when there IS a body. A JSON content-type with no body is refused by
    // Fastify's parser (FST_ERR_CTP_EMPTY_JSON_BODY), which is how a DELETE with
    // nothing to say became a 400 -- and, before that mapping existed, a 500.
    if (init.body !== undefined && init.body !== null) {
      headers.set('content-type', 'application/json');
    }
    if (session) headers.set('authorization', `Bearer ${session.accessToken}`);
    // Both come from the queue, never from a component: see queue.ts.
    if (init.idempotencyKey) headers.set('idempotency-key', init.idempotencyKey);
    if (init.leaseToken) headers.set('x-lease-token', init.leaseToken);

    try {
      return await fetch(path, { ...init, headers });
    } catch {
      // A network error is not a refusal. The distinction decides whether the
      // caller queues the work or tells the user it was rejected.
      throw new ApiError({ kind: 'offline' }, 'the server could not be reached');
    }
  }

  async function refresh(): Promise<boolean> {
    if (!session) return false;
    // One in flight at a time: a screen with four panels must not fire four.
    refreshing ??= (async () => {
      try {
        const response = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: session?.refreshToken }),
        });
        if (!response.ok) {
          saveSession(null);
          for (const listener of sessionEnded) listener();
          return false;
        }
        const body = (await response.json()) as { accessToken: string; refreshToken: string };
        if (session) {
          saveSession({ ...session, accessToken: body.accessToken, refreshToken: body.refreshToken });
        }
        return true;
      } catch {
        return false; // offline: keep the session, the next call will try again
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function request<T>(
    path: string,
    init: RequestInit & { idempotencyKey?: string; leaseToken?: string | null } = {},
    allowRefresh = true,
  ): Promise<T> {
    const response = await raw(path, init);

    if (response.status === 401 && allowRefresh && session) {
      // Exactly one attempt. A retry loop on 401 is how a client hammers an
      // auth endpoint it is never going to satisfy.
      if (await refresh()) return request<T>(path, init, false);
      throw new ApiError({ kind: 'signed-out' }, 'the shift ended; sign in again');
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Refused;
      throw new ApiError(
        {
          kind: 'refused',
          status: response.status,
          code: body.error ?? 'unknown',
          retryable: body.retryable ?? false,
          // A lockout says how long; the PIN keypad tells the person that, not "wrong PIN".
          ...(typeof body.retryAfterSeconds === 'number' ? { retryAfterSeconds: body.retryAfterSeconds } : {}),
        },
        // `detail` first, because it is the field the server fills. `message`
        // is Fastify's own, for the errors it generates before a handler runs.
        body.detail ?? body.message ?? body.error
          ?? `request refused with ${response.status}`,
      );
    }

    return (await response.json()) as T;
  }

  return {
    session: () => session,
    device: () => device,
    /**
     * Drop this browser's tablet identity, after the server said it has no live
     * tablet with this fingerprint (taken out of use, or from a database that no
     * longer exists). Keeping it would leave the PIN screen up forever, refusing
     * every PIN; forgetting it sends the page back to "Set up this tablet".
     */
    forgetDevice(): void {
      device = null;
      store.remove(DEVICE_KEY);
      saveSession(null);
    },
    signedIn: () => session !== null,

    /**
     * The restaurant's staff, for the Staff Login cards. A till sends its
     * fingerprint (its own branch); a browser that is not a till yet sends none
     * and gets the restaurant's one branch. `tablet_not_set_up` for a till that
     * was taken out of use, or a restaurant with several branches.
     */
    async tillStaff(tenantSlug: string): Promise<readonly { userId: string; fullName: string; hasPin?: boolean }[]> {
      const held = device !== null && device.tenantSlug === tenantSlug ? device : null;
      const body = await request<{ staff: { userId: string; fullName: string; hasPin?: boolean }[] }>(
        `/api/public/restaurants/${tenantSlug}/till/staff`,
        held === null ? {} : { headers: { 'x-device-fingerprint': held.fingerprint } },
      );
      return body.staff;
    },

    /**
     * Identified PIN sign-in: the person TAPPED their name, then typed the PIN.
     * The PIN only tells one known person apart; it is never a lookup key.
     */
    async signInWithPin(input: { tenantSlug: string; userId: string; pin: string }): Promise<Session> {
      // A browser that is not a till yet sends a fresh fingerprint and no branch;
      // the server makes it the till on a correct PIN, within the plan's limit,
      // and says which till it now is.
      const held = device !== null && device.tenantSlug === input.tenantSlug ? device : null;
      const fingerprint = held?.fingerprint ?? crypto.randomUUID();
      const body = await request<{
        accessToken: string; refreshToken: string; userId: string; deviceId: string; branchId: string;
      }>(
        `/api/auth/${input.tenantSlug}/pin`,
        {
          method: 'POST',
          body: JSON.stringify({
            userId: input.userId,
            pin: input.pin,
            deviceFingerprint: fingerprint,
            ...(held === null ? {} : { branchId: held.branchId }),
          }),
        },
      );
      if (held === null) {
        device = { tenantSlug: input.tenantSlug, deviceId: body.deviceId, branchId: body.branchId, fingerprint };
        store.set(DEVICE_KEY, device);
      }
      const next: Session = {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        tenantSlug: input.tenantSlug,
        branchId: body.branchId,
        // From the server's answer.
        userId: body.userId,
      };
      saveSession(next);
      return next;
    },

    /**
     * The restaurant's one login page. `lands` is the server's answer to where
     * this person goes: the manager screens, or the POS.
     */
    async signInWithPassword(input: {
      tenantSlug: string;
      email: string;
      password: string;
      /** 'manager': the server refuses a non-manager outright (`not_a_manager`). */
      audience?: 'manager';
    }): Promise<Session & { lands: 'admin' | 'pos' }> {
      const body = await request<{ accessToken: string; refreshToken: string; lands?: 'admin' | 'pos' }>(
        `/api/auth/${input.tenantSlug}/login`,
        { method: 'POST', body: JSON.stringify({
          login: input.email, password: input.password, ...(input.audience ? { audience: input.audience } : {}),
        }) },
      );
      const next: Session = {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        tenantSlug: input.tenantSlug,
        branchId: null,
        userId: 'self',
      };
      saveSession(next);
      return { ...next, lands: body.lands ?? 'admin' };
    },

    /**
     * The POS half of the restaurant's one login page: the same username (or
     * email) and password, and this browser's fingerprint, in ONE call
     * (`POST /api/auth/:slug/till`). The answer is a session narrowed to the
     * till's branch and this browser. A browser that is not a till yet becomes
     * one there, for whoever the server says may make it one; the fingerprint is
     * kept across a till taken out of use, so setting it up again is the same
     * browser, not a second one.
     */
    async setUpTill(input: { tenantSlug: string; email: string; password: string; deviceName: string }): Promise<{
      device: DeviceIdentity; session: Session | null;
    }> {
      const held = device !== null && device.tenantSlug === input.tenantSlug ? device : null;
      const fingerprint = held?.fingerprint ?? crypto.randomUUID();
      // A manager's credentials register (or confirm) the till and open NO POS
      // session -- managers sign in on the Manager Login page; staff use the PIN.
      const answer = await request<{
        accessToken?: string; refreshToken?: string; userId?: string; deviceId: string; branchId: string;
      }>(
        `/api/auth/${input.tenantSlug}/till`,
        { method: 'POST', body: JSON.stringify({
          login: input.email, password: input.password, deviceFingerprint: fingerprint, deviceName: input.deviceName,
        }) },
      );
      device = { tenantSlug: input.tenantSlug, deviceId: answer.deviceId, branchId: answer.branchId, fingerprint };
      store.set(DEVICE_KEY, device);
      if (answer.accessToken === undefined || answer.refreshToken === undefined || answer.userId === undefined) {
        return { device, session: null };
      }
      const next: Session = {
        accessToken: answer.accessToken, refreshToken: answer.refreshToken,
        tenantSlug: input.tenantSlug, branchId: answer.branchId, userId: answer.userId,
      };
      saveSession(next);
      return { device, session: next };
    },

    signOut(): void {
      saveSession(null);
    },

    /** Subscribe to the server ending the session; returns the unsubscribe. */
    onSessionEnded(listener: () => void): () => void {
      sessionEnded.add(listener);
      return () => { sessionEnded.delete(listener); };
    },

    get<T>(path: string): Promise<T> {
      return request<T>(`/api/t${path}`);
    },

    /**
     * Consensus operations only, and they never render optimistically. Local
     * operations go through the queue, which is what owns their idempotency key.
     */
    mutate<T>(
      path: string,
      body: unknown,
      keys: { idempotencyKey: string; leaseToken: string | null },
    ): Promise<T> {
      return request<T>(`/api/t${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
        idempotencyKey: keys.idempotencyKey,
        leaseToken: keys.leaseToken,
      });
    },

    /**
     * A POST with no idempotency key. Kept as a distinct name because callers
     * depend on it; the refusal sentence is no longer special -- `request` keeps
     * it for every caller now, which is what this pair existed to work around.
     *
     * No lease token: the two callers -- the kitchen recall and the admin create
     * -- are not session-leased routes. The idempotency key is minted per
     * attempt because both are guarded by a real constraint rather than by the
     * key (one recall per ticket; a unique code or key per tenant), so a
     * duplicate is refused by the schema and named as such.
     */
    postDetailed<T>(path: string, body: unknown): Promise<T> {
      return request<T>(`/api/t${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
        idempotencyKey: crypto.randomUUID(),
      });
    },

    /**
     * A partial edit. As above: the sentence is no longer special.
     *
     * The admin table's own doctrine is that `fields_not_writable` is shown
     * VERBATIM, because the server's sentence names the fields the route does
     * accept. Through `patch` below that sentence never arrives -- the screen
     * shows the string `fields_not_writable` instead -- so the edit path uses
     * this one.
     */
    patchDetailed<T>(path: string, body: unknown): Promise<T> {
      return request<T>(`/api/t${path}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        idempotencyKey: crypto.randomUUID(),
      });
    },

    /**
     * A partial edit. PATCH rather than POST, and the body is only what changed:
     * the admin routes refuse a field they do not declare writable, and they
     * refuse the WHOLE request, so sending every column would lose the one change
     * the caller wanted.
     */
    patch<T>(path: string, body: unknown): Promise<T> {
      return request<T>(`/api/t${path}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        idempotencyKey: crypto.randomUUID(),
      });
    },

    /**
     * DELETE with no body, deliberately: a JSON content-type with an empty body
     * is its own refusal (FST_ERR_CTP_EMPTY_JSON_BODY), and the admin DELETE
     * takes no arguments -- what it does is declared server-side per resource.
     */
    remove<T>(path: string): Promise<T> {
      return request<T>(`/api/t${path}`, {
        method: 'DELETE',
        idempotencyKey: crypto.randomUUID(),
      });
    },

    /**
     * What the PUMP uses, and the only reason it differs from `mutate` is the
     * method: a queued operation carries its own verb, and the key and lease
     * token come from the queue rather than being minted here.
     */
    send<T>(
      method: 'POST' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      keys: { idempotencyKey: string; leaseToken: string | null },
    ): Promise<T> {
      return request<T>(`/api/t${path}`, {
        method,
        body: body === undefined ? null : JSON.stringify(body),
        idempotencyKey: keys.idempotencyKey,
        leaseToken: keys.leaseToken,
      });
    },
  };
}

export type Api = ReturnType<typeof createApi>;
