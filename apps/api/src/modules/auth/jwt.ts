import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HS256, implemented directly rather than pulled in, so the verifier the tests
 * exercise is the verifier that runs in production -- nothing mocked, no library
 * defaults to be surprised by.
 *
 * Issuance (login) is Phase 1. Phase 0 needs the verifier and the plane guards;
 * tests sign with the real key and the real signer.
 */

export interface PlatformClaims {
  readonly sub: string;
  readonly platform_role: string;
  readonly exp: number;
  readonly iat: number;
  readonly tenant_id?: never;
}

export interface TenantClaims {
  readonly sub: string;
  readonly tenant_id: string;
  readonly branch_id?: string | null;
  readonly exp: number;
  readonly iat: number;
  readonly via_impersonation?: boolean;
  readonly platform_role?: never;
}

export type Claims = Record<string, unknown>;

export class TokenError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'malformed'
      | 'bad_signature'
      | 'expired'
      | 'unsupported_alg'
      | 'not_yet_valid',
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(input: string, key: string): string {
  return createHmac('sha256', key).update(input).digest('base64url');
}

export function signToken(claims: Claims, key: string): string {
  // alg is pinned at verification too; a token asking for "none" is rejected
  // rather than trusted.
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  return `${header}.${payload}.${sign(`${header}.${payload}`, key)}`;
}

export function verifyToken(token: string, key: string, now = Date.now()): Claims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('token is not three segments', 'malformed');
  const [header, payload, signature] = parts as [string, string, string];

  let decodedHeader: { alg?: unknown };
  try {
    decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('token header is not JSON', 'malformed');
  }
  if (decodedHeader.alg !== 'HS256') {
    throw new TokenError(`unsupported alg ${String(decodedHeader.alg)}`, 'unsupported_alg');
  }

  const expected = sign(`${header}.${payload}`, key);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new TokenError('signature does not verify', 'bad_signature');
  }

  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
  } catch {
    throw new TokenError('token payload is not JSON', 'malformed');
  }

  const seconds = Math.floor(now / 1000);
  if (typeof claims['exp'] === 'number' && claims['exp'] <= seconds) {
    throw new TokenError('token has expired', 'expired');
  }
  if (typeof claims['nbf'] === 'number' && claims['nbf'] > seconds) {
    throw new TokenError('token is not yet valid', 'not_yet_valid');
  }

  return claims;
}
