/**
 * Ten dummy restaurants and five sales persons for local testing, on Basic and Pro, each with a floor,
 * tables, kitchens, a printer, 10 menu items and its staff -- written to the
 * REAL tables through the same provisioning the product uses, so everything
 * appears in the console, on each restaurant's /{slug} page, and behind its
 * plan gates.
 *
 * Pro restaurants get the full team (KOT Staff, Billing Staff, the kitchen);
 * Basic restaurants get the people a small shop has -- the owner bills at the
 * counter, so they also get a PIN for the Billing tablet.
 *
 *   corepack pnpm seed:dummy
 *
 * Idempotent per restaurant: a slug that already exists is skipped whole.
 * Development only; refuses to run with NODE_ENV=production.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import { provisionTenant } from '../backend/src/modules/platform/provisioning.js';
import { ensureStandardPlans } from '../backend/src/modules/platform/planCatalogue.js';
import { seedPermissionCatalogue, seedPlatformAuthz } from '../backend/src/modules/authz/seed.js';
import { hashPlatformPassword } from '../backend/src/modules/auth/platformAuth.js';
import { checkPinPolicy, hashSecret } from '../backend/src/modules/auth/deviceAuth.js';
import { env } from '../backend/src/config/env.js';

type PlanKey = 'basic' | 'pro';

// No secret has a default in this repository: each is generated per run, stored
// only as a hash, and printed once at the end. A restaurant skipped because it
// already exists keeps the secrets it was given when it was created.
const generated = (): string => randomBytes(15).toString('base64url');
const usedPins = new Set<string>();
function generatedPin(): string {
  for (;;) {
    const pin = String(randomInt(0, 10_000)).padStart(4, '0');
    if (!usedPins.has(pin) && !checkPinPolicy(pin, {})) { usedPins.add(pin); return pin; }
  }
}
const STAFF_PASSWORD = generated();
const SALES_PASSWORD = generated();
const OWNER_PIN = generatedPin();

const SALES_PERSONS = [
  { email: 'ravi@universalpos.example', fullName: 'Ravi Kumar', phone: '+91 98450 00001' },
  { email: 'anita@universalpos.example', fullName: 'Anita Sharma', phone: '+91 98450 00002' },
  { email: 'vikram@universalpos.example', fullName: 'Vikram Singh', phone: '+91 98450 00003' },
  { email: 'deepa@universalpos.example', fullName: 'Deepa Reddy', phone: '+91 98450 00004' },
  { email: 'farhan@universalpos.example', fullName: 'Farhan Ali', phone: '+91 98450 00005' },
] as const;

const RESTAURANTS: ReadonlyArray<{
  seq: number; slug: string; name: string; plan: PlanKey; city: string; paid: boolean;
}> = [
  { seq: 1, slug: 'spice-garden-blr', name: 'Spice Garden Bengaluru', plan: 'basic', city: 'Bengaluru', paid: false },
  { seq: 2, slug: 'tandoori-nights', name: 'Tandoori Nights', plan: 'pro', city: 'Delhi', paid: true },
  { seq: 3, slug: 'coastal-curry-house', name: 'Coastal Curry House', plan: 'pro', city: 'Mangaluru', paid: true },
  { seq: 4, slug: 'dosa-corner', name: 'Dosa Corner', plan: 'basic', city: 'Chennai', paid: false },
  { seq: 5, slug: 'biryani-bay', name: 'Biryani Bay', plan: 'pro', city: 'Hyderabad', paid: false },
  { seq: 6, slug: 'punjab-grill-house', name: 'Punjab Grill House', plan: 'pro', city: 'Amritsar', paid: true },
  { seq: 7, slug: 'chai-and-chaat', name: 'Chai & Chaat', plan: 'basic', city: 'Jaipur', paid: true },
  { seq: 8, slug: 'malabar-kitchen', name: 'Malabar Kitchen', plan: 'pro', city: 'Kochi', paid: true },
  { seq: 9, slug: 'royal-thali', name: 'Royal Thali', plan: 'pro', city: 'Udaipur', paid: false },
  { seq: 10, slug: 'green-leaf-cafe', name: 'Green Leaf Cafe', plan: 'basic', city: 'Pune', paid: false },
];

const MENU: ReadonlyArray<readonly [key: string, name: string, category: string, station: string, priceMinor: number]> = [
  ['paneer_tikka', 'Paneer Tikka', 'starters', 'tandoor', 24900],
  ['chicken_65', 'Chicken 65', 'starters', 'tandoor', 27900],
  ['masala_dosa', 'Masala Dosa', 'mains', 'curry', 14900],
  ['chicken_biryani', 'Chicken Biryani', 'mains', 'curry', 32900],
  ['dal_makhani', 'Dal Makhani', 'mains', 'curry', 22900],
  ['butter_naan', 'Butter Naan', 'breads', 'tandoor', 6900],
  ['veg_pulao', 'Veg Pulao', 'mains', 'curry', 19900],
  ['gulab_jamun', 'Gulab Jamun', 'desserts', 'cold', 9900],
  ['mango_lassi', 'Mango Lassi', 'beverages', 'cold', 11900],
  ['masala_chai', 'Masala Chai', 'beverages', 'cold', 4900],
];

const CATEGORIES: ReadonlyArray<readonly [string, string]> = [
  ['starters', 'Starters'], ['mains', 'Mains'], ['breads', 'Breads'],
  ['desserts', 'Desserts'], ['beverages', 'Beverages'],
];

/**
 * Row 1 is the manager provisioning already created. `cashier` is shown as
 * Billing Staff and `waiter` as KOT Staff; `kds` is the kitchen screen. The last
 * column says which plans get the person: a Basic shop has no KOT staff or
 * kitchen screen.
 */
