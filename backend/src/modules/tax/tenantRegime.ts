import type pg from 'pg';
import type { JurisdictionDefinition } from './jurisdictions.js';
import { implementedJurisdiction, jurisdiction } from './registry.js';

/**
 * Which regime a tenant is in, read from the control plane.
 *
 * ###########################################################################
 * WHY THIS IS A CROSS-PLANE READ AND NOT A DENORMALISED COLUMN.
 *
 * `platform.tenant.tax_jurisdiction` is NOT NULL with no default: a tenant
 * cannot exist without one, because the alternative is a tenant whose bills are
 * taxed under whichever regime the code happened to be written for first.
 *
 * The tenant plane needs it for two things -- which heads a bill carries, and
 * which country code a bare local phone number belongs to -- and both are on
 * the app side of the boundary. Copying the column onto `app.branch` would make
 * a chain that opens a branch abroad a data migration, and would give a reader
 * two places to look and no way to tell which is right. So it is READ across
 * the boundary, in one function, and then STAMPED on whatever document depends
 * on it.
 *
 * `platform.tenant` carries no RLS -- the app role can see every row -- so the
 * tenant id is filtered here explicitly rather than relied on. Same posture as
 * `printWorker`'s tenant sweep.
 * ###########################################################################
 */
async function readCode(client: pg.ClientBase, tenantId: string): Promise<string> {
  const result = await client.query<{ tax_jurisdiction: string }>(
    `SELECT tax_jurisdiction FROM platform.tenant WHERE id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  // No fallback to India. A tenant context pointing at no tenant is a bug in
  // the caller, and answering it with a jurisdiction would put a head on a bill
  // for a restaurant nobody can name.
  if (!row) throw new TenantRegimeMissingError(tenantId);
  return row.tax_jurisdiction;
}

/**
 * The currency a restaurant bills in, from the same root row as its regime and
 * read the same way. A bill STAMPS it (0084): a reprint names the currency the
 * figures were taken in, whatever the restaurant says later.
 */
export async function tenantCurrency(client: pg.ClientBase, tenantId: string): Promise<string> {
  const result = await client.query<{ default_currency: string }>(
    `SELECT default_currency FROM platform.tenant WHERE id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new TenantRegimeMissingError(tenantId);
  return row.default_currency;
}

/** The regime, whatever its status. For reads and for display. */
export async function tenantRegime(
  client: pg.ClientBase,
  tenantId: string,
): Promise<JurisdictionDefinition> {
  return jurisdiction(await readCode(client, tenantId));
}

/**
 * The regime, and only if its rules exist. Every path that decides money goes
 * through this one, so a tenant in a declared-but-unbuilt jurisdiction is
 * refused by name rather than taxed under someone else's law.
 */
export async function implementedTenantRegime(
  client: pg.ClientBase,
  tenantId: string,
): Promise<JurisdictionDefinition> {
  return implementedJurisdiction(await readCode(client, tenantId));
}

export class TenantRegimeMissingError extends Error {
  readonly statusCode = 500;
  readonly code = 'tenant_regime_missing';
  constructor(readonly tenantId: string) {
    super(
      `tenant ${tenantId} has no row on the control plane, so there is no tax `
      + 'jurisdiction to work under. This is a broken tenant context, not a '
      + 'request a caller can correct.',
    );
    this.name = 'TenantRegimeMissingError';
  }
}
