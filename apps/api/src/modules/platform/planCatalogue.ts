import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  ENTITLEMENTS, PLAN_FEATURE_KEYS, PLAN_LIMITS, planTermsFor, type PlanKey,
} from '@katkitchen/shared';

/**
 * The plan catalogue that is SOLD: Basic, Standard and Pro.
 *
 * ###########################################################################
 * THIS IS THE SEED, NOT A CEILING ON WHAT THE TABLE MAY HOLD.
 *
 * `ensureStandardPlans` creates the three plans and their first version once,
 * idempotently, keyed on `plan.key`. After that the price is data: a Super
 * Admin publishes version 2 from the console, and this constant is not edited
 * to match -- editing it would change nothing in an existing database, which
 * is exactly the drift that makes a constant lie. A new version never rewrites
 * a subscription already sold on the old one (see `directory.ts`, listPlans).
 *
 * The limit and feature keys are the ones the product ENFORCES, not names made
 * up for a pricing page: each is read by a route's `plan` gate (routeRegistry)
 * and by the admin menu, through `ENTITLEMENTS` in packages/shared. An absent
 * key denies, so every plan states every key explicitly -- `validTerms` refuses
 * a version that leaves one out.
 * ###########################################################################
 */
export interface PlanTerms {
  readonly priceMinor: number;
  readonly currency: string;
  readonly billingPeriod: 'monthly' | 'yearly';
  readonly limits: Readonly<Record<string, number>>;
  readonly features: Readonly<Record<string, boolean>>;
}

const DESCRIPTIONS: Readonly<Record<PlanKey, { name: string; description: string; priceMinor: number }>> = {
  basic: { name: 'Basic', description: 'One outlet with KOT, printed kitchen tickets and Billing.', priceMinor: 99_900 },
  standard: { name: 'Standard', description: 'One outlet with KOT Staff, printed kitchen tickets, Billing Staff and reports.', priceMinor: 179_900 },
  pro: { name: 'Pro', description: 'Up to three outlets with KOT Staff, the kitchen screen, Billing Staff and reports.', priceMinor: 249_900 },
};

export const STANDARD_PLANS: readonly ({
  readonly key: string; readonly name: string; readonly description: string;
} & PlanTerms)[] = (Object.keys(ENTITLEMENTS) as PlanKey[]).map((key) => ({
  key,
  name: DESCRIPTIONS[key].name,
  description: DESCRIPTIONS[key].description,
  priceMinor: DESCRIPTIONS[key].priceMinor,
  currency: 'INR',
  billingPeriod: 'monthly' as const,
  ...planTermsFor(ENTITLEMENTS[key]),
}));

export async function ensureStandardPlans(
  client: pg.ClientBase,
  createdByPlatformUserId: string | null,
): Promise<ReadonlyMap<string, string>> {
  const versionByKey = new Map<string, string>();
  for (const plan of STANDARD_PLANS) {
    await client.query(
      `INSERT INTO platform.plan (id, key, name, description) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO NOTHING`,
      [randomUUID(), plan.key, plan.name, plan.description]);
    const planId = (await client.query<{ id: string }>(
      `SELECT id FROM platform.plan WHERE key = $1`, [plan.key])).rows[0]!.id;
    await client.query(
      `INSERT INTO platform.plan_version
         (id, plan_id, version, price_minor, currency, billing_period, limits, features,
          published_at, created_by_platform_user_id)
       VALUES ($1, $2, 1, $3, $4, $5, $6::jsonb, $7::jsonb, now(), $8)
       ON CONFLICT (plan_id, version) DO NOTHING`,
      [randomUUID(), planId, plan.priceMinor, plan.currency, plan.billingPeriod,
       JSON.stringify(plan.limits), JSON.stringify(plan.features), createdByPlatformUserId]);
    const latest = await client.query<{ id: string }>(
      `SELECT id FROM platform.plan_version
        WHERE plan_id = $1 AND published_at IS NOT NULL
        ORDER BY version DESC LIMIT 1`, [planId]);
    versionByKey.set(plan.key, latest.rows[0]!.id);
  }
  return versionByKey;
}

/* ----------------------------------------------------- new plan version --- */

export class PlanUnknownError extends Error {
  readonly statusCode = 404;
  readonly code = 'plan_unknown';
  constructor(planId: string) {
    super(`no plan has the id ${planId}`);
    this.name = 'PlanUnknownError';
  }
}

export class PlanRetiredError extends Error {
  readonly statusCode = 409;
  readonly code = 'plan_retired';
  constructor(key: string) {
    super(`plan ${key} is inactive: it is no longer sold and takes no new versions.`);
    this.name = 'PlanRetiredError';
  }
}

export class PlanTermsInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'plan_terms_invalid';
  constructor(detail: string) {
    super(`plan terms refused: ${detail}`);
    this.name = 'PlanTermsInvalidError';
  }
}

