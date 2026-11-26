import type pg from 'pg';

/**
 * Every scheduled job, declared as DATA.
 *
 * ###########################################################################
 * THE SCHEDULER DOES NOT APPEAR IN THIS FILE, AND MUST NOT.
 *
 * A job is a plain function taking a client and returning what it proved. The
 * schedule is a cron string because that is the lowest common denominator every
 * host understands -- crontab locally, EventBridge or Cloud Scheduler later --
 * and it is a STRING here rather than an import from a scheduling library.
 *
 * Nothing under src/ may import a scheduler. If a job ever needs to know what
 * triggered it, the abstraction has already leaked.
 * ###########################################################################
 */

export type JobPosture =
  /** Reads or writes tenant tables. Runs as katkitchen_app under a GUC. */
  | 'app'
  /** Control-plane, or DDL, or deliberately RLS-exempt. Runs as katkitchen_owner. */
  | 'owner';

export interface JobOutcome {
  /** What the postcondition proved. A run that did nothing must say so. */
  readonly detail: string;
}

export interface JobDefinition {
  readonly name: string;
  /** Standard five-field cron. Data, never a library type. */
  readonly schedule: string;
  /**
   * ######################################################################
   * THE POSTURE IS DECLARED HERE, NOT CHOSEN BY THE RUNNER.
   *
   * The runner reads this and resolves a connection; it has no parameter
   * for a role and no way to override one. A scheduler that could pick the
   * role could run a tenant job as the owner, exempt from RLS, and a
   * predicate bug would then merge two tenants instead of returning nothing.
   * ######################################################################
   */
  readonly posture: JobPosture;
  /**
   * Alert if no successful run within this many minutes. Derived from the
   * schedule with slack: a daily job overdue by a few hours is late, by two days
   * is stopped.
   */
  readonly maxAgeMinutes: number;
  run(client: pg.ClientBase): Promise<JobOutcome>;
}

async function usageRollup(client: pg.ClientBase): Promise<JobOutcome> {
  const { rollUpUsage, verifyRollup } = await import('../modules/metering/usageRollup.js');
  const asOfDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const result = await rollUpUsage(client, { asOfDate });
  const missing = await verifyRollup(client, { asOfDate });
  if (missing.length > 0) {
    throw new Error(`rollup incomplete: ${missing.length} tenant/metric pair(s) missing`);
  }
  if (result.failures.length > 0) {
    throw new Error(`rollup had ${result.failures.length} failure(s)`);
  }
  return { detail: `${result.rowsWritten} row(s) across ${result.tenantsProcessed} tenant(s)` };
}

async function outboxDrain(client: pg.ClientBase): Promise<JobOutcome> {
  const { drainOnce, verifyDrain } = await import('../modules/notifications/outboxWorker.js');
  const { CONSUMERS } = await import('../modules/notifications/outboxConsumers.js');
  const result = await drainOnce(client, { consumers: CONSUMERS });
  const stranded = await verifyDrain(client);
  if (stranded.length > 0) throw new Error(`${stranded.length} message(s) stranded in 'claimed'`);
  return {
    detail: `delivered ${result.delivered}, dead-lettered ${result.deadLettered}, ` +
      `reclaimed ${result.reclaimed}`,
  };
}

async function printDrain(client: pg.ClientBase): Promise<JobOutcome> {
  const { printOnce, verifyPrintDrain } = await import('../modules/kitchen/printWorker.js');
  const result = await printOnce(client, {
    // No real transport here: a job that silently claimed success would mark
    // every ticket accepted and lose it. The deployed worker injects a real one.
    transport: { async send() { throw new Error('no print transport configured'); } },
  });
  const stranded = await verifyPrintDrain(client);
  if (stranded.length > 0) throw new Error(`${stranded.length} print job(s) stranded`);
  return { detail: `accepted ${result.accepted}, failed ${result.failed}` };
}

async function auditPartitions(client: pg.ClientBase): Promise<JobOutcome> {
  const { ensureAuditPartitions, missingPartitionMonths, defaultPartitionCounts } =
    await import('../core/database/partitions.js');
  const monthsAhead = Number(process.env['AUDIT_PARTITION_MONTHS_AHEAD'] ?? '3');
  await ensureAuditPartitions(client, monthsAhead);

  const missing = await missingPartitionMonths(client, monthsAhead);
  if (missing.length > 0) throw new Error(`partitions still missing: ${missing.join(', ')}`);

  // A non-empty DEFAULT partition is the alert that this job stopped -- it has
  // been absorbing inserts that belong somewhere else.
  const stranded = await defaultPartitionCounts(client);
  if (stranded.platform > 0 || stranded.app > 0) {
    throw new Error(
      `DEFAULT partition is not empty (platform=${stranded.platform} app=${stranded.app}); ` +
        'see the move-then-attach runbook',
    );
  }
  return { detail: `${monthsAhead + 1} month(s) present for both audit tables, default empty` };
}

