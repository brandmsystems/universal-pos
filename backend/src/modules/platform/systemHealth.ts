import type pg from 'pg';
import { outboxHealth, type OutboxHealth } from '../notifications/outboxWorker.js';
import { ladderThresholds, statusForElapsedDays } from './ladder.js';
import { missingPartitionMonths } from '../../database/partitions.js';

/**
 * What `GET /system/health` can HONESTLY report.
 *
 * ###########################################################################
 * IT DOES NOT CALL `assertDatabaseSafety`, AND THAT IS NOT LAZINESS.
 *
 * `assertDatabaseSafety` is the right set of probes and the wrong shape for a
 * request. Its first probe issues `BEGIN` / `COMMIT` on the client it is handed,
 * and a control-plane handler is already inside a transaction the registrar
 * opened -- so calling it would COMMIT the registrar's transaction half way
 * through the request, before the audit row is written. The nested BEGIN is a
 * warning; the COMMIT is a silent early commit of somebody else's unit of work.
 *
 * So the probes that can be answered by a SELECT are answered by a SELECT here,
 * and the one that cannot -- does `SET LOCAL` survive its transaction and not
 * outlive it -- is reported as `not_probed` with the reason, rather than being
 * quietly dropped or faked. A health screen that omits a check it did not run is
 * how "green" comes to mean "we did not look".
 *
 * EVERY CHECK CAN SAY "I COULD NOT LOOK". The control plane may be connected as
 * a role without the privilege a check needs, and the honest answer then is
 * `unknown` with the error, never `ok`. Absence denies, as everywhere else.
 * ###########################################################################
 */

export type CheckState = 'ok' | 'degraded' | 'failed' | 'unknown' | 'not_probed';

export interface HealthCheck {
  readonly name: string;
  readonly state: CheckState;
  /** A sentence an operator can act on. Never empty, including when ok. */
  readonly detail: string;
}

export interface SystemHealthReport {
  /** The worst state any check reported. `ok` only when every check is ok. */
  readonly state: CheckState;
  readonly checkedAt: string;
  readonly databaseRole: string;
  readonly checks: readonly HealthCheck[];
  readonly outbox: OutboxHealth | null;
}

/** Worst-first, so a report's headline is its worst check and never its best. */
const SEVERITY: readonly CheckState[] = ['failed', 'degraded', 'unknown', 'not_probed', 'ok'];

function worst(checks: readonly HealthCheck[]): CheckState {
  for (const state of SEVERITY) {
    if (checks.some((check) => check.state === state)) return state;
  }
  return 'ok';
}

/**
 * Runs one check, and turns a thrown error into `unknown` rather than a 500.
 *
 * A health endpoint that dies on its first failing probe reports nothing about
 * the other nine, which is the opposite of what it is for.
 */
