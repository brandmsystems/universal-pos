import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import { withTenantTransaction, InvalidTenantIdError } from '../../src/core/database/unitOfWork.js';
import { MissingTenantContextError, peekTenantContext } from '../../src/core/database/tenantContext.js';
import { TenantIdInPayloadError, UnscopedMutationError } from '../../src/core/database/baseRepository.js';
import { BranchRepository, AppUserRepository } from '../../src/core/database/repositories.js';
import { assertDatabaseSafety } from '../../src/core/database/startupChecks.js';

/**
 * Tenant isolation. The non-negotiable suite.
 *
 * The most valuable assertion here is not "a cross-tenant read is blocked" -- it
 * is "a query with no tenant context fails loudly". A blocked read is the obvious
 * case; a silently empty result is the one that ships and is believed.
 */

let owner: pg.Client;
let pool: pg.Pool;

const ALPHA = '0000dddd-0000-0000-0000-00000000a1fa';
const BETA = '0000dddd-0000-0000-0000-00000000be7a';

const branches = new BranchRepository();
const users = new AppUserRepository();

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();

  const connectionString = process.env['DATABASE_URL_APP'];
  if (!connectionString) throw new Error('DATABASE_URL_APP is not set');
  pool = new pg.Pool({ connectionString, max: 4 });

  for (const [id, slug] of [
    [ALPHA, 'iso-alpha'],
    [BETA, 'iso-beta'],
  ] as const) {
    await owner.query(`DELETE FROM app.branch WHERE tenant_id = $1`, [id]);
    await owner.query(`DELETE FROM app.app_user WHERE tenant_id = $1`, [id]);
    // UPSERT the tenant; never delete it. Deleting means enumerating everything
    // that references it, and that list grows with every platform table -- it
    // broke on usage_counter. Production never deletes a tenant either: the
    // ladder anonymises. The tenant row carries no state this suite asserts on.
    await owner.query(
      `INSERT INTO platform.tenant (id, slug, name, default_currency, tax_jurisdiction)
       VALUES ($1, $2, $3, 'INR', 'IN') ON CONFLICT (id) DO NOTHING`,
      [id, slug, slug],
    );
    await owner.query(
      `INSERT INTO app.branch (id, tenant_id, code, name, timezone, gst_registration)
       VALUES ($1, $2, 'MAIN', $3, 'Asia/Kolkata', 'unstated')`,
      [randomUUID(), id, `${slug} main`],
    );
  }
});

afterAll(async () => {
  await pool?.end();
  await owner?.end();
});

describe('a query with no tenant context fails loudly', () => {
  it('refuses at the repository before any SQL is issued', async () => {
    expect(peekTenantContext()).toBeNull();
    // Not zero rows. Not an empty array. A thrown error naming the operation.
    await expect(branches.findMany()).rejects.toThrow(MissingTenantContextError);
    await expect(branches.findMany()).rejects.toThrow(/no tenant context/i);
  });

  it('refuses every mutating method too', async () => {
    await expect(branches.insert({ code: 'X', name: 'X', timezone: 'UTC' })).rejects.toThrow(
      MissingTenantContextError,
    );
    await expect(branches.update({ code: 'MAIN' }, { name: 'X' })).rejects.toThrow(
      MissingTenantContextError,
    );
    await expect(branches.delete({ code: 'MAIN' })).rejects.toThrow(MissingTenantContextError);
    await expect(branches.count()).rejects.toThrow(MissingTenantContextError);
  });

  it('raises at the database too, so the repository is not the only guard', async () => {
    const client = await pool.connect();
    try {
      // No GUC set: RLS must raise 28000, never filter to an empty result.
      await expect(client.query('SELECT * FROM app.branch')).rejects.toThrow(
        /app\.tenant_id is not set/i,
      );
    } finally {
      client.release();
    }
  });

  it('refuses a tenant id that is not a uuid, before opening a transaction', async () => {
    await expect(
      withTenantTransaction(pool, "' OR 1=1 --", async () => undefined),
    ).rejects.toThrow(InvalidTenantIdError);
  });
});