async function ladderRecompute(client: pg.ClientBase): Promise<JobOutcome> {
  const { recomputeLadder } = await import('../modules/platform/ladder.js');
  const result = await recomputeLadder(client);
  if (result.stillDisagreeing.length > 0) {
    throw new Error(
      `${result.stillDisagreeing.length} tenant(s) still disagree with their computed ` +
        'status after a recompute; the cache and delinquent_since have diverged',
    );
  }
  return { detail: `${result.advanced.length} tenant(s) advanced along the ladder` };
}

async function claimPurge(client: pg.ClientBase): Promise<JobOutcome> {
  const { REQUEST_CLAIM_RETENTION_DAYS } = await import('../modules/offline/window.js');
  const result = await client.query<{ purged: string }>(
    `SELECT app.purge_request_claims($1)::text AS purged`,
    [REQUEST_CLAIM_RETENTION_DAYS],
  );
  return {
    detail: `${result.rows[0]!.purged} claim(s) older than ${REQUEST_CLAIM_RETENTION_DAYS}d`,
  };
}

/**
 * Login telemetry ages out after its retention window (CLAUDE.md: credential
 * events, 30 days). The purge function existed from 0046 with no job calling it,
 * so nothing was ever removed. Self-verifying: a purge that leaves an expired row
 * behind fails the run rather than reporting the count it happened to delete.
 */
async function authAttemptPurge(client: pg.ClientBase): Promise<JobOutcome> {
  const { purgeAuthAttempts, AUTH_ATTEMPT_RETENTION_DAYS } = await import('../modules/auth/authAttempt.js');
  const purged = await purgeAuthAttempts(client, AUTH_ATTEMPT_RETENTION_DAYS);
  const left = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM platform.auth_attempt
      WHERE occurred_at < now() - make_interval(days => $1)`,
    [AUTH_ATTEMPT_RETENTION_DAYS],
  );
  if (Number(left.rows[0]!.n) !== 0) {
    throw new Error(`${left.rows[0]!.n} sign-in attempt(s) older than ${AUTH_ATTEMPT_RETENTION_DAYS}d survived the purge`);
  }
  return { detail: `${purged} sign-in attempt(s) older than ${AUTH_ATTEMPT_RETENTION_DAYS}d` };
}

/**
 * Reconciliation, the cost envelope and the balance check are ONE job.
 *
 * They read the same rows and answer three questions about them, so splitting
 * them into three schedules would triple the scan and let the three answers be
 * computed against three different instants -- which is exactly the kind of
 * inconsistency an envelope check exists to detect.
 */
async function stockReconciliation(client: pg.ClientBase): Promise<JobOutcome> {
  const { runReconciliationJob } = await import('../modules/inventory/reconcile.js');
  const { peekTenantContext } = await import('../core/database/tenantContext.js');
  void peekTenantContext;

  const result = await runReconciliationJob(client, (tenantId) => ({
    tenantId, client, actor: null,
  }));

  const drift = result.reports.reduce((a, r) => a + r.drift.length, 0);
  const envelope = result.reports.reduce((a, r) => a + r.costOutOfRange.length, 0);
  const negatives = result.reports.reduce((a, r) => a + r.negatives.length, 0);

  // ALERT-ONLY, and that is load-bearing: the job never corrects. The gap
  // between the ledger and the cache IS the diagnostic, and a silent re-fold
  // erases the only signal.
  if (drift > 0 || envelope > 0) {
    throw new Error(
      `${drift} balance drift(s) and ${envelope} cost(s) outside every price ever paid ` +
        `across ${result.tenantsChecked} tenant(s). Reported, never repaired.`,
    );
  }
  return {
    detail: `${result.tenantsChecked} tenant(s) checked, ${negatives} negative balance(s) ` +
      'reported to their branches',
  };
}

/**
 * An active user with no active credential is a silent lockout, and it WILL
 * happen during credential rotation. Cross-table cardinality cannot be a CHECK,
 * and a deferred constraint trigger deadlocks under concurrent rotation -- so it
 * alerts instead of being enforced.
 */
async function activeUserWithoutCredential(client: pg.ClientBase): Promise<JobOutcome> {
  const result = await client.query<{ tenant_id: string; user_id: string; full_name: string }>(
    `SELECT u.tenant_id, u.id AS user_id, u.full_name
       FROM app.app_user u
      WHERE u.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM app.credential c
           WHERE c.tenant_id = u.tenant_id AND c.user_id = u.id AND c.status = 'active')
      ORDER BY u.tenant_id, u.id`,
  );
  if (result.rowCount && result.rowCount > 0) {
    throw new Error(
      `${result.rowCount} active user(s) hold no active credential and cannot log in: ` +
        result.rows.slice(0, 5).map((r) => r.full_name).join(', '),
    );
  }
  return { detail: 'every active user holds an active credential' };
}

/**
 * A permission check that passed on a union no single membership supplies is an
 * internal invariant violation. It returns 403 and is counted; a non-zero count
 * should page someone.
 */
async function unattributableActions(client: pg.ClientBase): Promise<JobOutcome> {
  const result = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.tenant_audit_log
      WHERE actor_kind = 'user' AND authorising_membership_id IS NULL
        AND occurred_at >= now() - interval '1 day'`,
  );
  const count = Number(result.rows[0]!.n);
  if (count > 0) {
    throw new Error(
      `${count} audit row(s) in the last day claim a user actor with no authorising ` +
        'membership. A write the permission check allowed but could not attribute must ' +
        'never have been written.',
    );
  }
  return { detail: 'every user-attributed action names its authorising membership' };
}

