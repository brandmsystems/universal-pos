import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';
import { loadMigrations, type Migration } from '../../src/core/database/migrate.js';

/**
 * ###########################################################################
 * "EVERY MIGRATION IS REVERSIBLE" WAS A PROMISE NOTHING TESTED.
 *
 * `loadMigrations` already refuses a migration with no `.down.sql`, so presence
 * is enforced at load time. Presence is not reversibility. A `down` that is
 * valid SQL doing nothing, or invalid SQL nobody has ever executed, satisfies
 * that check and fails during the incident it was written for -- which is
 * exactly what happened to the partition-recovery runbook: it had never been
 * run, and its second step could not work at all because
 * `ATTACH PARTITION ... FOR VALUES FROM ($1)` takes no bind parameters.
 *
 * This is the third member of the unreached-code family in CLAUDE.md: code that
 * exists, is correct-looking, and has never executed. The other gates in this
 * repository constrain what running code may DO. This one asserts that 46 files
 * run at all.
 * ###########################################################################
 *
 * ###########################################################################
 * IT RUNS IN ONE TRANSACTION AND ROLLS BACK, RATHER THAN ON A SCRATCH DATABASE.
 *
 * DDL is transactional in Postgres, so the whole down-then-up cycle can happen
 * inside a transaction that is then thrown away: no other suite sees a dropped
 * schema, and `migration.applied` is never touched because the files are
 * executed directly rather than through the runner.
 *
 * A separate database would be cleaner in principle and is not available in
 * principle: `katkitchen_owner` is deliberately NOSUPERUSER and holds no
 * CREATEDB, so nothing in the production role set can create one. Reaching for a
 * superuser to make this test convenient would test a posture nobody deploys.
 * ###########################################################################
 */

let owner: pg.Client;
let migrations: readonly Migration[];

/**
 * Everything a migration can create, in the two schemas migrations own.
 *
 * Not a checksum of `pg_dump`: the point is to compare the schema to ITSELF
 * before and after, so the digest only has to be sensitive, not canonical. It
 * covers columns, constraints, indexes, policies, RLS flags, functions and
 * grants -- because a `down`/`up` pair that loses a REVOKE or an RLS policy is
 * precisely the silent failure that matters here, and a table-name-only digest
 * would call that reversible.
 */
/**
 * ###########################################################################
 * DATED AUDIT PARTITIONS ARE EXCLUDED, BECAUSE NO MIGRATION OWNS THEM.
 *
 * `tenant_audit_log_2026_09` and friends are created by the partition job and by
 * `ensureAuditPartitionFor`, on a rolling window, and other suites create
 * backdated ones. A round trip through the migrations legitimately lands with a
 * different SET of months, and counting that as irreversible would make this gate
 * fail for a reason that has nothing to do with a migration.
 *
 * The `_default` partitions are NOT excluded: those are created by 0007 itself,
 * and losing one would fail every write in the product.
 * ###########################################################################
 */
const DATED_PARTITION = /_audit_log_\d{4}_\d{2}\b/;

/** A diff, so a failure names what moved instead of dumping two blobs. */
function digestDiff(before: string, after: string): string {
  const b = new Set(before.split('\n'));
  const a = new Set(after.split('\n'));
  const lost = [...b].filter((l) => !a.has(l) && l.trim() !== '');
  const gained = [...a].filter((l) => !b.has(l) && l.trim() !== '');
  return [
    `lost after the round trip (${lost.length}):`,
    ...lost.slice(0, 25),
    lost.length > 25 ? `  ... and ${lost.length - 25} more` : '',
    `gained after the round trip (${gained.length}):`,
    ...gained.slice(0, 25),
    gained.length > 25 ? `  ... and ${gained.length - 25} more` : '',
  ].filter((l) => l !== '').join('\n');
}

