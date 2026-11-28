import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PlanRetiredError } from './planCatalogue.js';
import { addressOf, themeColorOf } from './branding.js';
import { publishAndAnnounce } from './entitlements.js';
import { SlugInvalidError, SlugTakenError, slugProblem } from './slug.js';
import type pg from 'pg';
import { grantOwnerMemberships, seedTenantSystemRoles } from '../authz/seed.js';
import { enqueue } from '../notifications/outbox.js';
import { openSegment } from '../billing/segments.js';
import { seedAdjustmentReasons } from '../orders/adjustmentReasonSeed.js';
import { seedTaxClasses } from '../tax/taxClassSeed.js';
import { seedFloorTypes } from '../businesses/setup.js';
import { jurisdiction } from '../tax/registry.js';
import { offeredCountry } from './countries.js';
import {
  DEFAULT_BUSINESS_TYPE, isBusinessTypeKey, selectableBusinessTypes, type BusinessTypeKey,
} from '@universalpos/shared';

/**
 * Creating a tenant is one transaction: tenant + subscription + seeded roles and
 * permissions + owner invite + the owner's memberships. Partial failure creates
 * nothing.
 *
 * Runs as katkitchen_owner: it writes into schema `app` for a tenant that has no
 * session and therefore no RLS context, which is exactly the case the owner role
 * exists for.
 */

export interface ProvisionRequest {
  readonly idempotencyKey: string;
  readonly slug: string;
  readonly name: string;
  readonly currency: string;
  readonly timezone: string;
  readonly ownerEmail: string;
  readonly ownerName: string;
  readonly firstBranchName: string;
  readonly planVersionId: string;
  /**
   * ISO 3166-1 alpha-2, from the catalogue in `src/modules/tax/jurisdictions.ts`.
   *
   * #######################################################################
   * REQUIRED, WITH NO DEFAULT, ON PURPOSE.
   *
   * One product for the whole world, India launched first -- so 'IN' is by far
   * the most common answer and is exactly why it must not be the default. A
   * default here is a tenant in Dubai whose bills carry CGST and SGST, add up
   * correctly, and are discovered by an assessment; nobody would see it,
   * because the field they forgot filled itself in with the answer that is
   * usually right.
   *
   * `platform.tenant.tax_jurisdiction` is NOT NULL with no default for the
   * same reason, so this is not merely validated here -- it is unskippable.
   *
   * A `declared` jurisdiction is ACCEPTED. A restaurant may be set up before
   * its tax rules are written; what it cannot do is raise a bill, and
   * `generateBill` refuses that by name. Turning the customer away at
   * provisioning would be a worse answer than letting them build their menu.
   * #######################################################################
   */
  readonly taxJurisdiction: string;
  /**
   * The registry key of what kind of business this is (shared `BUSINESS_TYPES`).
   * Omitted means a restaurant, which is every tenant that existed before the
   * field did; the Super Admin's form always states it. A `planned` type is
   * refused: it has no workflow to run yet.
   */
  readonly businessType?: string | undefined;
  readonly requestedByPlatformUserId: string | null;
  /** The Restaurant Manager's phone, as the salesperson was given it. Optional. */
  readonly ownerPhone?: string | null | undefined;
  /** The restaurant's registered/legal name, if different from its trading name. */
  readonly legalName?: string | null | undefined;
  /**
   * How the subscription starts. `trial` (the default) is fourteen free days
   * with billing from their end; `paid` bills from today for one period of the
   * plan's billing period. Both put the first segment exactly where the period
   * says paying starts -- the dates shown and the dates billed cannot differ.
   */
  readonly startMode?: 'trial' | 'paid' | undefined;
  /** Where the restaurant is. Optional, 5 to 500 characters. */
  readonly address?: string | null | undefined;
  /** `#rrggbb`, applied to the restaurant's own admin screens. Optional. */
  readonly themeColor?: string | null | undefined;
  readonly themeColorSecondary?: string | null | undefined;
}