/**
 * Validated here, not left to the CHECKs, for the jsonb columns the schema
 * cannot see into: a limit of "ten" or a feature of 1 would be stored, then
 * read by `assertWithinLimit` as absent -- a plan that denies the thing it was
 * sold with. Money is an integer of minor units, never a float.
 */
function validTerms(input: Partial<PlanTerms>): PlanTerms {
  const { priceMinor, currency, billingPeriod, limits, features } = input;
  if (typeof priceMinor !== 'number' || !Number.isInteger(priceMinor) || priceMinor < 0) {
    throw new PlanTermsInvalidError('priceMinor must be a whole number of minor units, 0 or more');
  }
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new PlanTermsInvalidError('currency must be a three-letter code');
  }
  if (billingPeriod !== 'monthly' && billingPeriod !== 'yearly') {
    throw new PlanTermsInvalidError('billingPeriod must be monthly or yearly');
  }
  const cleanLimits: Record<string, number> = {};
  for (const [key, value] of Object.entries(limits ?? {})) {
    if (!/^[a-z][a-z0-9_.]*$/.test(key) || typeof value !== 'number'
      || !Number.isInteger(value) || value < 0) {
      throw new PlanTermsInvalidError(`limit ${key} must be a whole number, 0 or more`);
    }
    cleanLimits[key] = value;
  }
  const cleanFeatures: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(features ?? {})) {
    if (!/^[a-z][a-z0-9_.]*$/.test(key) || typeof value !== 'boolean') {
      throw new PlanTermsInvalidError(`feature ${key} must be true or false`);
    }
    cleanFeatures[key] = value;
  }
  // Absence denies, so a version missing a key would quietly take the thing
  // away from every restaurant moved onto it. Refused here, where a Super Admin
  // is looking at the form, rather than discovered as a 402 in a kitchen.
  const missing = [
    ...PLAN_LIMITS.filter((key) => cleanLimits[key] === undefined).map((key) => `limit ${key}`),
    ...PLAN_FEATURE_KEYS.filter((key) => cleanFeatures[key] === undefined).map((key) => `feature ${key}`),
  ];
  if (missing.length > 0) {
    throw new PlanTermsInvalidError(`every plan must state ${missing.join(', ')}`);
  }
  return { priceMinor, currency, billingPeriod, limits: cleanLimits, features: cleanFeatures };
}

/**
 * Publish the next version of a plan. The earlier versions stay exactly as they
 * were, with every subscription still on them: that is the whole reason a
 * price is versioned rather than edited.
 */
export async function publishPlanVersion(
  client: pg.ClientBase,
  input: { planId: string; terms: Partial<PlanTerms>; publishedByPlatformUserId: string },
): Promise<{ planVersionId: string; version: number }> {
  const terms = validTerms(input.terms);
  const plan = await client.query<{ key: string; status: string }>(
    `SELECT key, status FROM platform.plan WHERE id = $1 FOR UPDATE`, [input.planId]);
  const row = plan.rows[0];
  if (!row) throw new PlanUnknownError(input.planId);
  if (row.status !== 'active') throw new PlanRetiredError(row.key);

  const next = await client.query<{ next: number }>(
    `SELECT COALESCE(max(version), 0) + 1 AS next FROM platform.plan_version WHERE plan_id = $1`,
    [input.planId]);
  const version = next.rows[0]!.next;
  const id = randomUUID();
  await client.query(
    `INSERT INTO platform.plan_version
       (id, plan_id, version, price_minor, currency, billing_period, limits, features,
        published_at, created_by_platform_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, now(), $9)`,
    [id, input.planId, version, terms.priceMinor, terms.currency, terms.billingPeriod,
     JSON.stringify(terms.limits), JSON.stringify(terms.features),
     input.publishedByPlatformUserId]);
  return { planVersionId: id, version };
}

/* ------------------------------------------------------- active/inactive --- */

export class PlanStatusInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'plan_status_invalid';
  constructor() {
    super('status must be active or retired.');
    this.name = 'PlanStatusInvalidError';
  }
}

/**
 * A retired plan stops being SOLD: no new restaurant is provisioned on it and
 * it takes no new version. Restaurants already on it keep it -- a subscription
 * points at a version, and retiring a plan with customers on it is a
 * migration, not a switch.
 */
export async function setPlanStatus(
  client: pg.ClientBase,
  input: { planId: string; status: unknown },
): Promise<{ planId: string; status: 'active' | 'retired' }> {
  if (input.status !== 'active' && input.status !== 'retired') throw new PlanStatusInvalidError();
  const updated = await client.query(
    `UPDATE platform.plan SET status = $2 WHERE id = $1`, [input.planId, input.status]);
  if (updated.rowCount === 0) throw new PlanUnknownError(input.planId);
  return { planId: input.planId, status: input.status };
}
