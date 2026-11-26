import { createStore, type Store } from './storage.js';

/**
 * The control plane's API client.
 *
 * ###########################################################################
 * A SEPARATE CLIENT FROM `shared/api.ts`, AND THE SEPARATION IS THE POINT.
 *
 * `shared/api.ts` is built around a TENANT session: its `Session` carries a
 * tenant slug, a branch and an app-user id, its refresh path posts to
 * `/api/auth/refresh`, and its offline queue exists because a tablet on a
 * restaurant floor loses its network mid-service. None of that is true here. A
 * control-plane session has no tenant by definition, refreshes on its own route,
 * and is used from an office on a wired connection -- a support engineer who
 * loses the network should see that plainly, not have their action queued and
 * replayed against a customer's live data minutes later.
 *
 * Widening the shared client to cover both would put both planes' session rules
 * in one file, which is the boundary this product enforces everywhere else. So
 * this is a second client, and it is deliberately the smaller one.
 * ###########################################################################
 */

export interface PlatformSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly platformUserId: string;
  /** The role key the server reported. Renders navigation; never authorises. */
  readonly role: string;
}

const SESSION_KEY = 'platform.session.v1';

export type PlatformFailure =
  | { readonly kind: 'refused'; readonly status: number; readonly code: string }
  | { readonly kind: 'offline' }
  | { readonly kind: 'signed-out' };

export class PlatformApiError extends Error {
  constructor(readonly failure: PlatformFailure, message: string) {
    super(message);
    this.name = 'PlatformApiError';
  }
}

export interface PlatformApi {
  session(): PlatformSession | null;
  signedIn(): boolean;
  signIn(input: { email: string; password: string }): Promise<PlatformSession>;
  signOut(): void;
  /** Verified like a login: the current password must be right. */
  changePassword(input: { email: string; currentPassword: string; newPassword: string }): Promise<void>;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
}

export function createPlatformApi(store: Store = createStore()): PlatformApi {
  let session: PlatformSession | null = store.get<PlatformSession>(SESSION_KEY);
  let refreshing: Promise<boolean> | null = null;

  const save = (next: PlatformSession | null): void => {
    session = next;
    if (next) store.set(SESSION_KEY, next);
    else store.remove(SESSION_KEY);
  };

  /**
   * One refresh in flight at a time.
   *
   * Without the shared promise, a screen firing four reads on mount turns one
   * expired token into four refreshes, three of which race and lose. The tenant
   * client learned this first; the shape is copied deliberately rather than
   * rediscovered.
   */
  async function refresh(): Promise<boolean> {
    if (!session) return false;
    refreshing ??= (async () => {
      try {
        const response = await fetch('/api/auth/platform/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: session?.refreshToken }),
        });
        if (!response.ok) {
          // A refused refresh is a dead session: the account was suspended, the
          // role was revoked, or twelve hours passed. Keeping it would leave a
          // console that looks signed in and fails every read.
          save(null);
          return false;
        }
        const body = await response.json() as {
          accessToken: string; refreshToken: string; role: string;
        };
        if (session) {
          save({ ...session, accessToken: body.accessToken,
                 refreshToken: body.refreshToken, role: body.role });
        }
        return true;
      } catch {
        // Offline. The session is still valid; the next call tries again.
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function call<T>(
    method: string, path: string, body?: unknown,
    extra: Record<string, string> = {}, allowRefresh = true,
  ): Promise<T> {
    if (!session) throw new PlatformApiError({ kind: 'signed-out' }, 'not signed in');

    let response: Response;
    try {
      response = await fetch(`/api/platform${path}`, {
        method,
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new PlatformApiError({ kind: 'offline' }, 'the server could not be reached');
    }

    if (response.status === 401 && allowRefresh) {
      if (await refresh()) return call<T>(method, path, body, extra, false);
      throw new PlatformApiError({ kind: 'signed-out' }, 'the session ended');
    }

    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as
        { error?: string; detail?: string };
      throw new PlatformApiError(
        { kind: 'refused', status: response.status, code: failure.error ?? 'unknown' },
        // The server's own sentence where it sent one. `detail` carries the
        // refusal a human can act on; the code is the half that does not help.
        failure.detail ?? failure.error ?? `${response.status}`,
      );
    }

    return response.status === 204 ? (undefined as T) : (await response.json()) as T;
  }

  return {
    session: () => session,
    signedIn: () => session !== null,

    async signIn(input) {
      let response: Response;
      try {
        response = await fetch('/api/auth/platform/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
      } catch {
        throw new PlatformApiError({ kind: 'offline' }, 'the server could not be reached');
      }
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { error?: string };
        throw new PlatformApiError(
          { kind: 'refused', status: response.status, code: failure.error ?? 'unknown' },
          'that sign-in was not accepted',
        );
      }
      const body = await response.json() as {
        accessToken: string; refreshToken: string; role: string;
      };
      // The subject comes from the TOKEN the server signed, not from anything
      // typed. The tenant client made the opposite mistake once and it is
      // recorded in phase 12: the signed-in user's id was taken from the form.
      const next: PlatformSession = {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        platformUserId: subjectOf(body.accessToken),
        role: body.role,
      };
      save(next);
      return next;
    },

    signOut: () => save(null),

    async changePassword(input) {
      let response: Response;
      try {
        response = await fetch('/api/auth/platform/password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
      } catch {
        throw new PlatformApiError({ kind: 'offline' }, 'the server could not be reached');
      }
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as
          { error?: string; detail?: string; retryAfterSeconds?: number };
        throw new PlatformApiError(
          { kind: 'refused', status: response.status, code: failure.error ?? 'unknown' },
          failure.detail
            ?? (failure.retryAfterSeconds !== undefined
              ? `too many wrong attempts; try again in ${failure.retryAfterSeconds} seconds`
              : 'the current password was not accepted'),
        );
      }
    },

    get: <T,>(path: string) => call<T>('GET', path),
    post: <T,>(path: string, body: unknown, headers?: Record<string, string>) =>
      call<T>('POST', path, body, headers ?? {}),
    patch: <T,>(path: string, body: unknown) => call<T>('PATCH', path, body),
    del: <T,>(path: string) => call<T>('DELETE', path),
  };
}

/**
 * The `sub` claim, read without verifying.
 *
 * Reading a token the client cannot verify is acceptable for exactly one thing:
 * displaying which account is signed in. It is NOT a security decision -- every
 * authorisation happens at the server, which does verify. Stated because an
 * unverified read that later grew into a permission check is a plausible way for
 * this to go wrong.
 */
function subjectOf(accessToken: string): string {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return '';
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return (JSON.parse(json) as { sub?: string }).sub ?? '';
  } catch {
    return '';
  }
}
