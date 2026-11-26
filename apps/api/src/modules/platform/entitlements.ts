import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  entitlementsFromTerms, getAdminMenu, type AdminMenu, type PlanEntitlements,
} from '@katkitchen/shared';

/**
 * Entitlements are the one thing that flows down across the plane boundary.
 *
 * The version is the load-bearing part. Without it, a downgrade publishing v5 and
 * a slow in-flight write of v4 landing afterwards silently restores features the
 * tenant no longer pays for, and nothing notices. The tenant plane accepts a
 * document only if its version is STRICTLY GREATER than the one it holds.
 */

export interface EntitlementDocument {
  readonly tenantId: string;
  readonly version: number;
  readonly planKey: string;
  readonly planVersion: number;
  readonly status: 'active' | 'past_due' | 'soft_lock' | 'hard_lock' | 'suspended';
  readonly limits: Readonly<Record<string, number>>;
  readonly features: Readonly<Record<string, boolean>>;
  readonly publishedAt: string;
}

/**
 * Allocates the next version under a row lock on the tenant, so two concurrent
 * publishes cannot both produce a v6 -- which would leave "strictly greater"
 * unable to order them.
 */
export async function publishEntitlement(
  client: pg.ClientBase,
  tenantId: string,
  reason: string,
): Promise<EntitlementDocument> {
  const version = await client.query<{ next_entitlement_version: string }>(
    `SELECT platform.next_entitlement_version($1)::text AS next_entitlement_version`,
    [tenantId],
  );
  const next = Number(version.rows[0]!.next_entitlement_version);

  const source = await client.query<{
    plan_key: string;
    plan_version: number;
    tenant_status: string;
    limits: Record<string, number>;
    features: Record<string, boolean>;
  }>(
    `SELECT p.key AS plan_key,
            pv.version AS plan_version,
            t.status AS tenant_status,
            pv.limits,
            pv.features
       FROM platform.tenant t
       JOIN platform.subscription s
         ON s.tenant_id = t.id AND s.status IN ('trialing', 'active', 'past_due')
       JOIN platform.plan_version pv ON pv.id = s.plan_version_id
       JOIN platform.plan p ON p.id = pv.plan_id
      WHERE t.id = $1`,
    [tenantId],
  );
  const row = source.rows[0];
  if (!row) throw new Error(`tenant ${tenantId} has no live subscription to publish`);

  const status = mapTenantStatus(row.tenant_status);

  await client.query(
    `INSERT INTO platform.entitlement_document
       (tenant_id, version, plan_key, plan_version, status, limits, features, reason)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [
      tenantId,
      next,
      row.plan_key,
      row.plan_version,
      status,
      JSON.stringify(row.limits),
      JSON.stringify(row.features),
      reason,
    ],
  );

  return {
    tenantId,
    version: next,
    planKey: row.plan_key,
    planVersion: row.plan_version,
    status,
    limits: row.limits,
    features: row.features,
    publishedAt: new Date().toISOString(),
  };
}

/**
 * Publishes the document in the caller's transaction and tells the tenant
 * plane's cache through the outbox. Every change to what a restaurant may do
 * goes through here: provisioning, a plan switch, a deactivation. A change the
 * tablets do not hear about is a change that has not happened yet -- an upgrade
 * that left the old document live would keep refusing what was just paid for.
 */
export async function publishAndAnnounce(
  client: pg.ClientBase,
  tenantId: string,
  reason: string,
): Promise<EntitlementDocument> {
  const document = await publishEntitlement(client, tenantId, reason);
  await client.query(
    `INSERT INTO platform.outbox (id, topic, dedupe_key, payload)
     VALUES ($1, 'entitlement.invalidate', $2, $3::jsonb)
     ON CONFLICT (topic, dedupe_key) DO NOTHING`,
    [randomUUID(), `${tenantId}:${document.version}`,
     JSON.stringify({ tenantId, version: document.version })]);
  return document;
}

function mapTenantStatus(status: string): EntitlementDocument['status'] {
  switch (status) {
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'soft_lock':
      return 'soft_lock';
    case 'hard_lock':
      return 'hard_lock';
    default:
      // retention, purge_pending, purged all deny.
      return 'suspended';
  }
}

/* ------------------------------------------------------------------ cache --- */

export class EntitlementUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'entitlement_unavailable';
  constructor(tenantId: string) {
    super(`no entitlement document available for tenant ${tenantId}`);
    this.name = 'EntitlementUnavailableError';
  }
}

export class UpgradeRequiredError extends Error {
  readonly statusCode = 402;
  readonly code = 'upgrade_required';
  constructor(readonly limitKey: string, readonly limit: number, readonly attempted: number) {
    super(`${limitKey} limit of ${limit} exceeded (attempted ${attempted})`);
    this.name = 'UpgradeRequiredError';
  }
}

export interface EntitlementCache {
  get(tenantId: string): Promise<EntitlementDocument | null>;
  put(document: EntitlementDocument): Promise<void>;
}

/**
 * In-memory reference implementation with the version rule enforced. Redis
 * swaps in behind the same interface; the rule must live here, not in the caller,
 * because a caller that forgets it produces exactly the silent restoration this
 * exists to prevent.
 */
export class VersionedEntitlementCache implements EntitlementCache {
  private readonly store = new Map<string, EntitlementDocument>();

  async get(tenantId: string): Promise<EntitlementDocument | null> {
    return this.store.get(tenantId) ?? null;
  }

  async put(document: EntitlementDocument): Promise<void> {
    const held = this.store.get(document.tenantId);
    // Strictly greater. Equal is also rejected: a republish at the same version
    // is either a bug or a replay, and neither should overwrite.
    if (held && document.version <= held.version) return;
    this.store.set(document.tenantId, document);
  }

  /** Test/ops affordance: what version is currently held. */
  heldVersion(tenantId: string): number | null {
    return this.store.get(tenantId)?.version ?? null;
  }
}

/**
 * Fail CLOSED. An unreachable cache does not mean unlimited -- it means the
 * tenant plane cannot prove entitlement, and a write path that cannot prove
 * entitlement must refuse. The tenant plane never calls the control plane per
 * request to resolve this; it refuses and the cache is repopulated by event.
 */
export async function requireEntitlement(
  cache: EntitlementCache,
  tenantId: string,
): Promise<EntitlementDocument> {
  let document: EntitlementDocument | null;
  try {
    document = await cache.get(tenantId);
  } catch {
    throw new EntitlementUnavailableError(tenantId);
  }
  if (!document) throw new EntitlementUnavailableError(tenantId);
  return document;
}

export function assertWithinLimit(
  document: EntitlementDocument,
  limitKey: string,
  attempted: number,
): void {
  const limit = document.limits[limitKey];
  // An absent limit is not an unlimited one. Same direction as everything else:
  // absence denies.
  if (limit === undefined) throw new UpgradeRequiredError(limitKey, 0, attempted);
  if (attempted > limit) throw new UpgradeRequiredError(limitKey, limit, attempted);
}

export function hasFeature(document: EntitlementDocument, feature: string): boolean {
  return document.features[feature] === true;
}

/** A route the restaurant's plan does not include. Same 402 as a limit breach. */
export class PlanExcludesError extends Error {
  readonly statusCode = 402;
  readonly code = 'upgrade_required';
  constructor(readonly requirement: string, readonly availableOn: string | null) {
    super(availableOn === null
      ? `${requirement} is not included in this restaurant's plan`
      : `${requirement} is not included in this restaurant's plan; it is available on ${availableOn}`);
    this.name = 'PlanExcludesError';
  }
}