async function attempt(
  name: string,
  run: () => Promise<HealthCheck>,
): Promise<HealthCheck> {
  try {
    return await run();
  } catch (error) {
    return {
      name,
      state: 'unknown',
      detail: `could not be probed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function systemHealthReport(
  client: pg.ClientBase,
  params: { monthsAhead?: number } = {},
): Promise<SystemHealthReport> {
  const role = await client.query<{ role: string }>(`SELECT current_user AS role`);
  const databaseRole = role.rows[0]?.role ?? 'unknown';

  const checks: HealthCheck[] = [];

  // ---- the three startup probes that a SELECT can answer -------------------

  checks.push(await attempt('rls_not_bypassed', async () => {
    const result = await client.query<{ bypass: boolean }>(
      `SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
    );
    const bypass = result.rows[0]?.bypass;
    if (bypass === undefined) {
      return { name: 'rls_not_bypassed', state: 'unknown', detail: 'current_user is not in pg_roles' };
    }
    return bypass
      ? { name: 'rls_not_bypassed', state: 'failed',
          detail: `${databaseRole} holds BYPASSRLS: tenant isolation is not enforced for it` }
      : { name: 'rls_not_bypassed', state: 'ok',
          detail: `${databaseRole} does not hold BYPASSRLS` };
  }));

  checks.push(await attempt('rls_applies_to_request_role', async () => {
    // FORCE ROW LEVEL SECURITY is deliberately off, so RLS applies only while
    // the connected role is not the table owner. Owning one app table disables
    // isolation for it with no other symptom.
    const result = await client.query<{ owned: string }>(
      `SELECT count(*)::text AS owned
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner
        WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND r.rolname = current_user`,
    );
    const owned = Number(result.rows[0]?.owned ?? '0');
    return owned > 0
      ? { name: 'rls_applies_to_request_role', state: 'failed',
          detail: `${databaseRole} owns ${owned} table(s) in schema app, so no policy applies to it` }
      : { name: 'rls_applies_to_request_role', state: 'ok',
          detail: `${databaseRole} owns no table in schema app` };
  }));

  checks.push(await attempt('audit_logs_append_only', async () => {
    // The pair is found in pg_class rather than written out, so a probe cannot
    // name a table that no longer exists and report `ok` for it. `relkind = 'p'`
    // pins the PARENTS: the partitions themselves are revoked outright and
    // access goes through the parent.
    const result = await client.query<{ table_name: string; writable: boolean }>(
      `SELECT n.nspname || '.' || c.relname AS table_name,
              (has_table_privilege(current_user, c.oid, 'UPDATE')
               OR has_table_privilege(current_user, c.oid, 'DELETE')) AS writable
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'p'
          AND c.relname IN ('platform_audit_log', 'tenant_audit_log')
        ORDER BY 1`,
    );
    if (result.rowCount !== 2) {
      return { name: 'audit_logs_append_only', state: 'unknown',
        detail: `expected two partitioned audit logs, found ${result.rowCount ?? 0}` };
    }
    const writable = result.rows.filter((row) => row.writable).map((row) => row.table_name);
    return writable.length > 0
      ? { name: 'audit_logs_append_only', state: 'failed',
          detail: `${databaseRole} can UPDATE or DELETE ${writable.join(' and ')}` }
      : { name: 'audit_logs_append_only', state: 'ok',
          detail: 'neither audit log grants UPDATE or DELETE to this role' };
  }));

  // The fourth probe, named rather than omitted. See the header.
  checks.push({
    name: 'transaction_scoped_pooling',
    state: 'not_probed',
    detail:
      'SET LOCAL survival is asserted at startup by assertDatabaseSafety, which needs its ' +
      'own BEGIN/COMMIT and so cannot run inside a request transaction. A process that ' +
      'failed it would not have started.',
  });

  // ---- the ladder cache against its own day 0 ------------------------------

  checks.push(await attempt('ladder_cache_agrees', async () => {
    const thresholds = await ladderThresholds(client);
    const rows = await client.query<{ id: string; status: string; elapsed: string }>(
      `SELECT id, status,
              floor(extract(epoch FROM (now() - delinquent_since)) / 86400)::text AS elapsed
         FROM platform.tenant
        WHERE delinquent_since IS NOT NULL AND status <> 'purged'`,
    );
    const disagreeing = rows.rows.filter(
      (row) => statusForElapsedDays(Number(row.elapsed), thresholds) !== row.status);
    return disagreeing.length > 0
      ? { name: 'ladder_cache_agrees', state: 'degraded',
          detail: `${disagreeing.length} tenant(s) hold a status their own delinquent_since ` +
            'does not imply; the ladder recompute job has not run or is failing' }
      : { name: 'ladder_cache_agrees', state: 'ok',
          detail: `${rows.rowCount ?? 0} delinquent tenant(s), every status derivable from day 0` };
  }));

  // ---- the outbox ----------------------------------------------------------

  let outbox: OutboxHealth | null = null;
  checks.push(await attempt('outbox_draining', async () => {
    outbox = await outboxHealth(client);
    const held = outbox;
    if (held.deadLetter > 0) {
      return { name: 'outbox_draining', state: 'degraded',
        detail: `${held.deadLetter} message(s) dead-lettered; each is a side effect that ` +
          'never happened and nothing will retry it' };
    }
    if (held.stuckClaims > 0) {
      return { name: 'outbox_draining', state: 'degraded',
        detail: `${held.stuckClaims} claim(s) older than the timeout; the drain is not reclaiming` };
    }
    return { name: 'outbox_draining', state: 'ok',
      detail: `${held.pending} pending, ${held.claimed} claimed, none dead-lettered` };
  }));

  // ---- audit partitions ----------------------------------------------------

  checks.push(await attempt('audit_partitions_present', async () => {
    const monthsAhead = params.monthsAhead ?? 3;
    const missing = await missingPartitionMonths(client, monthsAhead);
    return missing.length > 0
      ? { name: 'audit_partitions_present', state: 'degraded',
          detail: `missing partitions: ${missing.join(', ')}. Audit rows for those months ` +
            'will land in the DEFAULT partition.' }
      : { name: 'audit_partitions_present', state: 'ok',
          detail: `both audit tables are partitioned through ${monthsAhead} month(s) ahead` };
  }));

  return {
    state: worst(checks),
    checkedAt: new Date().toISOString(),
    databaseRole,
    checks,
    outbox,
  };
}
