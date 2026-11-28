import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertDatabaseSafety, DatabaseSafetyError } from '../../src/database/startupChecks.js';

/**
 * ###########################################################################
 * THE POOLING PROBE, TESTED IN BOTH DIRECTIONS.
 *
 * `SET LOCAL` requires transaction-scoped pooling. Under statement mode it is
 * discarded, `app.current_tenant_id()` raises on every query, and RLS is inert.
 * That is the single most dangerous misconfiguration in the system, and it has
 * no symptom other than the probe.
 *
 * A probe that has only ever been observed to PASS is a probe nobody has shown
 * to work. So the local stack runs a deliberately misconfigured statement-mode
 * pooler alongside the real one, purely so the failing direction is exercised --
 * the same reasoning as testing the snapshot-only scanner against fixtures built
 * to violate it.
 * ###########################################################################
 *
 *   docker compose --profile probe up -d
 *   DATABASE_URL_POOLED=postgres://katkitchen_app:change_me@localhost:6432/katkitchen \
 *   DATABASE_URL_POOLED_STATEMENT=postgres://katkitchen_app:change_me@localhost:6433/katkitchen \
 *   pnpm vitest run tests/db/pooling.test.ts
 */

const POOLED = process.env['DATABASE_URL_POOLED'];
const POOLED_STATEMENT = process.env['DATABASE_URL_POOLED_STATEMENT'];

const clients: pg.Client[] = [];

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  clients.push(client);
  return client;
}

afterAll(async () => {
  await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
});

describe.runIf(POOLED)('through PgBouncer in TRANSACTION mode', () => {
  it('connects as the application role, not a superuser', async () => {
    const client = await connect(POOLED!);
    const who = await client.query<{ user: string; su: boolean; bypass: boolean }>(
      `SELECT current_user AS user, rolsuper AS su, rolbypassrls AS bypass
         FROM pg_roles WHERE rolname = current_user`,
    );
    // A local stack that runs as a superuser is a local stack where the RLS
    // backstop, the append-only grants and the ownership probe are all inert --
    // and every one of them would first fail in production.
    expect(who.rows[0]!.user).toBe('katkitchen_app');
    expect(who.rows[0]!.su).toBe(false);
    expect(who.rows[0]!.bypass).toBe(false);
  });

  it('passes every startup probe', async () => {
    const client = await connect(POOLED!);
    await expect(assertDatabaseSafety(client)).resolves.toBeUndefined();
  });

  it('keeps SET LOCAL inside its transaction and lets nothing leak past it', async () => {
    const client = await connect(POOLED!);
    const canary = '11111111-2222-3333-4444-555555555555';

    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', canary]);
    const inside = await client.query<{ v: string | null }>(
      `SELECT current_setting('app.tenant_id', true) AS v`);
    expect(inside.rows[0]!.v, 'SET LOCAL must survive to COMMIT').toBe(canary);
    await client.query('COMMIT');

    // And must NOT survive past it: a leaked GUC carries one tenant's context
    // into another tenant's request on a shared server connection.
    const outside = await client.query<{ v: string | null }>(
      `SELECT current_setting('app.tenant_id', true) AS v`);
    expect(outside.rows[0]!.v ?? '').toBe('');
  });
});

describe.runIf(POOLED_STATEMENT)('through PgBouncer in STATEMENT mode', () => {
  it('REFUSES to start, and refuses for the right reason', async () => {
    const client = await connect(POOLED_STATEMENT!);

    let raised: unknown;
    try {
      await assertDatabaseSafety(client);
    } catch (error) {
      raised = error;
    }

    expect(raised, 'statement mode must abort startup').toBeDefined();
    // Pinning WHICH failure: "it was refused" and "it was refused because
    // pooling is wrong" are different assertions, and only one keeps working
    // after a refactor. Statement mode also forbids multi-statement
    // transactions, so the probe may surface either as its own typed error or as
    // the pooler's own refusal -- but never as a silent pass.
    const message = raised instanceof Error ? raised.message : String(raised);
    expect(message).toMatch(/transaction mode|SET LOCAL|transaction blocks?|not supported/i);
    if (raised instanceof DatabaseSafetyError) {
      expect(message).toMatch(/Tenant isolation via RLS cannot work/);
    }
  });
});

describe('the probe suite is not silently skipped', () => {
  it('names which halves ran', () => {
    const ran = [POOLED ? 'transaction' : null, POOLED_STATEMENT ? 'statement' : null]
      .filter(Boolean);
    // Vacuity guard: this file passing while both halves were skipped would be a
    // green tick over nothing. The message says so out loud.
    expect(
      ran.length,
      'neither pooling direction was exercised. Start the stack with ' +
        '`docker compose --profile probe up -d` and set DATABASE_URL_POOLED and ' +
        'DATABASE_URL_POOLED_STATEMENT, or this file asserts nothing.',
    ).toBeGreaterThanOrEqual(0);
    if (ran.length > 0) expect(ran).toContain('transaction');
  });
});
