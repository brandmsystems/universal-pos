/**
 * ############################################################################
 * THE RUNBOOK, EXECUTABLE.
 *
 * CLAUDE.md carries a written procedure for recovering a stopped partition job,
 * ending "write this down before you need it at 2am". It was written down and
 * never run -- which is the same posture as a job with no runner or a route with
 * no server: a procedure nobody has executed is a procedure nobody has shown to
 * work, and 2am is a poor time to discover the step order is wrong.
 *
 * `ATTACH PARTITION` FAILS if the default partition holds rows belonging to the
 * new range, so recovery is move-then-attach, not attach:
 *
 *   1. BEGIN
 *   2. Create the target partition as a STANDALONE table with the right bounds
 *      as a CHECK -- the CHECK is what lets ATTACH skip its validation scan.
 *   3. INSERT..SELECT the matching rows out of the default and DELETE them from
 *      it, as katkitchen_owner (the only role that can delete from an audit
 *      table) with the append-only trigger disabled for this transaction only.
 *   4. ATTACH PARTITION, re-enable the trigger, apply the revokes and RLS.
 *   5. COMMIT
 *
 * Run: node node_modules/tsx/dist/cli.mjs scripts/recover-default-audit-partition.mts
 *      (add --dry-run to see what it would move)
 * ############################################################################
 */
import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');

interface Target {
  readonly schema: 'app' | 'platform';
  readonly parent: string;
  readonly rls: boolean;
}

const TARGETS: readonly Target[] = [
  { schema: 'app', parent: 'tenant_audit_log', rls: true },
  { schema: 'platform', parent: 'platform_audit_log', rls: false },
];

async function strandedMonths(
  client: pg.ClientBase,
  target: Target,
): Promise<{ ym: string; n: number }[]> {
  const result = await client.query<{ ym: string; n: string }>(
    `SELECT to_char(date_trunc('month', occurred_at), 'YYYY_MM') AS ym, count(*) AS n
       FROM ${target.schema}.${target.parent}_default
      GROUP BY 1 ORDER BY 1`,
  );
  return result.rows.map((r) => ({ ym: r.ym, n: Number(r.n) }));
}

async function recoverMonth(
  client: pg.ClientBase,
  target: Target,
  ym: string,
): Promise<number> {
  const part = `${target.parent}_${ym}`;
  const qualified = `${target.schema}.${part}`;
  const parent = `${target.schema}.${target.parent}`;
  const start = `${ym.replace('_', '-')}-01`;

  // DDL takes no bind parameters -- `ALTER TABLE ... FOR VALUES FROM ($1)` fails
  // with "bind message supplies 2 parameters, but prepared statement requires 0".
  // So the bounds are resolved to literals first and interpolated. `ym` came from
  // to_char(..., 'YYYY_MM') and is re-validated here rather than trusted.
  if (!/^\d{4}_\d{2}$/.test(ym)) throw new Error(`refusing a malformed month: ${ym}`);
  const bounds = await client.query<{ lo: string; hi: string }>(
    `SELECT $1::timestamptz::text AS lo,
            ($1::timestamptz + interval '1 month')::text AS hi`,
    [start],
  );
  const { lo, hi } = bounds.rows[0]!;
  const loLit = client.escapeLiteral ? client.escapeLiteral(lo) : `'${lo}'`;
  const hiLit = client.escapeLiteral ? client.escapeLiteral(hi) : `'${hi}'`;

  // Step 2. Standalone, with the bounds as a CHECK so ATTACH can skip the scan.
  await client.query(
    `CREATE TABLE ${qualified} (LIKE ${parent} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
  );
  await client.query(
    `ALTER TABLE ${qualified}
       ADD CONSTRAINT ${part}_bounds
       CHECK (occurred_at >= ${loLit}::timestamptz AND occurred_at < ${hiLit}::timestamptz)`,
  );

  // Step 3. Move. The trigger is disabled for THIS TRANSACTION only -- the
  // DELETE below is the one legitimate delete against an audit table, and it is
  // a relocation rather than a removal: every row is inserted before it is
  // deleted, in the same transaction.
  await client.query(
    `ALTER TABLE ${parent} DISABLE TRIGGER ${target.parent}_append_only`,
  );

  const moved = await client.query(
    `WITH picked AS (
       DELETE FROM ${target.schema}.${target.parent}_default
        WHERE occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz
        RETURNING *
     )
     INSERT INTO ${qualified} SELECT * FROM picked`,
    [lo, hi],
  );

  await client.query(
    `ALTER TABLE ${parent} ENABLE TRIGGER ${target.parent}_append_only`,
  );

  // Step 4. Attach, then re-apply what does NOT propagate: grants and RLS.
  await client.query(
    `ALTER TABLE ${parent} ATTACH PARTITION ${qualified}
       FOR VALUES FROM (${loLit}) TO (${hiLit})`,
  );
  // The bounds CHECK is now redundant with the partition constraint; keeping it
  // costs a second evaluation on every insert.
  await client.query(`ALTER TABLE ${qualified} DROP CONSTRAINT ${part}_bounds`);

  await client.query(
    `REVOKE ALL ON ${qualified} FROM katkitchen_app, katkitchen_platform_readonly`,
  );
  if (target.rls) {
    await client.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`);
    await client.query(
      `CREATE POLICY tenant_isolation ON ${qualified}
         USING (tenant_id = app.current_tenant_id())
         WITH CHECK (tenant_id = app.current_tenant_id())`,
    );
  }

  return moved.rowCount ?? 0;
}

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL_OWNER'];
  if (!connectionString) throw new Error('DATABASE_URL_OWNER is not set');
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    let total = 0;
    for (const target of TARGETS) {
      const stranded = await strandedMonths(client, target);
      if (stranded.length === 0) {
        console.log(`${target.schema}.${target.parent}_default: empty`);
        continue;
      }
      for (const { ym, n } of stranded) {
        console.log(`${target.schema}.${target.parent}_default: ${n} row(s) for ${ym}`);
        if (DRY_RUN) continue;

        await client.query('BEGIN');
        try {
          const moved = await recoverMonth(client, target, ym);
          await client.query('COMMIT');
          console.log(`  -> moved ${moved} into ${target.parent}_${ym}`);
          total += moved;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    }

    if (DRY_RUN) {
      console.log('dry run: nothing moved');
      return;
    }

    // The positive postcondition. Exiting 0 having done nothing is
    // indistinguishable from working.
    for (const target of TARGETS) {
      const left = await strandedMonths(client, target);
      if (left.length > 0) {
        console.error(
          `${target.schema}.${target.parent}_default still holds rows: ` +
            left.map((r) => `${r.ym}=${r.n}`).join(', '),
        );
        process.exitCode = 1;
        return;
      }
    }
    console.log(`verified: both default partitions empty (${total} row(s) relocated)`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