/** The registry key to store: absent is a restaurant, planned or unknown is refused. */
export function checkedBusinessType(value: string | undefined): BusinessTypeKey {
  if (value === undefined || value === '') return DEFAULT_BUSINESS_TYPE;
  if (!isBusinessTypeKey(value) || !selectableBusinessTypes().some((type) => type.key === value)) {
    throw new BusinessTypeUnavailableError(value);
  }
  return value;
}

export class BusinessTypeUnavailableError extends Error {
  readonly statusCode = 400;
  readonly code = 'business_type_unavailable';
  constructor(requested: string) {
    super(`business type ${JSON.stringify(requested)} cannot be selected. Selectable now: `
      + `${selectableBusinessTypes().map((type) => type.key).join(', ')}.`);
    this.name = 'BusinessTypeUnavailableError';
  }
}

export class ProvisionInputInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'provision_input_invalid';
  constructor(detail: string) {
    super(detail);
    this.name = 'ProvisionInputInvalidError';
  }
}

export interface ProvisionResult {
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly firstBranchId: string;
  readonly subscriptionId: string;
  readonly inviteToken: string | null;
  /** False when an identical request had already been fulfilled. */
  readonly created: boolean;
}

export class ProvisioningConflictError extends Error {
  /**
   * Added when `POST /tenants` was built. This refusal is the entire point of
   * hashing the request alongside the key -- "a client reusing a key with
   * different parameters must be told, not silently handed someone else's
   * tenant" -- and with no `code` the telling was `500 internal_error`, which a
   * client is entitled to read as "ours, try again", and trying again with the
   * same key produces the same 500 forever.
   */
  readonly code = 'provisioning_key_reused';
  constructor(key: string) {
    super(
      `idempotency key ${JSON.stringify(key)} was already used for a different request. ` +
        'Reusing a key with changed parameters is a bug, not a retry.',
    );
    this.name = 'ProvisioningConflictError';
  }
}

function digestOf(request: ProvisionRequest): Buffer {
  // Everything that defines the outcome. The key alone is not enough: a client
  // reusing a key with different parameters must be told, not silently handed
  // someone else's tenant.
  const canonical = JSON.stringify([
    request.slug,
    request.name,
    request.currency,
    request.timezone,
    request.ownerEmail,
    request.ownerName,
    request.firstBranchName,
    request.planVersionId,
    // In the digest, because it decides the tax on every bill the tenant will
    // ever raise. A key reused with a different jurisdiction is the clearest
    // case there is of "a retry that is not a retry".
    request.taxJurisdiction,
    // Appended only when they differ from the default, so a retry of a request
    // made before these fields existed still produces the digest it stored.
    ...(request.businessType && request.businessType !== DEFAULT_BUSINESS_TYPE ? [`type:${request.businessType}`] : []),
    ...(request.ownerPhone ? [`phone:${request.ownerPhone}`] : []),
    ...(request.startMode === 'paid' ? ['start:paid'] : []),
    ...(request.legalName ? [`legal:${request.legalName}`] : []),
    ...(request.address ? [`address:${request.address}`] : []),
    ...(request.themeColor ? [`theme:${request.themeColor}`] : []),
    ...(request.themeColorSecondary ? [`theme2:${request.themeColorSecondary}`] : []),
  ]);
  return createHash('sha256').update(canonical).digest();
}

async function existingResult(
  client: pg.ClientBase,
  request: ProvisionRequest,
): Promise<ProvisionResult | null> {
  const prior = await client.query<{ tenant_id: string; request_digest: Buffer }>(
    `SELECT tenant_id, request_digest FROM platform.provisioning_request WHERE idempotency_key = $1`,
    [request.idempotencyKey],
  );
  const row = prior.rows[0];
  if (!row) return null;

  if (!row.request_digest.equals(digestOf(request))) {
    throw new ProvisioningConflictError(request.idempotencyKey);
  }

  const owner = await client.query<{ id: string }>(
    `SELECT u.id FROM app.app_user u
      WHERE u.tenant_id = $1 AND u.email = $2`,
    [row.tenant_id, request.ownerEmail],
  );
  const branch = await client.query<{ id: string }>(
    `SELECT id FROM app.branch WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
    [row.tenant_id],
  );
  const subscription = await client.query<{ id: string }>(
    `SELECT id FROM platform.subscription WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
    [row.tenant_id],
  );

  return {
    tenantId: row.tenant_id,
    ownerUserId: owner.rows[0]!.id,
    firstBranchId: branch.rows[0]!.id,
    subscriptionId: subscription.rows[0]!.id,
    // The raw token is shown once, at creation. A retry cannot resurrect it.
    inviteToken: null,
    created: false,
  };
}

