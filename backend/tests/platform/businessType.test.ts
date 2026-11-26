import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  ADMIN_SECTION_KEYS, BUSINESS_TYPES, BUSINESS_TYPE_KEYS, businessTypeOf, selectableBusinessTypes,
} from '@universalpos/shared';
import { appClient, assertCheckedSet, ownerClient } from '../helpers/db.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { editTenant, BusinessTypeLockedError } from '../../src/modules/platform/tenantAdmin.js';
import { ensureStandardPlans } from '../../src/modules/platform/planCatalogue.js';
import { seedPermissionCatalogue, seedPlatformAuthz } from '../../src/modules/authz/seed.js';
import { publicRestaurantBySlug } from '../../src/modules/platform/directory.js';

/**
 * The business-type registry (shared/src/constants/businessTypes.ts) is the one
 * definition of what kinds of business exist and how each presents itself; the
 * database stores only a key. These tests hold the two together and prove the
 * rules around the key: only a selectable type can be chosen, a restaurant
 * stays the default, and the type is fixed once the business has taken orders.
 */

let owner: pg.Client;
/** The control plane edits through the application role, not the owner: the posture gate holds this file to that. */
let app: pg.Client;
let superAdminId: string;
let planVersionId: string;

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  app = appClient();
  await app.connect();
  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);
  await ensureStandardPlans(owner, null);
  planVersionId = (await owner.query<{ id: string }>(
    `SELECT pv.id FROM platform.plan_version pv JOIN platform.plan p ON p.id = pv.plan_id
      WHERE p.key = 'basic' ORDER BY pv.version DESC LIMIT 1`)).rows[0]!.id;
  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key = 'super_admin'`)).rows[0]!.id;
  superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1, $2, 'argon2id$stub', 'Root', $3)`, [superAdminId, `bt+${superAdminId}@p.test`, roleId]);
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
});

