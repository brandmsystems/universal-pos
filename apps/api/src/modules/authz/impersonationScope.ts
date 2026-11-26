import {
  PERMISSION_KEYS,
  riskClassOf,
  type PermissionKey,
  type RiskClass,
} from './permissions.js';
import { OWNER_WITHHELD } from './systemRoles.js';

/**
 * What an impersonating superadmin may do inside a tenant.
 *
 *   impersonationWriteScope = ownerKeys - keysWhere(risk_class <> 'none')
 *
 * Skipping tenant permission checks entirely gave an impersonating SUPPORT user
 * more power inside a tenant than its owner has: owner is denied payment.collect
 * and the vendor-master keys by separation of duties, and impersonation granted
 * both. That is an escalation path reachable from a `support` platform role.
 *
 * The rationale is not access control, it is liability: **a superadmin moving
 * money inside a client's tenant is a liability question.** Support diagnoses;
 * the tenant transacts. Credential reset stays available through the control
 * plane's force-reset path, which is auditable in platform_audit_log without
 * entering the tenant at all.
 *
 * Derived from risk_class rather than enumerated, so a fifth risk class is
 * excluded the moment it exists, with no edit here -- the same property as the
 * separation-of-duties exemption, and tested the same way with an injected
 * synthetic class.
 *
 * Despite the name this gates EVERY impersonated route, not only mutations:
 * `customer.pii.view` is a read and is privacy-class, so it is out of scope too.
 */
export function impersonationWriteScope(
  allKeys: readonly PermissionKey[] = PERMISSION_KEYS,
  withheld: readonly PermissionKey[] = OWNER_WITHHELD,
  classOf: (key: PermissionKey) => RiskClass = riskClassOf,
): ReadonlySet<PermissionKey> {
  const withheldSet = new Set(withheld);
  return new Set(
    allKeys.filter((key) => !withheldSet.has(key) && classOf(key) === 'none'),
  );
}

let cached: ReadonlySet<PermissionKey> | null = null;

/** The real scope, computed once. */
export function impersonationScope(): ReadonlySet<PermissionKey> {
  cached ??= impersonationWriteScope();
  return cached;
}

export function isWithinImpersonationScope(key: PermissionKey): boolean {
  return impersonationScope().has(key);
}
