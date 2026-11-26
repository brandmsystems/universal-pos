import type pg from 'pg';
import { TenantUnknownError } from './tenantAdmin.js';
import { RESERVED_SLUGS, SLUG_TAKEN_MESSAGE, slugProblem, slugify } from '@universalpos/shared';

/**
 * A restaurant's slug: its address (`/abc-restaurant`), its sign-in path
 * (`/api/auth/abc-restaurant/login`) and the first half of every tablet setup
 * code. A Super Admin may change it (`renameTenantSlug`); the old one is kept
 * in `platform.tenant_slug_history` and still resolves, so nothing that carries
 * it breaks, and no other restaurant can ever take it.
 *
 * The DATABASE is the authority on format and uniqueness -- `tenant_slug_format`
 * and the unique index `tenant_slug_key`. This module turns their refusals
 * into sentences before the insert, and adds the one rule the schema cannot
 * know: a slug may not shadow a path the site already serves.
 */

// The rules themselves -- pattern, reserved words, slugify, the messages --
// live in @universalpos/shared so the console's live check and this enforcement
// are one definition.
export { RESERVED_SLUGS, SLUG_TAKEN_MESSAGE, slugProblem, slugify };

export class SlugInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'slug_invalid';
  constructor(message: string) {
    super(message);
    this.name = 'SlugInvalidError';
  }
}

export class SlugTakenError extends Error {
  readonly statusCode = 409;
  readonly code = 'slug_taken';
  constructor(readonly slug: string) {
    super(SLUG_TAKEN_MESSAGE);
    this.name = 'SlugTakenError';
  }
}

export interface SlugAvailability {
  readonly slug: string;
  readonly available: boolean;
  /** Why not, in words, when `available` is false. */
  readonly problem: string | null;
}

/**
 * For the create form's live check. Advisory only: two people can check the
 * same free slug at once, and the unique index decides who gets it at insert.
 */
export async function slugAvailability(client: pg.ClientBase, slug: unknown): Promise<SlugAvailability> {
  const text = typeof slug === 'string' ? slug : '';
  const problem = slugProblem(text);
  if (problem !== null) return { slug: text, available: false, problem };
  const taken = await client.query(`SELECT platform.tenant_id_for_slug($1) IS NOT NULL AS taken`, [text]);
  return !taken.rows[0]!.taken
    ? { slug: text, available: true, problem: null }
    : { slug: text, available: false, problem: SLUG_TAKEN_MESSAGE };
}

export class SlugUnchangedError extends Error {
  readonly statusCode = 409;
  readonly code = 'slug_unchanged';
  constructor() {
    super('That is already this restaurant\'s address.');
    this.name = 'SlugUnchangedError';
  }
}

/**
 * A new address for a restaurant. The old one goes into the history, where it
 * keeps resolving -- links redirect, tablets sign in, setup codes redeem -- and
 * where no other restaurant can claim it. Taking back an address this same
 * restaurant had before removes it from the history.
 *
 * Nothing that grants anything changes: sessions carry the tenant id, not the
 * slug, so every signed-in screen keeps working. `assert_slug_unclaimed` (0073)
 * is the authority on uniqueness across both tables; the checks here exist to
 * answer with a sentence.
 */
export async function renameTenantSlug(
  client: pg.ClientBase,
  input: { tenantId: string; slug: unknown; renamedByPlatformUserId: string },
): Promise<{ tenantId: string; slug: string; previousSlug: string }> {
  const problem = slugProblem(input.slug);
  if (problem !== null) throw new SlugInvalidError(problem);
  const next = input.slug as string;

  const current = await client.query<{ slug: string }>(
    `SELECT slug::text AS slug FROM platform.tenant WHERE id = $1 FOR UPDATE`, [input.tenantId]);
  const row = current.rows[0];
  if (!row) throw new TenantUnknownError(input.tenantId);
  if (row.slug === next) throw new SlugUnchangedError();

  const owner = await client.query<{ tenant_id: string | null }>(
    `SELECT platform.tenant_id_for_slug($1) AS tenant_id`, [next]);
  const holder = owner.rows[0]!.tenant_id;
  if (holder !== null && holder !== input.tenantId) throw new SlugTakenError(next);

  // Back to an address of its own: it leaves the history and becomes current.
  await client.query(
    `DELETE FROM platform.tenant_slug_history WHERE slug = $1 AND tenant_id = $2`, [next, input.tenantId]);
  await client.query(
    `INSERT INTO platform.tenant_slug_history (slug, tenant_id, retired_by_platform_user_id)
     VALUES ($1, $2, $3)`,
    [row.slug, input.tenantId, input.renamedByPlatformUserId]);
  try {
    await client.query(`UPDATE platform.tenant SET slug = $2 WHERE id = $1`, [input.tenantId, next]);
  } catch (error) {
    // A concurrent rename or create won the slug between the check and here.
    if ((error as { code?: string; constraint?: string }).constraint === 'tenant_slug_key') throw new SlugTakenError(next);
    throw error;
  }
  return { tenantId: input.tenantId, slug: next, previousSlug: row.slug };
}
