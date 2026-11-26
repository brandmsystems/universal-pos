import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertCheckedSet } from '../helpers/db.js';
import { REQUIREMENTS, probeHost, type ProbeResult } from '../../../../scripts/probe-host.mjs';

/**
 * ###########################################################################
 * A PROBE NOBODY HAS RUN IS A HYPOTHESIS.
 *
 * That is the lesson of the partition-recovery runbook, which had never been
 * executed and failed on its second step. `probe-host` exists to be pointed at a
 * candidate host BEFORE a hosting decision, so it has to be exercised here --
 * against a database that satisfies every requirement, and then against
 * deliberately broken preconditions so each check is proven to notice.
 *
 * What this file CANNOT prove is the part a real pooler decides. Here `--pooled`
 * and `--direct` are the same endpoint, so `listen-on-direct-connection` and
 * `session-advisory-locks` pass trivially -- they exist to fail against a
 * transaction-mode pooler, and `docker compose --profile probe` is where that is
 * exercised. The CLI says so out loud when the two urls match, rather than
 * reporting a clean bill of health it has not earned.
 * ###########################################################################
 */

let owner: pg.Client;
let urls: { pooled: string; direct: string };

function byId(results: readonly ProbeResult[], id: string): ProbeResult {
  const found = results.find((r) => r.id === id);
  if (!found) throw new Error(`no probe result for ${id}`);
  return found;
}

beforeAll(async () => {
  urls = {
    pooled: process.env['DATABASE_URL_APP']!,
    direct: process.env['DATABASE_URL_OWNER']!,
  };
  owner = new pg.Client({ connectionString: urls.direct });
  await owner.connect();
});

afterAll(async () => {
  await owner?.end();
});

describe('the host probe covers what a hosting decision turns on', () => {
  it('states every requirement, on a named connection, with a reason', () => {
    assertCheckedSet({
      label: 'host requirements',
      checked: REQUIREMENTS.map((r) => r.id),
      minimum: 7,
      mustInclude: [
        'three-roles',
        'no-rls-bypassing-roles',
        'listen-on-direct-connection',
        'session-advisory-locks',
        'transaction-scoped-pooling-and-app-posture',
      ],
    });

    // A requirement with no reason is one nobody can evaluate a host against.
    for (const requirement of REQUIREMENTS) {
      expect(requirement.why.length, `${requirement.id} has no reason`).toBeGreaterThan(40);
      expect(['pooled', 'direct']).toContain(requirement.on);
    }
  });

  it('passes against this database, which satisfies all of them', async () => {
    const results = await probeHost(urls);
    const failed = results.filter((r) => !r.ok);
    expect(
      failed.map((r) => `${r.id}: ${r.detail}`),
      'the migrated test database should meet every requirement',
    ).toEqual([]);
    expect(results.length).toBe(REQUIREMENTS.length);
  });
});

describe('each check is proven to notice its own precondition failing', () => {
  /**
   * ###########################################################################
   * THE ROLE CHECKS ARE DRIVEN WITH A STUB, NOT BY MUTATING REAL ROLES.
   *
   * `katkitchen_owner` is deliberately NOCREATEROLE, so renaming a role or
   * granting BYPASSRLS needs a superuser -- and reaching for one to make a test
   * convenient would exercise a posture nobody deploys. The fact that the real
   * roles exist and do not bypass RLS is already proven by the passing run
   * above; what is proven here is that the CHECK notices when they do not.
   * ###########################################################################
   */
  function clientReturning(rows: readonly Record<string, unknown>[]): pg.Client {
    return { query: async () => ({ rows: [...rows] }) } as unknown as pg.Client;
  }

  function check(id: string): (client: pg.Client) => Promise<void> {
    const requirement = REQUIREMENTS.find((r) => r.id === id);
    if (!requirement) throw new Error(`no requirement ${id}`);
    return requirement.check;
  }

  it('notices a missing role', async () => {
    // The role list is what separates DDL from request-serving from
    // control-plane reads. A host that cannot create them fails here.
    await expect(
      check('three-roles')(clientReturning([
        { rolname: 'katkitchen_owner' },
        { rolname: 'katkitchen_app' },
      ])),
    ).rejects.toThrow('katkitchen_platform_readonly');

    // Non-vacuous: the same check passes when all three are present.
    await expect(
      check('three-roles')(clientReturning([
        { rolname: 'katkitchen_owner' },
        { rolname: 'katkitchen_app' },
        { rolname: 'katkitchen_platform_readonly' },
      ])),
    ).resolves.toBeUndefined();
  });

  it('notices a role that can bypass RLS, by either route', async () => {
    // The failure this exists for is a managed host that will only give you an
    // administrative role with BYPASSRLS, or one that is superuser outright.
    const clean = [
      { rolname: 'katkitchen_owner', rolsuper: false, rolbypassrls: false },
      { rolname: 'katkitchen_app', rolsuper: false, rolbypassrls: false },
      { rolname: 'katkitchen_platform_readonly', rolsuper: false, rolbypassrls: false },
    ];

    await expect(
      check('no-rls-bypassing-roles')(clientReturning(
        clean.map((r) => (r.rolname === 'katkitchen_app' ? { ...r, rolbypassrls: true } : r)),
      )),
    ).rejects.toThrow('BYPASSRLS');

    await expect(
      check('no-rls-bypassing-roles')(clientReturning(
        clean.map((r) => (r.rolname === 'katkitchen_owner' ? { ...r, rolsuper: true } : r)),
      )),
    ).rejects.toThrow('SUPERUSER');

    await expect(
      check('no-rls-bypassing-roles')(clientReturning(clean)),
    ).resolves.toBeUndefined();
  });

  it('notices a database that is not on UTC', async () => {
    const { rows } = await owner.query<{ d: string }>('SELECT current_database() AS d');
    const database = rows[0]!.d;
    await owner.query(`ALTER DATABASE ${database} SET timezone = 'Asia/Kolkata'`);
    try {
      const results = await probeHost(urls);
      const result = byId(results, 'database-timezone-utc');
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('Asia/Kolkata');
    } finally {
      await owner.query(`ALTER DATABASE ${database} SET timezone = 'UTC'`);
    }
  });

  it('reports an unreachable host as failed requirements rather than throwing', async () => {
    // Comparing two candidate hosts is the use case; a stack trace is not a
    // comparison, and one refused endpoint must not lose the other's results.
    const results = await probeHost({
      pooled: urls.pooled,
      direct: 'postgresql://nobody@127.0.0.1:1/nothing',
    });
    expect(results.length).toBe(REQUIREMENTS.length);
    const direct = results.filter((r) => r.on === 'direct');
    expect(direct.every((r) => !r.ok)).toBe(true);
    expect(direct[0]!.detail).toContain('could not connect');
    // And the pooled half still reported, which is the point.
    expect(results.filter((r) => r.on === 'pooled').every((r) => r.ok)).toBe(true);
  });
});