async function schemaDigest(client: pg.Client): Promise<string> {
  const parts: string[] = [];

  const queries: ReadonlyArray<readonly [string, string]> = [
    ['columns', `SELECT table_schema||'.'||table_name||'.'||column_name||':'||data_type||
                        ':'||is_nullable||':'||coalesce(column_default,'-')
                   FROM information_schema.columns
                  WHERE table_schema IN ('app','platform')
                  ORDER BY 1`],
    ['constraints', `SELECT n.nspname||'.'||c.relname||'.'||con.conname||':'||con.contype::text||
                            ':'||pg_get_constraintdef(con.oid)
                       FROM pg_constraint con
                       JOIN pg_class c ON c.oid = con.conrelid
                       JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname IN ('app','platform')
                      ORDER BY 1`],
    ['indexes', `SELECT schemaname||'.'||indexname||':'||indexdef
                   FROM pg_indexes WHERE schemaname IN ('app','platform') ORDER BY 1`],
    ['policies', `SELECT schemaname||'.'||tablename||'.'||policyname||':'||
                         coalesce(qual,'-')||':'||coalesce(with_check,'-')
                    FROM pg_policies WHERE schemaname IN ('app','platform') ORDER BY 1`],
    // The RLS flag itself, separately from the policies on it: a partition with
    // policies but relrowsecurity off is readable cross-tenant.
    ['rls', `SELECT n.nspname||'.'||c.relname||':'||c.relrowsecurity::text||':'||c.relforcerowsecurity::text
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname IN ('app','platform') AND c.relkind IN ('r','p')
              ORDER BY 1`],
    ['functions', `SELECT n.nspname||'.'||p.proname||':'||pg_get_function_identity_arguments(p.oid)
                     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname IN ('app','platform') ORDER BY 1`],
    ['triggers', `SELECT n.nspname||'.'||c.relname||'.'||t.tgname
                    FROM pg_trigger t
                    JOIN pg_class c ON c.oid = t.tgrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname IN ('app','platform') AND NOT t.tgisinternal
                   ORDER BY 1`],
    ['grants', `SELECT table_schema||'.'||table_name||':'||grantee||':'||privilege_type
                  FROM information_schema.role_table_grants
                 WHERE table_schema IN ('app','platform')
                   AND grantee IN ('katkitchen_app','katkitchen_platform_readonly')
                 ORDER BY 1`],
  ];

  for (const [label, sql] of queries) {
    const result = await client.query<{ v: string }>(sql.replace(/^\s*SELECT/, 'SELECT') + '');
    const rows = result.rows
      .map((r) => Object.values(r)[0] as string)
      .filter((row) => !DATED_PARTITION.test(row));
    parts.push(`${label}(${rows.length})\n${rows.join('\n')}`);
  }
  return parts.join('\n====\n');
}

/** How many objects the two schemas hold, as a crude "did the downs do anything". */
async function objectCount(client: pg.Client): Promise<number> {
  const result = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('app','platform') AND c.relkind IN ('r','p')`,
  );
  return Number(result.rows[0]!.n);
}

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  migrations = await loadMigrations();
});

afterAll(async () => {
  await owner?.end();
});

describe('every migration is reversible, and the downs have actually run', () => {
  it('lists every migration through the runner\'s own loader', () => {
    assertCheckedSet({
      label: 'migrations loaded',
      checked: migrations.map((m) => m.version),
      minimum: 40,
      mustInclude: ['0001', '0007', '0036', '0046'],
    });
  });

  it('is not vacuous: the digest notices a single added table', async () => {
    // If the digest were insensitive, the round trip below would pass while
    // losing a REVOKE, an RLS policy or a whole table. Proven here rather than
    // assumed, on a savepoint so nothing survives.
    await owner.query('BEGIN');
    try {
      const before = await schemaDigest(owner);
      await owner.query('CREATE TABLE app.reversibility_probe (id uuid PRIMARY KEY)');
      const after = await schemaDigest(owner);
      expect(after).not.toEqual(before);
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it(
    'runs every down in reverse, then every up again, and lands on the same schema',
    async () => {
      await owner.query('BEGIN');
      try {
        const before = await schemaDigest(owner);
        const populated = await objectCount(owner);
        expect(populated, 'the suite must start from a migrated database').toBeGreaterThan(50);

        // ---- down, newest first -----------------------------------------
        for (const migration of [...migrations].reverse()) {
          const sql = await readFile(migration.downPath, 'utf8');
          try {
            await owner.query(sql);
          } catch (error) {
            throw new Error(
              `down migration ${migration.version}_${migration.name} failed: ` +
                `${(error as Error).message}`,
            );
          }
        }

        // A `down` that is valid SQL doing nothing would sail through the loop
        // above. This is what refuses it.
        const emptied = await objectCount(owner);
        expect(
          emptied,
          'after every down, the app and platform schemas should hold almost nothing; ' +
            `${emptied} tables remain, so some down did not undo its up`,
        ).toBeLessThan(3);

        // ---- up again, oldest first --------------------------------------
        for (const migration of migrations) {
          const sql = await readFile(migration.upPath, 'utf8');
          try {
            await owner.query(sql);
          } catch (error) {
            throw new Error(
              `re-applying ${migration.version}_${migration.name} after its down failed: ` +
                `${(error as Error).message}`,
            );
          }
        }

        const after = await schemaDigest(owner);

        // The interesting failure is not "it threw" -- it is a round trip that
        // succeeds and quietly loses a grant or a policy. So the message names
        // what moved: two 1400-line blobs in a diff viewer tell nobody anything.
        expect(after, after === before ? '' : digestDiff(before, after)).toEqual(before);
      } finally {
        // Whatever happened, the database the other suites share is untouched.
        await owner.query('ROLLBACK');
      }
    },
    120_000,
  );
});