async function provision(businessType?: string): Promise<{ tenantId: string; ownerUserId: string; firstBranchId: string; slug: string }> {
  const key = `bt-${randomUUID()}`;
  const slug = `bt${key.slice(3, 11)}`;
  await owner.query('BEGIN');
  try {
    const result = await provisionTenant(owner, {
      idempotencyKey: key, slug, name: 'Type Probe', currency: 'INR', timezone: 'Asia/Kolkata',
      ownerEmail: `${key}@o.test`, ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
      taxJurisdiction: 'IN', requestedByPlatformUserId: superAdminId,
      ...(businessType === undefined ? {} : { businessType }),
    });
    await owner.query('COMMIT');
    return { ...result, slug };
  } catch (error) {
    await owner.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

const typeOf = async (tenantId: string): Promise<string> =>
  (await owner.query<{ business_type: string }>(
    `SELECT business_type FROM platform.tenant WHERE id = $1`, [tenantId])).rows[0]!.business_type;

describe('the registry is complete and internally consistent', () => {
  it('defines every key once, with every term, a theme and a nav of real sections', () => {
    assertCheckedSet({
      label: 'business types', checked: [...BUSINESS_TYPE_KEYS], minimum: 7,
      mustInclude: ['restaurant', 'general_retail', 'optical', 'salon'],
    });
    expect(Object.keys(BUSINESS_TYPES).sort()).toEqual([...BUSINESS_TYPE_KEYS].sort());
    for (const key of BUSINESS_TYPE_KEYS) {
      const type = BUSINESS_TYPES[key];
      expect(type.key, key).toBe(key);
      for (const [term, word] of Object.entries(type.terms)) expect(word.trim().length, `${key}.${term}`).toBeGreaterThan(0);
      expect(type.modules.length, `${key} modules`).toBeGreaterThan(0);
      expect(type.nav.length, `${key} nav`).toBeGreaterThan(3);
      expect(type.nav.filter((s) => !ADMIN_SECTION_KEYS.includes(s)), `${key} nav names a section that does not exist`).toEqual([]);
      expect(new Set(type.nav).size, `${key} nav lists a section twice`).toBe(type.nav.length);
      expect(type.nav, `${key} must keep the dashboard`).toContain('');
      expect(Object.keys(type.navLabels).filter((s) => !(type.nav as readonly string[]).includes(s)),
        `${key} relabels a section it does not show`).toEqual([]);
    }
    const themes = BUSINESS_TYPE_KEYS.map((key) => BUSINESS_TYPES[key].theme.id);
    expect(new Set(themes).size, 'two types share one theme id').toBe(themes.length);
  });

  it('gives every type a till workflow: a restaurant sends orders to a kitchen, every other type sells over a counter', () => {
    expect(BUSINESS_TYPES.restaurant.workflow).toBe('kitchen_order');
    for (const key of BUSINESS_TYPE_KEYS) {
      expect(['kitchen_order', 'counter_sale'], key).toContain(BUSINESS_TYPES[key].workflow);
      if (key !== 'restaurant') expect(BUSINESS_TYPES[key].workflow, key).toBe('counter_sale');
    }
    // A counter-sale type has no kitchen or open-orders section to show.
    for (const key of BUSINESS_TYPE_KEYS.filter((k) => BUSINESS_TYPES[k].workflow === 'counter_sale')) {
      expect(BUSINESS_TYPES[key].nav, key).not.toContain('kitchens');
    }
  });

  it('keeps the restaurant exactly as it was: every section, in the original order', () => {
    expect(BUSINESS_TYPES.restaurant.nav).toEqual(ADMIN_SECTION_KEYS);
    expect(BUSINESS_TYPES.restaurant.status).toBe('available');
  });

  it('gives a shop no tables and no kitchen, and a restaurant both', () => {
    expect(BUSINESS_TYPES.general_retail.nav).not.toContain('kitchens');
    expect(BUSINESS_TYPES.general_retail.nav).not.toContain('orders');
    expect(BUSINESS_TYPES.restaurant.nav).toContain('kitchens');
    expect(BUSINESS_TYPES.general_retail.terms.item).toBe('Product');
    expect(BUSINESS_TYPES.restaurant.terms.item).toBe('Dish');
  });

  it('offers only types that are not merely planned, and reads an unknown key as a restaurant', () => {
    expect(selectableBusinessTypes().map((t) => t.key)).toEqual(['restaurant', 'general_retail']);
    expect(businessTypeOf('optical').status).toBe('planned');
    expect(businessTypeOf(undefined).key).toBe('restaurant');
    expect(businessTypeOf('not-a-type').key).toBe('restaurant');
  });
});

describe('the schema lists exactly the registry keys', () => {
  it('has a CHECK equal to BUSINESS_TYPE_KEYS', async () => {
    const def = (await owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'tenant_business_type_known'`)).rows[0]?.def;
    expect(def, 'the constraint must exist').toBeDefined();
    const listed = [...def!.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
    expect(listed.sort()).toEqual([...BUSINESS_TYPE_KEYS].sort());
  });

  it('refuses a key the registry does not define (a fixture built to violate it)', async () => {
    const t = await provision();
    await expect(owner.query(`UPDATE platform.tenant SET business_type = 'bakery' WHERE id = $1`, [t.tenantId]))
      .rejects.toMatchObject({ code: '23514' });
  });
});

describe('provisioning stores the type', () => {
  it('defaults to a restaurant when none is sent, as every pre-existing tenant is', async () => {
    const t = await provision();
    expect(await typeOf(t.tenantId)).toBe('restaurant');
  });

  it('stores general retail when asked, and the public page and directory both say so', async () => {
    const t = await provision('general_retail');
    expect(await typeOf(t.tenantId)).toBe('general_retail');
    const pub = await publicRestaurantBySlug(owner, t.slug, ['active']);
    expect(pub.businessType).toBe('general_retail');
  });

  it('refuses a planned type and an unknown one by name, before anything is created', async () => {
    const before = (await owner.query<{ n: string }>(`SELECT count(*)::text AS n FROM platform.tenant`)).rows[0]!.n;
    await expect(provision('optical')).rejects.toMatchObject({ code: 'business_type_unavailable' });
    await expect(provision('bakery')).rejects.toMatchObject({ code: 'business_type_unavailable' });
    const after = (await owner.query<{ n: string }>(`SELECT count(*)::text AS n FROM platform.tenant`)).rows[0]!.n;
    expect(after).toBe(before);
  });

  it('writes the type into the idempotency digest: the same key with another type is a conflict, not a retry', async () => {
    const key = `bt-key-${randomUUID()}`;
    const base = {
      idempotencyKey: key, slug: `k${key.slice(7, 15)}`, name: 'Key Probe', currency: 'INR', timezone: 'Asia/Kolkata',
      ownerEmail: `${key}@o.test`, ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
      taxJurisdiction: 'IN', requestedByPlatformUserId: superAdminId,
    } as const;
    await owner.query('BEGIN');
    await provisionTenant(owner, { ...base, businessType: 'general_retail' });
    await owner.query('COMMIT');
    await owner.query('BEGIN');
    await expect(provisionTenant(owner, { ...base, businessType: 'restaurant' })).rejects.toMatchObject({ code: 'provisioning_key_reused' });
    await owner.query('ROLLBACK');
  });
});

describe('changing the type', () => {
  it('is allowed before the business has taken an order', async () => {
    const t = await provision();
    await app.query('BEGIN');
    const result = await editTenant(app, { tenantId: t.tenantId, businessType: 'general_retail' });
    await app.query('COMMIT');
    expect(result.businessType).toBe('general_retail');
    expect(await typeOf(t.tenantId)).toBe('general_retail');
  });

  it('refuses a planned type, and a repeat of the current type changes nothing and is refused as no change', async () => {
    const t = await provision();
    await app.query('BEGIN');
    await expect(editTenant(app, { tenantId: t.tenantId, businessType: 'salon' })).rejects.toMatchObject({ code: 'business_type_unavailable' });
    await app.query('ROLLBACK');
    await app.query('BEGIN');
    await expect(editTenant(app, { tenantId: t.tenantId, businessType: 'restaurant' })).rejects.toMatchObject({ code: 'tenant_edit_invalid' });
    await app.query('ROLLBACK');
  });

  it('is refused once an order exists, and the stored type is untouched', async () => {
    const t = await provision();
    await owner.query(
      // Closed, so the fixture leaves nothing open on the floor for another file to trip over.
      `INSERT INTO app.table_session
         (id, tenant_id, branch_id, business_date, opened_by_user_id, status, closed_at, closed_by_user_id)
       VALUES ($1, $2, $3, current_date, $4, 'closed', now(), $4)`,
      [randomUUID(), t.tenantId, t.firstBranchId, t.ownerUserId]);
    await app.query('BEGIN');
    await expect(editTenant(app, { tenantId: t.tenantId, businessType: 'general_retail' }))
      .rejects.toBeInstanceOf(BusinessTypeLockedError);
    await app.query('ROLLBACK');
    expect(await typeOf(t.tenantId)).toBe('restaurant');
  });
});