/* ------------------------------------------------------------ read-through --- */

/**
 * The newest published document for one tenant, from the table the control
 * plane writes. Read on the caller's connection -- inside a tenant request that
 * is the request's own transaction, so a cache miss costs one indexed read and
 * no second pooled connection. `platform` carries no RLS, so the tenant GUC the
 * transaction holds changes nothing here.
 */
export async function loadLatestEntitlement(
  client: pg.ClientBase,
  tenantId: string,
): Promise<EntitlementDocument | null> {
  const result = await client.query<{
    version: string; plan_key: string; plan_version: number; status: EntitlementDocument['status'];
    limits: Record<string, number>; features: Record<string, boolean>; published_at: string;
  }>(
    `SELECT version::text, plan_key, plan_version, status, limits, features, published_at::text
       FROM platform.entitlement_document
      WHERE tenant_id = $1
      ORDER BY version DESC
      LIMIT 1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    tenantId,
    version: Number(row.version),
    planKey: row.plan_key,
    planVersion: row.plan_version,
    status: row.status,
    limits: row.limits,
    features: row.features,
    publishedAt: row.published_at,
  };
}

/**
 * ###########################################################################
 * A CACHE MISS IS FILLED FROM THE DATABASE, NOT ANSWERED WITH A REFUSAL.
 *
 * The cache is warmed at boot and every entry expires after five minutes.
 * Nothing refilled an entry after that, so a strict read would have refused
 * every gated route five minutes after each deploy, and a restaurant created
 * after boot would never have had an entry at all. The document table is the
 * truth and the cache is an optimisation of it: a miss reads the newest
 * document once and puts it back, so the database sees at most one read per
 * restaurant per TTL.
 *
 * A cache ERROR is treated the same way, for the same reason: Redis being down
 * is a reason to go to the source, not to switch off stock control for every
 * restaurant on the platform. Only a restaurant with no document at all -- no
 * live subscription has ever been published -- fails closed.
 * ###########################################################################
 */
export async function resolveEntitlement(
  cache: EntitlementCache,
  client: pg.ClientBase,
  tenantId: string,
  onCacheError?: (error: unknown) => void,
): Promise<EntitlementDocument> {
  try {
    const cached = await cache.get(tenantId);
    if (cached) return cached;
  } catch (error) {
    onCacheError?.(error);
  }
  const loaded = await loadLatestEntitlement(client, tenantId);
  if (!loaded) throw new EntitlementUnavailableError(tenantId);
  await cache.put(loaded).catch((error: unknown) => onCacheError?.(error));
  return loaded;
}

/** What the admin screens need to know about the restaurant's plan, and nothing about its price. */
export function describePlan(document: EntitlementDocument): {
  planKey: string;
  planVersion: number;
  status: EntitlementDocument['status'];
  entitlements: PlanEntitlements;
  menu: AdminMenu;
} {
  const entitlements = entitlementsFromTerms(document);
  return {
    planKey: document.planKey,
    planVersion: document.planVersion,
    status: document.status,
    entitlements,
    menu: getAdminMenu(entitlements),
  };
}