describe('cross-tenant access is blocked', () => {
  it('reads only its own rows', async () => {
    const alpha = await withTenantTransaction(pool, ALPHA, () => branches.findMany());
    const beta = await withTenantTransaction(pool, BETA, () => branches.findMany());

    expect(alpha).toHaveLength(1);
    expect(beta).toHaveLength(1);
    expect(alpha[0]?.tenant_id).toBe(ALPHA);
    expect(beta[0]?.tenant_id).toBe(BETA);
    expect(alpha[0]?.id).not.toBe(beta[0]?.id);
  });

  it('cannot reach another tenant by naming its id in the predicate', async () => {
    const betaBranch = await withTenantTransaction(pool, BETA, () => branches.findMany());
    const target = betaBranch[0]!;

    // The predicate is ANDed with tenant_id, so asking for beta's row by id from
    // inside alpha's context returns nothing rather than leaking it.
    const leaked = await withTenantTransaction(pool, ALPHA, () =>
      branches.findOne({ id: target.id }),
    );
    expect(leaked).toBeNull();
  });

  it('cannot write into another tenant', async () => {
    await expect(
      withTenantTransaction(pool, ALPHA, async () => {
        // Even with the right shape, WITH CHECK stops the row landing in beta.
        const context = peekTenantContext()!;
        await context.client.query(
          `INSERT INTO app.branch (id, tenant_id, code, name, timezone, gst_registration)
           VALUES ($1, $2, 'SNEAK', 'Sneak', 'UTC', 'unstated')`,
          [randomUUID(), BETA],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot update a row out of its tenant', async () => {
    await expect(
      withTenantTransaction(pool, ALPHA, async () => {
        const context = peekTenantContext()!;
        await context.client.query(`UPDATE app.branch SET tenant_id = $1`, [BETA]);
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('the repository injects tenant_id and refuses to take it', () => {
  it('stamps the context tenant on every insert', async () => {
    await withTenantTransaction(
      pool,
      ALPHA,
      async () => {
        const row = await users.insert({
          id: randomUUID(),
          full_name: 'Injected',
          employee_code: 'INJ-1',
          status: 'invited',
        });
        expect(row.tenant_id).toBe(ALPHA);
      },
      { rollback: true },
    );
  });

  it('throws if a caller supplies tenant_id, rather than ignoring it', async () => {
    await withTenantTransaction(
      pool,
      ALPHA,
      async () => {
        await expect(
          users.insert({ id: randomUUID(), full_name: 'X', employee_code: 'X', tenant_id: BETA }),
        ).rejects.toThrow(TenantIdInPayloadError);

        await expect(users.findMany({ tenant_id: BETA })).rejects.toThrow(TenantIdInPayloadError);
        await expect(users.update({ employee_code: 'X' }, { tenant_id: BETA })).rejects.toThrow(
          TenantIdInPayloadError,
        );
      },
      { rollback: true },
    );
  });

  it('refuses an unscoped update or delete', async () => {
    await withTenantTransaction(
      pool,
      ALPHA,
      async () => {
        await expect(branches.update({}, { name: 'all of them' })).rejects.toThrow(
          UnscopedMutationError,
        );
        await expect(branches.delete({})).rejects.toThrow(UnscopedMutationError);
      },
      { rollback: true },
    );
  });

  it('rejects an unsafe identifier instead of interpolating it', async () => {
    await withTenantTransaction(
      pool,
      ALPHA,
      async () => {
        await expect(branches.findMany({ 'name; DROP TABLE app.branch': 'x' })).rejects.toThrow(
          /unsafe SQL identifier/i,
        );
      },
      { rollback: true },
    );
  });
});

describe('the transaction carries the context', () => {
  it('does not leak the GUC to the next transaction on the same connection', async () => {
    const single = new pg.Pool({ connectionString: process.env['DATABASE_URL_APP']!, max: 1 });
    try {
      await withTenantTransaction(single, ALPHA, () => branches.findMany());
      const client = await single.connect();
      try {
        await expect(client.query('SELECT * FROM app.branch')).rejects.toThrow(
          /app\.tenant_id is not set/i,
        );
      } finally {
        client.release();
      }
    } finally {
      await single.end();
    }
  });

  it('rolls back the whole unit of work on failure', async () => {
    const before = await withTenantTransaction(pool, ALPHA, () => branches.count());

    await expect(
      withTenantTransaction(pool, ALPHA, async () => {
        await branches.insert({ id: randomUUID(), code: 'TMP', name: 'Temp', timezone: 'UTC',
          // Required since 0048: the GST question has no default answer, so
          // every writer names a value. This fixture is about the ROLLBACK, and
          // an insert refused by a not-null constraint would make the test pass
          // for the wrong reason -- the transaction would abort before the
          // deliberate failure ever ran.
          gst_registration: 'unstated' });
        throw new Error('deliberate failure after a write');
      }),
    ).rejects.toThrow('deliberate failure');

    const after = await withTenantTransaction(pool, ALPHA, () => branches.count());
    expect(after).toBe(before);
  });

  it('passes the startup safety probes on the application pool', async () => {
    const client = await pool.connect();
    try {
      await expect(assertDatabaseSafety(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
  });
});
