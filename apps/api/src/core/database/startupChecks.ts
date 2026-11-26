import type pg from 'pg';

/**
 * Functional probes, not config reads. SHOW pool_mode is not reachable from an
 * application connection, and asserting the behaviour we actually depend on is
 * better than asserting the setting we think produces it.
 *
 * Every failure here aborts startup. Wired into the server in step 7; run
 * against a dedicated connection, never a pooled one shared with request work.
 */
export class DatabaseSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseSafetyError';
  }
}

const CANARY = '00000000-0000-0000-0000-0000000000ff';

const AUDIT_TABLES = ['platform.platform_audit_log', 'app.tenant_audit_log'] as const;

async function assertTransactionScopedPooling(client: pg.ClientBase): Promise<void> {
  // Probe 1: SET LOCAL must survive to the end of its own transaction. Under
  // PgBouncer in statement mode it is discarded, and RLS silently stops working
  // because every policy then sees an unset GUC.
  await client.query('BEGIN');
  try {
    // set_config(..., is_local => true) is SET LOCAL. SET itself takes no bind
    // parameters, so this is the only form that can carry a value safely --
    // the base repository must use it for the same reason.
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', CANARY]);
    const inside = await client.query<{ value: string | null }>(
      `SELECT current_setting('app.tenant_id', true) AS value`,
    );
    if (inside.rows[0]?.value !== CANARY) {
      throw new DatabaseSafetyError(
        'SET LOCAL did not take effect: the connection pooler is not in transaction mode. ' +
          'Tenant isolation via RLS cannot work in this configuration.',
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }

  // Probe 2: and it must not survive past it. A leaked GUC means tenant context
  // bleeds between requests sharing a pooled connection.
  const outside = await client.query<{ value: string | null }>(
    `SELECT current_setting('app.tenant_id', true) AS value`,
  );
  const leaked = outside.rows[0]?.value;
  if (leaked !== null && leaked !== undefined && leaked !== '') {
    throw new DatabaseSafetyError(
      `app.tenant_id leaked past its transaction (saw "${leaked}"). ` +
        'Tenant context would bleed between requests on a pooled connection.',
    );
  }
}

async function assertRoleCannotBypassRls(client: pg.ClientBase): Promise<void> {
  // Probe 3: BYPASSRLS on the application role disables tenant isolation
  // everywhere at once, with no other symptom.
  const result = await client.query<{ rolbypassrls: boolean; rolname: string }>(
    'SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const row = result.rows[0];
  if (!row) throw new DatabaseSafetyError('could not resolve current_user in pg_roles');
  if (row.rolbypassrls) {
    throw new DatabaseSafetyError(
      `${row.rolname} has BYPASSRLS. RLS is not enforced for this role.`,
    );
  }
}

async function assertRoleDoesNotOwnTenantTables(client: pg.ClientBase): Promise<void> {
  // Probe 4: FORCE ROW LEVEL SECURITY is deliberately off, because it would
  // subject the migration owner to the policies. That trade means RLS applies
  // only while the application role is not the table owner -- which is exactly
  // what gets violated by running the app as the owner in dev.
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND r.rolname = current_user`,
  );
  const owned = Number(result.rows[0]?.count ?? '0');
  if (owned > 0) {
    throw new DatabaseSafetyError(
      `current_user owns ${owned} table(s) in schema app. RLS does not apply to a table's ` +
        'owner unless FORCE is set, so tenant isolation is inactive. Connect as katkitchen_app.',
    );
  }
}

async function assertAuditTablesAreAppendOnly(client: pg.ClientBase): Promise<void> {
  // Probe 5: re-verify the grants on every boot rather than trusting that a
  // migration ran and was never undone by hand.
  for (const table of AUDIT_TABLES) {
    const result = await client.query<{ can_update: boolean; can_delete: boolean }>(
      `SELECT has_table_privilege(current_user, $1, 'UPDATE') AS can_update,
              has_table_privilege(current_user, $1, 'DELETE') AS can_delete`,
      [table],
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseSafetyError(`could not resolve privileges on ${table}`);
    if (row.can_update || row.can_delete) {
      const granted = [row.can_update ? 'UPDATE' : null, row.can_delete ? 'DELETE' : null]
        .filter(Boolean)
        .join(' and ');
      throw new DatabaseSafetyError(
        `current_user holds ${granted} on ${table}, which must be append-only.`,
      );
    }
  }
}

export async function assertDatabaseSafety(client: pg.ClientBase): Promise<void> {
  await assertTransactionScopedPooling(client);
  await assertRoleCannotBypassRls(client);
  await assertRoleDoesNotOwnTenantTables(client);
  await assertAuditTablesAreAppendOnly(client);
}
