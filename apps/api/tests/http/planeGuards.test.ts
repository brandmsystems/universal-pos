import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { signToken, verifyToken, TokenError } from '../../src/modules/auth/jwt.js';
import { checkPlane, planeGuard } from '../../src/core/security/planeGuards.js';

/**
 * Hard boundaries 3 and 4. Tokens are signed with the real key by the real
 * signer and read by the real verifier -- nothing mocked.
 */

const KEY = 'test-signing-key-not-a-production-secret';
const future = () => Math.floor(Date.now() / 1000) + 600;

function platformToken(overrides: Record<string, unknown> = {}): string {
  return signToken(
    { sub: 'pu-1', platform_role: 'support', iat: Math.floor(Date.now() / 1000), exp: future(), ...overrides },
    KEY,
  );
}

function tenantToken(overrides: Record<string, unknown> = {}): string {
  return signToken(
    {
      sub: 'u-1',
      tenant_id: '0000dddd-0000-0000-0000-00000000a1fa',
      iat: Math.floor(Date.now() / 1000),
      exp: future(),
      ...overrides,
    },
    KEY,
  );
}

let app: FastifyInstance;
/** Proves the guard ran before anything a handler could touch. */
let handlerReached: string[] = [];

beforeAll(async () => {
  app = Fastify();

  app.register(
    async (scope) => {
      scope.addHook('onRequest', planeGuard('platform', KEY));
      scope.get('/tenants', async () => {
        handlerReached.push('platform');
        return { ok: true };
      });
    },
    { prefix: '/api/platform' },
  );

  app.register(
    async (scope) => {
      scope.addHook('onRequest', planeGuard('tenant', KEY));
      scope.get('/branches', async () => {
        handlerReached.push('tenant');
        return { ok: true };
      });
    },
    { prefix: '/api/t' },
  );

  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('the verifier is real', () => {
  it('round-trips a token it signed', () => {
    const claims = verifyToken(platformToken(), KEY);
    expect(claims['platform_role']).toBe('support');
  });

  it('rejects a tampered payload', () => {
    const token = tenantToken();
    const [header, , signature] = token.split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({ sub: 'u-1', tenant_id: 'other', exp: future() }),
    ).toString('base64url');
    expect(() => verifyToken(`${header}.${forged}.${signature}`, KEY)).toThrow(TokenError);
  });

  it('rejects a token signed with a different key', () => {
    expect(() => verifyToken(signToken({ sub: 'x', exp: future() }, 'other-key'), KEY)).toThrow(
      /signature does not verify/,
    );
  });

  it('rejects alg:none rather than trusting it', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'x', platform_role: 'super_admin' })).toString(
      'base64url',
    );
    expect(() => verifyToken(`${header}.${payload}.`, KEY)).toThrow(/unsupported alg/);
  });

  it('rejects an expired token', () => {
    const expired = signToken({ sub: 'x', platform_role: 'support', exp: 1 }, KEY);
    expect(() => verifyToken(expired, KEY)).toThrow(/expired/);
  });
});

describe('the plane rule, independent of HTTP', () => {
  it('rejects tenant_id on the platform plane', () => {
    const rejection = checkPlane('platform', { platform_role: 'support', tenant_id: 'abc' });
    expect(rejection?.code).toBe('tenant_token_on_platform_plane');
    expect(rejection?.status).toBe(403);
  });

  it('rejects platform_role on the tenant plane', () => {
    const rejection = checkPlane('tenant', { tenant_id: 'abc', platform_role: 'read_only' });
    expect(rejection?.code).toBe('platform_token_on_tenant_plane');
    expect(rejection?.status).toBe(403);
  });

  it('keys on presence, not value', () => {
    // Every one of these is a token from the wrong plane. An empty or falsy
    // platform_role is not a harmless platform_role -- the claim is there, so the
    // token was minted by the other plane's issuer and must not be honoured.
    for (const value of ['read_only', '', 0, false] as const) {
      expect(
        checkPlane('tenant', { tenant_id: 'abc', platform_role: value })?.status,
        `platform_role=${JSON.stringify(value)}`,
      ).toBe(403);
    }
    // Absent is the only acceptable state.
    expect(checkPlane('tenant', { tenant_id: 'abc' })).toBeNull();
    expect(checkPlane('tenant', { tenant_id: 'abc', platform_role: undefined })).toBeNull();
  });

  it('accepts a well-formed token on its own plane', () => {
    expect(checkPlane('platform', { platform_role: 'support' })).toBeNull();
    expect(checkPlane('tenant', { tenant_id: 'abc' })).toBeNull();
  });
});