/**
 * A pseudo-job whose only output is a row.
 *
 * It exists so that "the scheduler itself stopped" has a shape: every other job
 * runs daily, so a dead scheduler is invisible for a day. This runs every five
 * minutes, so its absence is detectable in minutes.
 *
 * It does NOT solve the problem -- something outside still has to ask. See
 * `docs/deployment/scheduler-monitoring.md`.
 */
async function heartbeat(client: pg.ClientBase): Promise<JobOutcome> {
  const result = await client.query<{ now: string }>(`SELECT now()::text AS now`);
  return { detail: `scheduler alive at ${result.rows[0]!.now}` };
}

export const JOBS: readonly JobDefinition[] = [
  // Tenant-touching: app role, RLS applies.
  { name: 'usage.rollup', schedule: '15 1 * * *', posture: 'app', maxAgeMinutes: 60 * 36, run: usageRollup },
  { name: 'outbox.drain', schedule: '* * * * *', posture: 'app', maxAgeMinutes: 15, run: outboxDrain },
  { name: 'print.drain', schedule: '* * * * *', posture: 'app', maxAgeMinutes: 15, run: printDrain },
  { name: 'stock.reconciliation', schedule: '30 2 * * *', posture: 'app', maxAgeMinutes: 60 * 36, run: stockReconciliation },

  // Control plane, DDL, or deliberately RLS-exempt: owner role.
  { name: 'audit.partitions', schedule: '0 3 * * *', posture: 'owner', maxAgeMinutes: 60 * 36, run: auditPartitions },
  { name: 'ladder.recompute', schedule: '0 4 * * *', posture: 'owner', maxAgeMinutes: 60 * 36, run: ladderRecompute },
  { name: 'claim.purge', schedule: '45 3 * * *', posture: 'owner', maxAgeMinutes: 60 * 36, run: claimPurge },
  { name: 'auth_attempt.purge', schedule: '50 3 * * *', posture: 'owner', maxAgeMinutes: 60 * 36, run: authAttemptPurge },
  // ######################################################################
  // These two sweep ACROSS tenants, which is a third category: not
  // control-plane, but not scoped to one tenant either.
  //
  // The app role cannot run them at all -- RLS scopes every read to one GUC,
  // and there is no GUC value that means "all". Iterating tenants would work
  // and would be slower and no safer, because the finding is a COUNT across the
  // estate. So they take the ladder/purge posture: owner, deliberately
  // RLS-exempt, reading nothing tenant-identifying beyond what the alert names.
  // ######################################################################
  { name: 'user.credential_check', schedule: '0 5 * * *', posture: 'owner', maxAgeMinutes: 60 * 36, run: activeUserWithoutCredential },
  { name: 'audit.unattributable', schedule: '0 * * * *', posture: 'owner', maxAgeMinutes: 180, run: unattributableActions },

  { name: 'scheduler.heartbeat', schedule: '*/5 * * * *', posture: 'owner', maxAgeMinutes: 20, run: heartbeat },
];

export function jobByName(name: string): JobDefinition | undefined {
  return JOBS.find((j) => j.name === name);
}
