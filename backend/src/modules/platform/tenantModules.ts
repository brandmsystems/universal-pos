import type pg from 'pg';
import { BUSINESS_MODULE_KEYS, CORE_MODULE, defaultModulesFor, isBusinessModuleKey } from '@universalpos/shared';

/**
 * Which modules a tenant has on. The registry says what a module is and what a type
 * starts with; this is the tenant's own copy, written by the control plane only and
 * published to the tenant plane inside the entitlement document.
 */

export class TenantModulesInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'tenant_modules_invalid';
  constructor(message: string) {
    super(message);
    this.name = 'TenantModulesInvalidError';
  }
}

/** The modules a request names, checked: known keys only, the till always on, no repeats. */
export function checkedModules(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TenantModulesInvalidError('modules must be a list of module keys.');
  const keys = value.map((item) => {
    if (!isBusinessModuleKey(item)) {
      throw new TenantModulesInvalidError(`unknown module "${String(item)}"; known modules: ${BUSINESS_MODULE_KEYS.join(', ')}.`);
    }
    return item;
  });
  if (!keys.includes(CORE_MODULE)) {
    throw new TenantModulesInvalidError(`the ${CORE_MODULE} module is the till itself and cannot be switched off.`);
  }
  return [...new Set(keys)].sort();
}

/**
 * Makes exactly `keys` the tenant's enabled modules (others stay as rows, switched
 * off, so the history of what was once on survives). Returns whether anything changed.
 */
export async function setTenantModules(
  client: pg.ClientBase,
  tenantId: string,
  keys: readonly string[],
): Promise<boolean> {
  const before = await enabledModules(client, tenantId);
  await client.query(
    `INSERT INTO platform.tenant_module (tenant_id, module_key, enabled)
     SELECT $1, k, true FROM unnest($2::text[]) AS k
     ON CONFLICT (tenant_id, module_key) DO UPDATE SET enabled = true, changed_at = now()
       WHERE platform.tenant_module.enabled = false`,
    [tenantId, keys]);
  await client.query(
    `UPDATE platform.tenant_module SET enabled = false, changed_at = now()
      WHERE tenant_id = $1 AND enabled AND module_key <> ALL($2::text[])`,
    [tenantId, keys]);
  const after = await enabledModules(client, tenantId);
  return before.join() !== after.join();
}

/** A new tenant's modules: what the wizard sent, or the type's own defaults. */
export async function seedTenantModules(
  client: pg.ClientBase,
  tenantId: string,
  businessType: string,
  requested: unknown,
): Promise<readonly string[]> {
  const keys = requested === undefined ? checkedModules([...defaultModulesFor(businessType)]) : checkedModules(requested);
  await setTenantModules(client, tenantId, keys);
  return keys;
}

export async function enabledModules(client: pg.ClientBase, tenantId: string): Promise<readonly string[]> {
  const rows = await client.query<{ module_key: string }>(
    `SELECT module_key FROM platform.tenant_module WHERE tenant_id = $1 AND enabled ORDER BY module_key`, [tenantId]);
  return rows.rows.map((r) => r.module_key);
}