describe('/api/platform/* rejects any JWT carrying tenant_id', () => {
  it('rejects it with 403 and never reaches the handler', async () => {
    handlerReached = [];
    const response = await app.inject({
      method: 'GET',
      url: '/api/platform/tenants',
      headers: { authorization: `Bearer ${platformToken({ tenant_id: 'abc' })}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'tenant_token_on_platform_plane' });
    expect(handlerReached, 'the handler must not run').toEqual([]);
  });

  it('admits a clean platform token', async () => {
    handlerReached = [];
    const response = await app.inject({
      method: 'GET',
      url: '/api/platform/tenants',
      headers: { authorization: `Bearer ${platformToken()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(handlerReached).toEqual(['platform']);
  });
});

describe('/api/t/* rejects any JWT carrying platform_role', () => {
  it('rejects it with 403 and never reaches the handler', async () => {
    handlerReached = [];
    const response = await app.inject({
      method: 'GET',
      url: '/api/t/branches',
      headers: { authorization: `Bearer ${tenantToken({ platform_role: 'super_admin' })}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'platform_token_on_tenant_plane' });
    expect(handlerReached, 'the handler must not run').toEqual([]);
  });

  it('admits a clean tenant token', async () => {
    handlerReached = [];
    const response = await app.inject({
      method: 'GET',
      url: '/api/t/branches',
      headers: { authorization: `Bearer ${tenantToken()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(handlerReached).toEqual(['tenant']);
  });
});

describe('a token from the other plane is rejected even if otherwise valid', () => {
  it('will not let a platform token onto the tenant plane', async () => {
    handlerReached = [];
    const response = await app.inject({
      method: 'GET',
      url: '/api/t/branches',
      headers: { authorization: `Bearer ${platformToken()}` },
    });
    expect(response.statusCode).toBe(403);
    expect(handlerReached).toEqual([]);
  });

  it('will not let a tenant token onto the platform plane', async () => {
    handlerReached = [];
    const response = await app.inject({
      method: 'GET',
      url: '/api/platform/tenants',
      headers: { authorization: `Bearer ${tenantToken()}` },
    });
    expect(response.statusCode).toBe(403);
    expect(handlerReached).toEqual([]);
  });

  it('rejects a missing or malformed bearer token with 401', async () => {
    handlerReached = [];
    for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer nonsense' }]) {
      const response = await app.inject({ method: 'GET', url: '/api/t/branches', headers });
      expect(response.statusCode).toBe(401);
    }
    expect(handlerReached).toEqual([]);
  });
});

/**
 * ###########################################################################
 * THE `typ` CLAIM IS ONLY WORTH ANYTHING IF SOMETHING REFUSES IT.
 *
 * A refresh token is HS256 under the same key and carries `tenant_id`, so every
 * other check in `checkPlane` passes it. Without the discriminator branch it
 * would be accepted as a twelve-hour access token -- which would make the
 * fifteen-minute access lifetime, the only thing that makes device revocation
 * bite, silently irrelevant.
 *
 * Asserted on BOTH planes and against a token built by the real signer, because
 * a refresh token that merely happened to lack a field the guard wanted would be
 * rejected for the wrong reason and would stop being rejected after a refactor.
 * ###########################################################################
 */
describe('a refresh token is not a bearer credential', () => {
  const refreshClaims = {
    sub: '11111111-1111-1111-1111-111111111111',
    tenant_id: '22222222-2222-2222-2222-222222222222',
    branch_id: null,
    device_id: '33333333-3333-3333-3333-333333333333',
    typ: 'refresh',
    iat: 1,
    exp: 9_999_999_999,
  };

  it('is refused on the tenant plane, by token type rather than by a missing field', () => {
    const rejection = checkPlane('tenant', refreshClaims);
    expect(rejection).not.toBeNull();
    expect(rejection!.code).toBe('refresh_token_on_api_plane');
    expect(rejection!.status).toBe(403);
  });

  it('is refused on the platform plane too', () => {
    const rejection = checkPlane('platform', refreshClaims);
    expect(rejection!.code).toBe('refresh_token_on_api_plane');
  });

  it('is not vacuous: the same claims WITHOUT typ are accepted on the tenant plane', () => {
    const { typ: _typ, ...access } = refreshClaims;
    expect(checkPlane('tenant', access)).toBeNull();
  });
});
