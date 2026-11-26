import { afterAll } from 'vitest';
import pg from 'pg';

/**
 * ###########################################################################
 * THE DEFAULT AUDIT PARTITION MUST BE EMPTY AT THE END OF EVERY SUITE.
 *
 * A non-empty DEFAULT partition is the production alert that the partition job
 * has stopped. That alert was unfalsifiable locally: the reporting fixtures
 * write BACKDATED audit rows -- the exception report ranks an actor against
 * their own prior baseline, so it must -- and the forward-only partition job
 * never covered those months, so 280 rows sat in the default permanently.
 *
 * A permanently dirty default is worse than no monitoring. On the day the job
 * really stops, someone looks at a non-empty default and recognises the noise
 * they have been ignoring for months. This is the same argument that put a
 * deliberately misconfigured statement-mode PgBouncer in the local stack: a
 * check whose FAILING direction is never observed is a check nobody has shown to
 * work. The default partition had no equivalent, so it got one.
 *
 * The fix is in the FIXTURES, not in the check -- a fixture writing a backdated
 * row calls `ensureAuditPartitionFor` and creates that month's partition. This
 * hook is what keeps that true: it runs after EVERY test file, so a future
 * fixture that backdates without a partition fails immediately, in the suite
 * that did it, rather than accumulating into noise nobody can attribute.
 *
 * Per-file rather than once per run, deliberately. "Something dirtied the
 * default" is a much weaker finding than "reports.test.ts dirtied the default".
 * ###########################################################################
 */

const TARGETS = [
  'app.tenant_audit_log_default',
  'platform.platform_audit_log_default',
] as const;

afterAll(async () => {
  const connectionString = process.env['DATABASE_URL_OWNER'];
  if (!connectionString) {
    // Loud, not skipped. An assertion that quietly does not run is the failure
    // mode this hook exists to close -- absence is never a discriminator.
    throw new Error(
      'DATABASE_URL_OWNER is not set, so the default-partition assertion did not ' +
        'run. Export the env (set -a && . ./.env && set +a) rather than letting ' +
        'the check silently pass.',
    );
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const dirty: string[] = [];
    for (const table of TARGETS) {
      const result = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
      const n = Number(result.rows[0]!.n);
      if (n > 0) dirty.push(`${table}=${n}`);
    }

    if (dirty.length > 0) {
      throw new Error(
        `DEFAULT audit partition is not empty after this suite: ${dirty.join(', ')}. ` +
          'A fixture wrote an audit row for a month with no partition. Call ' +
          '`ensureAuditPartitionFor(owner, when)` before inserting a backdated row ' +
          '-- it uses the same DDL the partition job does. To relocate rows that ' +
          'are already stranded: node node_modules/tsx/dist/cli.mjs ' +
          'scripts/recover-default-audit-partition.mts',
      );
    }
  } finally {
    await client.end();
  }
});