/**
 * Must be called inside a transaction owned by the caller, so the whole thing is
 * one unit including the outbox writes.
 */
export async function provisionTenant(
  client: pg.ClientBase,
  request: ProvisionRequest,
): Promise<ProvisionResult> {
  // Before the idempotency claim and before any row exists. An unknown code is
  // the caller's mistake and must not consume the key -- otherwise the fix
  // (retry with a valid code) is refused as a reused key.
  const regime = jurisdiction(request.taxJurisdiction);
  // Known is not enough: the platform must OFFER the country, and the currency
  // must be one an offered country bills in (platform settings, countries.ts).
  await offeredCountry(client, request.taxJurisdiction, request.currency);
  if (request.startMode !== undefined && request.startMode !== 'trial' && request.startMode !== 'paid') {
    throw new ProvisionInputInvalidError('startMode must be trial or paid.');
  }
  if (request.ownerPhone && !/^\+?[0-9][0-9 ()-]{5,19}$/.test(request.ownerPhone)) {
    throw new ProvisionInputInvalidError(
      'ownerPhone must be digits, with optional spaces, dashes, brackets and a leading +.');
  }

  const businessType = checkedBusinessType(request.businessType);

  // Before the idempotency claim, like the jurisdiction: a slug that could
  // never be stored is the caller's mistake and must not consume the key.
  const address = addressOf(request.address ?? undefined) ?? null;
  const themeColor = themeColorOf(request.themeColor ?? undefined) ?? null;
  const themeColorSecondary = themeColorOf(request.themeColorSecondary ?? undefined, 'themeColorSecondary') ?? null;
  const slugIssue = slugProblem(request.slug);
  if (slugIssue !== null) throw new SlugInvalidError(slugIssue);

  const prior = await existingResult(client, request);
  if (prior) return prior;

  // A sentence instead of a constraint name. Checked AFTER the replay lookup,
  // because a retried request finds its own restaurant holding the slug. The
  // unique index still decides a race between two requests -- see the catch
  // around the tenant insert below.
  // A former address of another restaurant counts as taken (0073).
  const taken = await client.query(`SELECT platform.tenant_id_for_slug($1) IS NOT NULL AS taken`, [request.slug]);
  if (taken.rows[0]!.taken) throw new SlugTakenError(request.slug);

  const tenantId = randomUUID();
  const branchId = randomUUID();
  const ownerUserId = randomUUID();
  const subscriptionId = randomUUID();
  const inviteToken = randomBytes(32).toString('base64url');

  // The UNIQUE primary key on idempotency_key is the concurrency control. Two
  // simultaneous requests with the same key cannot both proceed: the loser gets a
  // unique violation here, before any tenant exists, and re-reads the winner's
  // result. A check-then-insert in application code cannot achieve this.
  //
  // The SAVEPOINT is not optional: a unique violation aborts the whole
  // transaction in Postgres, so without it the loser could not run the SELECT
  // that reads the winner's result -- it would only be able to roll back.
  //
  // The loser's INSERT blocks until the winner commits, so by the time the
  // violation is raised the winner's row is visible to the next statement under
  // READ COMMITTED.
  await client.query('SAVEPOINT provisioning_claim');
  try {
    await client.query(
      `INSERT INTO platform.provisioning_request
         (idempotency_key, tenant_id, request_digest, requested_by_platform_user_id)
       VALUES ($1, $2, $3, $4)`,
      [request.idempotencyKey, tenantId, digestOf(request), request.requestedByPlatformUserId],
    );
    await client.query('RELEASE SAVEPOINT provisioning_claim');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT provisioning_claim');
    if ((error as { code?: string }).code === '23505') {
      const winner = await existingResult(client, request);
      if (winner) return winner;
    }
    throw error;
  }

  // The race the pre-check cannot close: two requests for one free slug. The
  // unique index lets one through; the other is told in the same words.
  try {
    await client.query(
      `INSERT INTO platform.tenant
         (id, slug, name, default_currency, default_timezone, tax_jurisdiction,
          created_by_platform_user_id, legal_name, address, theme_color, theme_color_secondary,
          business_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        tenantId,
        request.slug,
        request.name,
        request.currency,
        request.timezone,
        // The catalogue's own spelling, not the caller's. `jurisdiction` matches
        // exactly, so this is the same string -- written from the definition so
        // that a future case-insensitive match cannot store a variant the
        // database CHECK would then refuse.
        regime.code,
        request.requestedByPlatformUserId,
        request.legalName?.trim() || null,
        address,
        themeColor,
        themeColorSecondary,
        businessType,
      ],
    );
  } catch (error) {
    if ((error as { code?: string; constraint?: string }).code === '23505'
      && (error as { constraint?: string }).constraint === 'tenant_slug_key') {
      throw new SlugTakenError(request.slug);
    }
    throw error;
  }

  const planVersion = await client.query<{
    plan_id: string; plan_key: string; plan_status: string; billing_period: string;
  }>(
    `SELECT pv.plan_id, p.key AS plan_key, p.status AS plan_status, pv.billing_period
       FROM platform.plan_version pv JOIN platform.plan p ON p.id = pv.plan_id
      WHERE pv.id = $1`,
    [request.planVersionId],
  );
  const plan = planVersion.rows[0];
  if (!plan) throw new Error(`unknown plan version ${request.planVersionId}`);
  // A retired plan is no longer sold. Checked here rather than only hidden in
  // the console: the form is one caller of this route, not the only one.
  if (plan.plan_status !== 'active') throw new PlanRetiredError(plan.plan_key);

  const paid = request.startMode === 'paid';
  const subscription = await client.query<{ current_period_start: string; current_period_end: string }>(
    `INSERT INTO platform.subscription
       (id, tenant_id, plan_id, plan_version_id, status,
        current_period_start, current_period_end)
     -- Millisecond precision on purpose: the first segment is opened from a
     -- JavaScript Date built from these values, and a Date holds milliseconds.
     -- At microseconds the segment started 866us after the period it bills.
     VALUES ($1, $2, $3, $4, $5, date_trunc('milliseconds', now()),
             CASE WHEN $5 = 'trialing' THEN date_trunc('milliseconds', now()) + interval '14 days'
                  ELSE date_trunc('milliseconds', now()) + ('1 ' || $6)::interval END)
     RETURNING current_period_start, current_period_end`,
    [subscriptionId, tenantId, plan.plan_id, request.planVersionId,
     paid ? 'active' : 'trialing', plan.billing_period === 'yearly' ? 'year' : 'month'],
  );

  // #########################################################################
  // THE FIRST BILLING SEGMENT, WITHOUT WHICH NO TENANT IS EVER INVOICED.
  //
  // `generateInvoice` bills the SEGMENTS, not the subscription: it reads
  // `uninvoicedSegments` and returns null when there are none. Provisioning
  // created a subscription and no segment, so a real tenant's invoice run found
  // nothing to bill -- forever, silently, with a healthy-looking subscription
  // row. It stayed invisible because `tests/billing/billing.test.ts` inserts the
  // opening segment itself, so every billing assertion was made against a
  // series this code path had never produced.
  //
  // It starts at the END of the trial, not at signup. DECIDED: the fourteen
  // trial days are free, so they are an intentional gap in the segment series
  // rather than a segment nobody meant to charge for. The gap is safe because
  // the exclusion constraint forbids OVERLAP, not absence -- and because
  // `uninvoicedSegments` filters on `starts_at < upTo`, so the first invoice run
  // before the trial ends correctly finds nothing.
  //
  // Deliberately NOT suppressed by subscription status instead: a status gate in
  // the invoice reader would be a second place the trial rule lives, and the two
  // would have to be changed together forever.
  // #########################################################################
  await openSegment(client, {
    tenantId,
    subscriptionId,
    planId: plan.plan_id,
    planVersionId: request.planVersionId,
    quantity: 1,
    // Trial: billing starts where the free days end. Paid: it starts now, at
    // the period's own start -- the same instant the screen shows.
    at: new Date(paid
      ? subscription.rows[0]!.current_period_start
      : subscription.rows[0]!.current_period_end),
  });

  // The restaurant's first entitlement document, in the same transaction. Every
  // plan-gated route reads it; a restaurant provisioned without one would be
  // refused stock, purchasing and every report until something else happened to
  // publish, which for a restaurant nobody touches is never.
  await publishAndAnnounce(client, tenantId, 'provisioned');

  // ###########################################################################
  // THE FIRST BRANCH CANNOT ANSWER THE GST QUESTION, SO IT SAYS SO.
  //
  // `gst_registration` is NOT NULL with no default precisely so that no writer
  // can skip it, and this writer genuinely does not know the answer: the branch
  // is created by the control plane during provisioning, before the owner has
  // ever signed in, and a GSTIN is not something a signup form should be
  // guessing at.
  //
  // `unstated` is therefore correct rather than lazy, and it is not silent: it
  // behaves exactly as the system did before migration 0048 (the tax class
  // applies), the admin branches screen shows it as an unanswered question, and
  // `bill.supplier_gst_registration` records it on every document raised in the
  // meantime -- so a bill from this window can be told apart from one raised by
  // a branch that had actually declared itself unregistered.
  // ###########################################################################
  await client.query(
    // The tax it charges under is the jurisdiction's own default (0083): GST in
    // India, VAT in the UAE. The owner changes it under Printed bill.
    `INSERT INTO app.branch (id, tenant_id, code, name, timezone, gst_registration, tax_account_type)
     VALUES ($1, $2, 'MAIN', $3, $4, 'unstated', $5)`,
    [branchId, tenantId, request.firstBranchName, request.timezone, regime.defaultAccount],
  );

  await client.query(
    `INSERT INTO app.app_user (id, tenant_id, email, full_name, status)
     VALUES ($1, $2, $3, $4, 'invited')`,
    [ownerUserId, tenantId, request.ownerEmail, request.ownerName],
  );

  await seedTenantSystemRoles(client, tenantId);
  // The adjustment vocabulary. Without rows here every adjustment route refuses
  // for want of a reasonId, so void, comp, discount, recall and refund are
  // unreachable from a correctly working client.
  await seedAdjustmentReasons(client, tenantId);
  // The tax vocabulary. Without rows here `app.menu_item.tax_class_id` -- NOT
  // NULL, with a foreign key -- has nothing to point at, so a real tenant could
  // not add a single dish. Same class of gap as the reasons above and the
  // subscription segment in phase 9: a required reference nothing created.
  await seedTaxClasses(client, tenantId, regime.code);
  await seedFloorTypes(client, tenantId);
  await grantOwnerMemberships(client, {
    tenantId,
    ownerUserId,
    firstBranchId: branchId,
  });

  // Only the SHA-256 goes to the database. Superadmin cannot set a password and
  // cannot read a token back.
  await client.query(
    `INSERT INTO platform.tenant_owner_invite
       (id, tenant_id, email, token_hash, expires_at, invited_by_platform_user_id,
        invitee_name, invitee_phone)
     VALUES ($1, $2, $3, $4, now() + interval '7 days', $5, $6, $7)`,
    [
      randomUUID(),
      tenantId,
      request.ownerEmail,
      createHash('sha256').update(inviteToken).digest(),
      request.requestedByPlatformUserId,
      request.ownerName,
      request.ownerPhone || null,
    ],
  );

  // Side effects go to the outbox, never inline: an email provider outage must
  // not roll back a tenant.
  await enqueue(client, {
    topic: 'tenant.owner_invite',
    dedupeKey: `${tenantId}:owner_invite`,
    payload: { tenantId, email: request.ownerEmail, name: request.ownerName },
  });
  await enqueue(client, {
    topic: 'tenant.provisioned',
    dedupeKey: `${tenantId}:provisioned`,
    payload: { tenantId, slug: request.slug, planVersionId: request.planVersionId },
  });

  return {
    tenantId,
    ownerUserId,
    firstBranchId: branchId,
    subscriptionId,
    inviteToken,
    created: true,
  };
}
