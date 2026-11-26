/**
 * A demo tenant, so a frontend has something real to sign into.
 *
 * ###########################################################################
 * NOT A FIXTURE, AND NOT A TEST HELPER. It runs the SAME provisioning path the
 * control plane runs -- `provisionTenant` inside one owner transaction -- so a
 * developer's local tenant is shaped exactly like a real one: the ladder
 * applies, RLS applies, and the audit log has the same attribution.
 *
 * Idempotent on the slug: run it twice and it prints the existing tenant's
 * details instead of failing halfway through.
 *
 *   pnpm seed:demo
 * ###########################################################################
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import { provisionTenant } from '../../backend/src/modules/platform/provisioning.js';
import { seedPlatformAuthz } from '../../backend/src/modules/authz/seed.js';
import { hashSecret, checkPinPolicy } from '../../backend/src/modules/auth/deviceAuth.js';
import { publishEntitlement } from '../../backend/src/modules/platform/entitlements.js';
import { ensureStandardPlans } from '../../backend/src/modules/platform/planCatalogue.js';
import { env } from '../../backend/src/config/env.js';
import { hashPlatformPassword } from '../../backend/src/modules/auth/platformAuth.js';

const SLUG = process.env['DEMO_SLUG'] ?? 'spicegarden';
const EMAIL = process.env['DEMO_EMAIL'] ?? 'owner@spicegarden.test';

// No secret has a default in this repository. A value not supplied through the
// environment is generated here and shown once, at the end of the run; it is
// stored only as a hash. Re-running against a tenant that already has the
// credential does not change it, and then prints nothing for it.
const generatedPassword = (): string => randomBytes(15).toString('base64url');
function generatedPin(): string {
  for (;;) {
    const pin = String(randomInt(0, 10_000)).padStart(4, '0');
    if (!checkPinPolicy(pin, {})) return pin;
  }
}
const PASSWORD = process.env['DEMO_PASSWORD'] ?? generatedPassword();
const PIN = process.env['DEMO_PIN'] ?? generatedPin();
const created: { password: boolean; pin: boolean } = { password: false, pin: false };

// ###########################################################################
// THE LOCAL SUPER ADMIN. Its password comes from DEV_SUPER_ADMIN_PASSWORD, or is
// generated and printed once; nothing is written into this repository.
//
// A default credential in a migration would be in every production database,
// so it lives in this script only, which refuses outright when NODE_ENV says
// production. In production the first Super Admin is `seed-platform-user.mts`
// with a password someone chose.
// ###########################################################################
const DEV_SUPER_ADMIN_EMAIL = process.env['DEV_SUPER_ADMIN_EMAIL'] ?? 'superadmin@universalpos.example';

async function ensureDevSuperAdmin(owner: pg.Client): Promise<void> {
  await seedPlatformAuthz(owner);
  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key = 'super_admin'`)).rows[0]!.id;
  const existing = await owner.query(
    `SELECT 1 FROM platform.platform_user WHERE platform_role_id = $1 AND status = 'active'`, [roleId]);
  if (existing.rowCount !== 0) return;
  const password = process.env['DEV_SUPER_ADMIN_PASSWORD'] ?? generatedPassword();
  await owner.query(
    `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
     VALUES ($1, $2, $3, 'Super Admin', $4)`,
    [randomUUID(), DEV_SUPER_ADMIN_EMAIL, await hashPlatformPassword(password), roleId]);
  console.log(`created local super admin ${DEV_SUPER_ADMIN_EMAIL}`);
  if (!process.env['DEV_SUPER_ADMIN_PASSWORD']) console.log(`  super admin password (shown once) ${password}`);
}

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('seed-demo creates a development super admin and must never run in production');
  }
  const owner = new pg.Client({ connectionString: env.ownerDatabaseUrl() });
  await owner.connect();
  await ensureDevSuperAdmin(owner);
  const pool = new pg.Pool({ connectionString: env.ownerDatabaseUrl(), max: 4 });

  try {
    const existing = await owner.query<{ id: string }>(
      'SELECT id FROM platform.tenant WHERE slug = $1', [SLUG]);

    let tenantId: string;
    let branchId: string;
    let userId: string;

    if (existing.rows[0]) {
      tenantId = existing.rows[0].id;
      const found = await owner.query<{ branch_id: string; user_id: string }>(
        `SELECT b.id AS branch_id, u.id AS user_id
           FROM app.branch b
           JOIN app.app_user u ON u.tenant_id = b.tenant_id
          WHERE b.tenant_id = $1 AND u.email = $2
          ORDER BY b.created_at LIMIT 1`,
        [tenantId, EMAIL]);
      if (!found.rows[0]) throw new Error(`tenant ${SLUG} exists but its owner user does not`);
      branchId = found.rows[0].branch_id;
      userId = found.rows[0].user_id;
      console.log(`tenant ${SLUG} already provisioned`);
    } else {
      await seedPlatformAuthz(owner);
      const roleId = (await owner.query<{ id: string }>(
        `SELECT id FROM platform.platform_role WHERE key = 'super_admin'`)).rows[0]!.id;

      let superAdminId: string;
      const admin = await owner.query<{ id: string }>(
        `SELECT id FROM platform.platform_user WHERE email = 'demo-seed@platform.test'`);
      if (admin.rows[0]) {
        superAdminId = admin.rows[0].id;
      } else {
        superAdminId = randomUUID();
        await owner.query(
          `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id)
           VALUES ($1, 'demo-seed@platform.test', 'argon2id$stub', 'Demo Seeder', $2)`,
          [superAdminId, roleId]);
      }

      // The standard catalogue -- Basic, Pro, Max -- rather than a demo-only
      // plan, so a fresh local database carries exactly what is sold.
      const planVersionId = (await ensureStandardPlans(owner, superAdminId)).get('pro')!;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await provisionTenant(client, {
          idempotencyKey: `demo-${SLUG}`,
          slug: SLUG,
          name: 'Spice Garden',
          currency: 'INR',
          timezone: 'Asia/Kolkata',
          // Required, no default: see ProvisionRequest.taxJurisdiction.
          taxJurisdiction: 'IN',
          ownerEmail: EMAIL,
          ownerName: 'Meera Iyer',
          firstBranchName: 'Ground floor',
          planVersionId,
          requestedByPlatformUserId: superAdminId,
        });
        await client.query('COMMIT');
        tenantId = result.tenantId;
        branchId = result.firstBranchId;
        userId = result.ownerUserId;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      console.log(`provisioned tenant ${SLUG}`);
    }

    await owner.query(
      // A staff code, because that is what the till asks for. Without one the
      // demo owner can sign in on the admin screen and NOT on a tablet.
      `UPDATE app.app_user SET status = 'active', employee_code = $2 WHERE id = $1`,
      [userId, process.env['DEMO_STAFF_CODE'] ?? 'W1']);

    // The entitlement document, or every write path fails closed. The cache
    // warm-up at boot reads exactly this.
    const entitled = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.entitlement_document WHERE tenant_id = $1`,
      [tenantId]);
    if (Number(entitled.rows[0]!.n) === 0) {
      await publishEntitlement(owner, tenantId, 'demo seed');
      console.log('published an entitlement document');
    }

    // Credentials. The password bootstraps everything: a human has to be signed
    // in before a tablet can be handed an enrolment token.
    const pinProblem = checkPinPolicy(PIN, {});
    if (pinProblem) throw new Error(`the demo PIN is refused by policy: ${pinProblem}`);

    for (const [type, secret] of [['password', PASSWORD], ['pin', PIN]] as const) {
      const has = await owner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM app.credential
          WHERE tenant_id = $1 AND user_id = $2 AND type = $3 AND status = 'active'`,
        [tenantId, userId, type]);
      if (Number(has.rows[0]!.n) === 0) {
        await owner.query(
          `INSERT INTO app.credential (id, tenant_id, user_id, type, secret_hash)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), tenantId, userId, type, await hashSecret(secret)]);
        created[type] = true;
      }
    }

    // ##########################################################################
    // THE BRANCH SETUP, SO THE POS HAS A FLOOR AND A MENU TO SHOW.
    //
    // Written as direct inserts as the OWNER, the same posture as
    // authz/seed.ts, because Phase 2 has no domain functions to call: the
    // /admin/* routes that will own this are declared and not built. When they
    // arrive this block should be replaced by calls to them rather than kept in
    // parallel -- two ways to create a table is two ways for them to disagree.
    //
    // Idempotent per key: every insert is ON CONFLICT DO NOTHING against the
    // natural key, so re-running the seed adds nothing and breaks nothing.
    // ##########################################################################
    const one = async (sql: string, params: readonly unknown[] = []): Promise<string | null> => {
      const result = await owner.query<{ id: string }>(sql, [...params]);
      return result.rows[0]?.id ?? null;
    };

    const floorId = randomUUID();
    await owner.query(
      `INSERT INTO app.floor (id, tenant_id, branch_id, name, display_order)
       VALUES ($1, $2, $3, 'Ground floor', 1)
       ON CONFLICT DO NOTHING`,
      [floorId, tenantId, branchId]);
    const realFloorId = (await one(
      `SELECT id FROM app.floor WHERE tenant_id = $1 AND branch_id = $2 ORDER BY display_order LIMIT 1`,
      [tenantId, branchId]))!;

    // Tables. Identifiers a waiter would actually say out loud.
    const tables: Array<{ identifier: string; seats: number }> = [
      { identifier: 'T1', seats: 2 }, { identifier: 'T2', seats: 2 },
      { identifier: 'T3', seats: 4 }, { identifier: 'T4', seats: 4 },
      { identifier: 'T5', seats: 4 }, { identifier: 'T6', seats: 6 },
      { identifier: 'T7', seats: 6 }, { identifier: 'T8', seats: 8 },
    ];
    for (const table of tables) {
      await owner.query(
        `INSERT INTO app.dining_table (id, tenant_id, branch_id, floor_id, identifier, seats)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [randomUUID(), tenantId, branchId, realFloorId, table.identifier, table.seats]);
    }

    // The station VOCABULARY is tenant-level; a kitchen_station is branch-scoped
    // and resolves a code to a real screen. Both are needed or a fired line has
    // nowhere to route.
    for (const [code, name] of [['tandoor', 'Tandoor'], ['curry', 'Curry'], ['cold', 'Cold station']] as const) {
      await owner.query(
        `INSERT INTO app.station_code (tenant_id, code, name) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [tenantId, code, name]);
      await owner.query(
        `INSERT INTO app.kitchen_station (id, tenant_id, branch_id, code, name, display_order)
         VALUES ($1, $2, $3, $4, $5, 1)
         ON CONFLICT DO NOTHING`,
        [randomUUID(), tenantId, branchId, code, name]);
    }

    // One printer, and every station points at it. A station with no printer
    // means a fired KOT has nowhere to print, which the fire path refuses.
    const printerId = randomUUID();
    await owner.query(
      `INSERT INTO app.printer (id, tenant_id, branch_id, name, connection_kind, address)
       VALUES ($1, $2, $3, 'Kitchen printer', 'network', '192.168.0.50:9100')
       ON CONFLICT DO NOTHING`,
      [printerId, tenantId, branchId]);
    const realPrinterId = (await one(
      `SELECT id FROM app.printer WHERE tenant_id = $1 AND branch_id = $2 LIMIT 1`,
      [tenantId, branchId]))!;
    const stations = await owner.query<{ id: string }>(
      `SELECT id FROM app.kitchen_station WHERE tenant_id = $1 AND branch_id = $2`,
      [tenantId, branchId]);
    for (const station of stations.rows) {
      await owner.query(
        `INSERT INTO app.station_printer (tenant_id, station_id, printer_id, is_primary)
         VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING`,
        [tenantId, station.id, realPrinterId]);
    }

    // GST at 5%. The rate lives on the class and is SNAPSHOTTED onto every order
    // line, which is what makes it safe to change later. The CGST/SGST split is
    // NOT configured here: 0050 dropped app.tax_component because the split is a
    // property of the supply, decided at bill time once the place of supply is
    // known. See src/modules/tax/registry.ts.
    const taxClassId = randomUUID();
    await owner.query(
      `INSERT INTO app.tax_class (id, tenant_id, key, name, rate_bps)
       VALUES ($1, $2, 'gst_5', 'GST 5%', 500)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [taxClassId, tenantId]);
    const realTaxClassId = (await one(
      `SELECT id FROM app.tax_class WHERE tenant_id = $1 AND key = 'gst_5'`, [tenantId]))!;

    const categories: Array<[string, string, number]> = [
      ['starters', 'Starters', 1], ['mains', 'Mains', 2],
      ['breads', 'Breads', 3], ['rice', 'Rice', 4], ['desserts', 'Desserts', 5],
    ];
    const categoryIds = new Map<string, string>();
    for (const [key, name, order] of categories) {
      await owner.query(
        `INSERT INTO app.menu_category (id, tenant_id, key, name, display_order)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, key) DO NOTHING`,
        [randomUUID(), tenantId, key, name, order]);
      categoryIds.set(key, (await one(
        `SELECT id FROM app.menu_category WHERE tenant_id = $1 AND key = $2`, [tenantId, key]))!);
    }

    // Prices in PAISE, because money crosses every boundary in minor units.
    const items: Array<[string, string, string, string, number]> = [
      ['paneer_tikka',      'Paneer Tikka',        'starters', 'tandoor', 32000],
      ['chicken_tikka',     'Chicken Tikka',       'starters', 'tandoor', 38000],
      ['seekh_kebab',       'Seekh Kebab',         'starters', 'tandoor', 36000],
      ['papad_masala',      'Masala Papad',        'starters', 'cold',     9000],
      ['paneer_butter',     'Paneer Butter Masala','mains',    'curry',   34000],
      ['dal_makhani',       'Dal Makhani',         'mains',    'curry',   28000],
      ['kadai_chicken',     'Kadai Chicken',       'mains',    'curry',   42000],
      ['rogan_josh',        'Rogan Josh',          'mains',    'curry',   46000],
      ['baingan_bharta',    'Baingan Bharta',      'mains',    'curry',   30000],
      ['butter_naan',       'Butter Naan',         'breads',   'tandoor',  7000],
      ['garlic_naan',       'Garlic Naan',         'breads',   'tandoor',  8000],
      ['tandoori_roti',     'Tandoori Roti',       'breads',   'tandoor',  5000],
      ['jeera_rice',        'Jeera Rice',          'rice',     'curry',   18000],
      ['biryani_veg',       'Vegetable Biryani',   'rice',     'curry',   32000],
      ['gulab_jamun',       'Gulab Jamun',         'desserts', 'cold',    12000],
      ['kulfi',             'Pista Kulfi',         'desserts', 'cold',    14000],
    ];
    let listed = 0;
    for (const [key, name, category, station, priceMinor] of items) {
      await owner.query(
        `INSERT INTO app.menu_item
           (id, tenant_id, key, name, kind, category_id, tax_class_id, station_code, price_minor)
         VALUES ($1, $2, $3, $4, 'single', $5, $6, $7, $8)
         ON CONFLICT (tenant_id, key) DO NOTHING`,
        [randomUUID(), tenantId, key, name, categoryIds.get(category)!, realTaxClassId,
         station, priceMinor]);
      const itemId = (await one(
        `SELECT id FROM app.menu_item WHERE tenant_id = $1 AND key = $2`, [tenantId, key]))!;
      // Listing is per BRANCH and explicit: an item with no listing row reads as
      // `not_listed` rather than as available, which is the safe direction.
      await owner.query(
        `INSERT INTO app.branch_menu_listing (tenant_id, branch_id, menu_item_id, listed)
         VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING`,
        [tenantId, branchId, itemId]);
      listed += 1;
    }
    console.log(`branch setup: 1 floor, ${tables.length} tables, 3 stations, 1 printer, ${listed} menu items listed`);

    console.log('\n' + '-'.repeat(66));
    console.log('  restaurant     ', SLUG);
    console.log('  sign in at     ', `POST /api/auth/${SLUG}/login`);
    console.log('  email          ', EMAIL);
    console.log('  password       ', created.password ? PASSWORD : '(already set; not shown again)');
    console.log('  staff code     ', process.env['DEMO_STAFF_CODE'] ?? 'W1',
      '(what the TILL asks for)');
    console.log('  PIN            ', created.pin ? PIN : '(already set; not shown again)', `(user ${userId})`);
    console.log('  branch         ', branchId);
    // No setup code (Basic only, 0077): the manager signs in once on the
    // computer that will be the till, and it becomes one.
    console.log('  the till       ', `/${SLUG}/pos -- the manager's username and password, once`);
    console.log('-'.repeat(66) + '\n');
  } finally {
    await pool.end().catch(() => undefined);
    await owner.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error('seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