const STAFF: ReadonlyArray<readonly [name: string, role: string, code: string, login: 'password' | 'pin', pin: string, proOnly: boolean]> = [
  ['Meera Iyer', 'owner', 'OWN1', 'password', '', false],
  ['Arjun Rao', 'branch_admin', 'ADM1', 'password', '', false],
  ['Kavya Nair', 'manager', 'MGR1', 'password', '', false],
  ['Rahul Verma', 'cashier', 'C1', 'pin', generatedPin(), false],
  ['Sneha Patil', 'cashier', 'C2', 'pin', generatedPin(), true],
  ['Imran Khan', 'waiter', 'W1', 'pin', generatedPin(), true],
  ['Priya Das', 'waiter', 'W2', 'pin', generatedPin(), true],
  ['Suresh Kumar', 'kds', 'K1', 'pin', generatedPin(), true],
  ['Lakshmi Menon', 'kds', 'K2', 'pin', generatedPin(), true],
];

const phone = (prefix: string, seq: number, i: number): string =>
  `+91 ${prefix}${String(seq * 100 + i).padStart(8, '0')}`;

async function ensureSalesPersons(owner: pg.Client): Promise<string[]> {
  const role = await owner.query<{ id: string }>(`SELECT id FROM platform.platform_role WHERE key = 'sales'`);
  const ids: string[] = [];
  for (const person of SALES_PERSONS) {
    const found = await owner.query<{ id: string }>(
      `SELECT id FROM platform.platform_user WHERE email = $1`, [person.email]);
    if (found.rows[0]) { ids.push(found.rows[0].id); continue; }
    const id = randomUUID();
    await owner.query(
      `INSERT INTO platform.platform_user (id, email, password_hash, full_name, platform_role_id, phone)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, person.email, await hashPlatformPassword(SALES_PASSWORD), person.fullName, role.rows[0]!.id, person.phone]);
    ids.push(id);
    console.log(`sales person ${person.email}`);
  }
  return ids;
}

async function seedRestaurant(
  owner: pg.Client,
  pool: pg.Pool,
  r: (typeof RESTAURANTS)[number],
  planVersionId: string,
  salesPersonId: string,
): Promise<void> {
  const exists = await owner.query(`SELECT 1 FROM platform.tenant WHERE slug = $1`, [r.slug]);
  if (exists.rowCount) { console.log(`skip ${r.slug}: already exists`); return; }

  const managerEmail = `manager@${r.slug}.example`;
  const client = await pool.connect();
  let tenantId: string, branchId: string, ownerId: string;
  try {
    await client.query('BEGIN');
    const made = await provisionTenant(client, {
      idempotencyKey: `dummy-${r.slug}`,
      slug: r.slug,
      name: r.name,
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      taxJurisdiction: 'IN',
      ownerEmail: managerEmail,
      ownerName: STAFF[0]![0],
      ownerPhone: phone('98', r.seq, 1),
      firstBranchName: `${r.city} main`,
      planVersionId,
      startMode: r.paid ? 'paid' : 'trial',
      requestedByPlatformUserId: salesPersonId,
    });
    await client.query('COMMIT');
    tenantId = made.tenantId; branchId = made.firstBranchId; ownerId = made.ownerUserId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const q = (sql: string, params: readonly unknown[]) => owner.query(sql, [...params]);
  const idOf = async (sql: string, params: readonly unknown[]): Promise<string> =>
    (await owner.query<{ id: string }>(sql, [...params])).rows[0]!.id;

  await q(`UPDATE platform.tenant_owner_invite
              SET status = 'accepted', accepted_at = now(), accepted_user_id = $2
            WHERE tenant_id = $1 AND status = 'pending'`, [tenantId, ownerId]);

  // Setup the menu needs: floor, tables, kitchens, a printer, a tax class, categories.
  const floorId = randomUUID();
  await q(`INSERT INTO app.floor (id, tenant_id, branch_id, name, display_order) VALUES ($1, $2, $3, 'Ground floor', 1)`,
    [floorId, tenantId, branchId]);
  for (let t = 1; t <= 8; t++) {
    await q(`INSERT INTO app.dining_table (id, tenant_id, branch_id, floor_id, identifier, seats) VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), tenantId, branchId, floorId, `T${t}`, t <= 2 ? 2 : t <= 6 ? 4 : 6]);
  }
  const printerId = randomUUID();
  await q(`INSERT INTO app.printer (id, tenant_id, branch_id, name, connection_kind, address)
           VALUES ($1, $2, $3, 'Kitchen printer', 'network', '192.168.0.50:9100')`, [printerId, tenantId, branchId]);
  for (const [code, name] of [['tandoor', 'Tandoor'], ['curry', 'Curry'], ['cold', 'Cold station']] as const) {
    await q(`INSERT INTO app.station_code (tenant_id, code, name) VALUES ($1, $2, $3)`, [tenantId, code, name]);
    const stationId = randomUUID();
    await q(`INSERT INTO app.kitchen_station (id, tenant_id, branch_id, code, name, display_order) VALUES ($1, $2, $3, $4, $5, 1)`,
      [stationId, tenantId, branchId, code, name]);
    await q(`INSERT INTO app.station_printer (tenant_id, station_id, printer_id, is_primary) VALUES ($1, $2, $3, true)`,
      [tenantId, stationId, printerId]);
  }
  await q(`INSERT INTO app.tax_class (id, tenant_id, key, name, rate_bps) VALUES ($1, $2, 'gst_5', 'GST 5%', 500)
           ON CONFLICT (tenant_id, key) DO NOTHING`, [randomUUID(), tenantId]);
  const taxClassId = await idOf(`SELECT id FROM app.tax_class WHERE tenant_id = $1 AND key = 'gst_5'`, [tenantId]);
  const categoryIds = new Map<string, string>();
  for (const [i, [key, name]] of CATEGORIES.entries()) {
    const id = randomUUID();
    await q(`INSERT INTO app.menu_category (id, tenant_id, key, name, display_order) VALUES ($1, $2, $3, $4, $5)`,
      [id, tenantId, key, name, i + 1]);
    categoryIds.set(key, id);
  }

  // 10 menu items, listed at the branch.
  for (const [key, name, category, station, priceMinor] of MENU) {
    const id = randomUUID();
    await q(`INSERT INTO app.menu_item (id, tenant_id, key, name, kind, category_id, tax_class_id, station_code, price_minor)
             VALUES ($1, $2, $3, $4, 'single', $5, $6, $7, $8)`,
      [id, tenantId, key, name, categoryIds.get(category)!, taxClassId, station, priceMinor]);
    await q(`INSERT INTO app.branch_menu_listing (tenant_id, branch_id, menu_item_id, listed) VALUES ($1, $2, $3, true)`,
      [tenantId, branchId, id]);
  }

  // Staff, each holding their role at the right scope, with their own secret.
  const roleIds = new Map((await owner.query<{ key: string; id: string; assignable_scope: string }>(
    `SELECT key, id, assignable_scope FROM app.role WHERE tenant_id = $1`, [tenantId])).rows
    .map((row) => [row.key, row] as const));
  const credential = async (userId: string, type: 'password' | 'pin', secret: string): Promise<void> => {
    await q(`INSERT INTO app.credential (id, tenant_id, user_id, type, secret_hash) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenantId, userId, type, await hashSecret(secret)]);
  };
  for (const [i, [name, role, code, login, pin, proOnly]] of STAFF.entries()) {
    if (proOnly && r.plan !== 'pro') continue;
    const staffPhone = phone('98', r.seq, i + 1);
    const email = login === 'password' ? `${code.toLowerCase()}@${r.slug}.example` : null;
    let userId: string;
    if (role === 'owner') {
      userId = ownerId;
      await q(`UPDATE app.app_user SET status = 'active', employee_code = $2, phone = $3 WHERE id = $1`,
        [userId, code, staffPhone]);
      // The owner also bills at the counter (provisioning gave them Billing at
      // the first branch), and the Billing tablet takes a code and PIN.
      await credential(userId, 'pin', OWNER_PIN);
    } else {
      userId = randomUUID();
      await q(`INSERT INTO app.app_user (id, tenant_id, email, phone, full_name, employee_code, status)
               VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
        [userId, tenantId, email, staffPhone, name, code]);
      const held = roleIds.get(role)!;
      const scopeBranch = held.assignable_scope === 'tenant_only' ? null : branchId;
      await q(`INSERT INTO app.membership (id, tenant_id, user_id, branch_id, role_id, role_assignable_scope, granted_by_user_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), tenantId, userId, scopeBranch, held.id, held.assignable_scope, ownerId]);
    }
    if (login === 'password') {
      await credential(userId, 'password', STAFF_PASSWORD);
    } else {
      const refused = checkPinPolicy(pin, { employeeCode: code, phone: staffPhone });
      if (refused) throw new Error(`PIN for ${code} refused by policy: ${refused}`);
      await credential(userId, 'pin', pin);
    }
  }

  console.log(`${r.slug.padEnd(22)} ${r.plan.padEnd(5)}  10 menu items, 8 tables, 3 kitchens, ${r.plan === 'pro' ? 9 : 4} staff`);
}

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') throw new Error('seed-dummy is for local development only');
  const owner = new pg.Client({ connectionString: env.ownerDatabaseUrl() });
  await owner.connect();
  const pool = new pg.Pool({ connectionString: env.ownerDatabaseUrl(), max: 4 });
  try {
    await seedPermissionCatalogue(owner);
    await seedPlatformAuthz(owner);
    const salesIds = await ensureSalesPersons(owner);
    const versions = await ensureStandardPlans(owner, salesIds[0]!);
    for (const r of RESTAURANTS) {
      await seedRestaurant(owner, pool, r, versions.get(r.plan)!, salesIds[(r.seq - 1) % salesIds.length]!);
    }

    const counts = await owner.query<{ slug: string; menu: string; staff: string }>(
      `SELECT t.slug,
              (SELECT count(*) FROM app.menu_item m WHERE m.tenant_id = t.id)::text AS menu,
              (SELECT count(*) FROM app.app_user u WHERE u.tenant_id = t.id)::text AS staff
         FROM platform.tenant t WHERE t.slug = ANY($1) ORDER BY t.slug`,
      [RESTAURANTS.map((r) => r.slug)]);
    const short = counts.rows.filter((c) => Number(c.menu) < 10 || Number(c.staff) < 4);
    if (counts.rowCount !== RESTAURANTS.length || short.length > 0) {
      throw new Error(`seed incomplete: ${JSON.stringify(short.length ? short : counts.rows)}`);
    }

    console.log('\n' + '-'.repeat(70));
    console.log('  Sales Persons   ', SALES_PERSONS.map((p) => p.email).join(', '), `/ ${SALES_PASSWORD}`);
    console.log('  Restaurant URL   http://127.0.0.1:9180/<slug>  (admin)');
    console.log('                   /<slug>/kot  /<slug>/kds  /<slug>/billing  (tablets)');
    console.log(`  Password logins  manager@ | adm1@ | mgr1@ <slug>.example / ${STAFF_PASSWORD}`);
    console.log(`  PIN logins       owner OWN1 ${OWNER_PIN}`);
    console.log('                   staff PINs are generated per person and are not printed; reset one from the console');
    console.log('-'.repeat(70));
  } finally {
    await pool.end().catch(() => undefined);
    await owner.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error('seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
