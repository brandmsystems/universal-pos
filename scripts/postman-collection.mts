/**
 * Writes a Postman collection (v2.1) of every API route, plus a local
 * environment, into docs/postman/.
 *
 * Generated FROM the route table, not written beside it: a hand-kept
 * collection is a list sitting next to something that expands, and the first
 * route added after it was written would be missing from it. Re-run after
 * adding a route:  corepack pnpm postman
 *
 * The route table supplies method, URL, plane, permission key and lease; the
 * EXAMPLES map below supplies a sample body or query for the routes people
 * actually try by hand. A route with no example still appears, with an empty
 * body where it takes one.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allRoutes } from '../apps/api/src/routes/index.js';
import type { RouteDefinition } from '../apps/api/src/core/middleware/routeRegistry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'postman');

type Example = { body?: unknown; query?: Record<string, string>; capture?: string; note?: string };

/** Keyed `METHOD url` exactly as the route table spells it. */
const EXAMPLES: Record<string, Example> = {
  // ---- auth -----------------------------------------------------------------
  'POST /api/auth/platform/login': {
    body: { email: '{{platformEmail}}', password: '{{platformPassword}}' },
    capture: "pm.collectionVariables.set('platformToken', b.accessToken); pm.collectionVariables.set('platformRefreshToken', b.refreshToken);",
    note: 'Super Admin or Sales Person sign-in. Saves {{platformToken}} for every Platform request.',
  },
  'POST /api/auth/platform/refresh': {
    body: { refreshToken: '{{platformRefreshToken}}' },
    capture: "pm.collectionVariables.set('platformToken', b.accessToken); pm.collectionVariables.set('platformRefreshToken', b.refreshToken);",
  },
  'POST /api/auth/platform/password': {
    body: { email: '{{platformEmail}}', currentPassword: '{{platformPassword}}', newPassword: 'a-new-password-2026' },
  },
  'POST /api/auth/:tenantSlug/login': {
    body: { email: '{{restaurantEmail}}', password: '{{restaurantPassword}}' },
    capture: "pm.collectionVariables.set('tenantToken', b.accessToken); pm.collectionVariables.set('tenantRefreshToken', b.refreshToken);",
    note: 'Restaurant Manager / admin sign-in. Saves {{tenantToken}} for every Restaurant, POS and KDS request.',
  },
  'POST /api/auth/:tenantSlug/pin': {
    body: { employeeCode: 'W1', pin: '4816', deviceFingerprint: '{{deviceFingerprint}}' },
    capture: "pm.collectionVariables.set('tenantToken', b.accessToken); pm.collectionVariables.set('tenantRefreshToken', b.refreshToken);",
    note: 'Staff PIN sign-in on an ENROLLED tablet: deviceFingerprint must be the one used at enrolment.',
  },
  'POST /api/auth/refresh': {
    body: { refreshToken: '{{tenantRefreshToken}}' },
    capture: "pm.collectionVariables.set('tenantToken', b.accessToken); pm.collectionVariables.set('tenantRefreshToken', b.refreshToken);",
  },
  'POST /api/auth/invite/accept': {
    body: { token: '{{inviteToken}}', password: '{{restaurantPassword}}' },
    note: 'The manager sets their password from a setup link. {{inviteToken}} is saved by "Create restaurant".',
  },

  // ---- platform ---------------------------------------------------------------
  'GET /tenants/slug-available': { query: { slug: 'abc-restaurant' } },
  'POST /tenants': {
    body: {
      slug: 'abc-restaurant', name: 'ABC Restaurant', legalName: 'ABC Foods Pvt Ltd',
      currency: 'INR', timezone: 'Asia/Kolkata',
      ownerName: 'Meera Iyer', ownerEmail: 'manager@abc-restaurant.com', ownerPhone: '+91 98450 12345',
      firstBranchName: 'Main branch', planVersionId: '{{planVersionId}}',
      startMode: 'trial', taxJurisdiction: 'IN',
      address: '12 MG Road, Bengaluru 560001', themeColor: '#1d4ed8',
    },
    capture: "pm.collectionVariables.set('tenantId', b.tenantId); pm.collectionVariables.set('subscriptionId', b.subscriptionId); pm.collectionVariables.set('inviteToken', b.inviteToken); pm.collectionVariables.set('tenantSlug', JSON.parse(pm.request.body.raw).slug);",
    note: 'Create restaurant. Needs {{planVersionId}} (run "GET /plans" first). Saves {{tenantId}}, {{tenantSlug}}, {{subscriptionId}} and {{inviteToken}}.',
  },
  'PATCH /tenants/:id': {
    body: { name: 'ABC Restaurant & Bar', legalName: 'ABC Foods Pvt Ltd', address: '12 MG Road, Bengaluru', themeColor: '#1d4ed8' },
  },
  'POST /tenants/:id/logo': {
    body: { contentType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
    note: 'PNG, JPEG or WebP, base64, up to 256 KB. The file bytes must match the type.',
  },
  'POST /tenants/:id/deactivate': { body: { reason: 'Customer asked to pause the account' } },
  'POST /tenants/:id/reactivate': { body: { reason: 'Customer resumed' } },
  'POST /tenants/:id/owner-invite': {
    body: { reason: 'Manager forgot password' },
    capture: "pm.collectionVariables.set('inviteToken', b.inviteToken);",
    note: 'New setup link. "reason" is required only once the manager has already signed up (it is then a password reset).',
  },
  'GET /plans': {
    capture: "const basic = (b.plans ?? b).find?.((p) => p.key === 'basic'); if (basic) { pm.collectionVariables.set('planId', basic.planId); const v = [...basic.versions].sort((x, y) => y.version - x.version)[0]; if (v) pm.collectionVariables.set('planVersionId', v.planVersionId); }",
    note: 'Saves the Basic plan\'s id and newest version as {{planId}} / {{planVersionId}}.',
  },
  'POST /plans/:id/versions': {
    body: {
      priceMinor: 109900, currency: 'INR', billingPeriod: 'monthly',
      limits: { branches: 1, devices: 2 },
      features: { kot: false, reports_advanced: false },
    },
    note: 'Every plan key must be stated; a version missing one is refused (400 plan_terms_invalid).',
  },
  'POST /plans/:id/status': { body: { status: 'retired' } },
  'POST /users': {
    body: { fullName: 'Ravi Kumar', email: 'ravi@katkitchen.com', phone: '+91 98450 00000', password: 'ravi-sales-2026!', roleKey: 'sales' },
    note: 'Create a Sales Person (roleKey sales) or other platform staff.',
  },
  'PATCH /users/:id': { body: { fullName: 'Ravi Kumar', email: 'ravi@katkitchen.com', phone: '+91 98450 00000' } },
  'POST /users/:id/status': { body: { status: 'suspended' } },
  'POST /users/:id/password': { note: 'Resets a platform user\'s password; the new one is returned once.' },
  'POST /subscriptions/:id/renew': { body: { periods: 1 } },
  'POST /subscriptions/:id/change': {
    body: { planVersionId: '{{planVersionId}}' },
    note: 'Upgrade applies now; a downgrade is scheduled for the end of the period.',
  },
  'POST /dunning/:tenantId/outreach': { body: { channel: 'phone', note: 'Called the owner about the overdue invoice' } },
  'POST /impersonation': {
    body: { tenantSlug: '{{tenantSlug}}', reasonCode: 'support_ticket', reasonDetail: 'Ticket #123: menu not loading' },
  },
  'POST /tenants/:id/tax-exemption': { body: { isSez: true, lutNumber: 'AD2903260012345', evidence: 'LUT copy checked on file' } },

  // ---- restaurant admin ---------------------------------------------------------
  'POST /admin/branches': {
    body: { code: 'B2', name: 'Airport', timezone: 'Asia/Kolkata', business_day_starts_at: '04:00', gst_registration: 'unregistered' },
    note: 'Limited by plan: Basic 1, Pro 3 (402 upgrade_required beyond it).',
  },
  'PATCH /admin/branches/:id': { body: { name: 'Airport T2' } },
  'POST /admin/sessions/:id/reopen': {
    body: { reason: 'Customer added a dessert' },
    note: 'Manager: sends a handed-over order back to KOT. Refused once a bill exists.',
  },
  'GET /admin/reports/sales': { query: { from: '2026-09-01', to: '2026-09-30', dimensions: 'hour,item', payments: '1', compare: 'previous' } },
  'GET /admin/reports/sales/export': { query: { from: '2026-09-01', to: '2026-09-30' } },
  'GET /admin/reports/staff': { query: { from: '2026-09-01', to: '2026-09-30' } },
  'GET /admin/reports/exception': { query: { from: '2026-09-01', to: '2026-09-30' } },
  'GET /admin/reports/tax/outward-supply': { query: { from: '2026-09-01', to: '2026-09-30' } },
  'GET /admin/entitlements': { note: 'What this restaurant\'s plan includes, and the admin menu it implies.' },

  // ---- KOT, kitchen and Billing ---------------------------------------------------
  'POST /pos/session': { body: { diningTableIds: ['<table id from GET /pos/floor>'], guestCount: 2 } },
  'POST /pos/parcel': { body: { pickupName: 'Rahul' } },
  'POST /pos/session/:id/ready-for-billing': {
    body: {},
    note: 'KOT hands the order to Billing (needs the KOT lease). From then on KOT cannot change it.',
  },
  'POST /pos/session/:id/billing-lease': {
    body: { deviceId: '{{deviceId}}' },
    capture: "if (b.token) pm.collectionVariables.set('leaseToken', b.token);",
    note: 'Billing takes a handed-over order. Refused while KOT still owns it.',
  },
  'GET /billing/queue': { note: 'Orders handed to Billing today: ready, in progress, completed. kot=false on Basic.' },
  'POST /pos/session/:id/lease': {
    body: { deviceId: '{{deviceId}}' },
    capture: "if (b.token) pm.collectionVariables.set('leaseToken', b.token);",
  },
  'POST /pos/order/:id/line': { body: { menuItemId: '<menu item id from GET /pos/menu>', quantity: 1 } },
  'POST /pos/order/:id/parcel-charge': {
    body: { amountMinor: 2000 },
    note: 'A parcel packing charge in paise (0 clears it). Capped by the branch parcel_charge_max_minor; taxed at its parcel_charge_tax_class_id.',
  },
  'GET /pos/my-takings': {
    query: { period: 'day' },
    note: 'Takings of the signed-in staff member only (day, week or month): bills, items, payment methods and totals. till.summary.view.',
  },
  'POST /pos/quote': {
    body: { parcel: true, lines: [{ menuItemId: '<menu item id from GET /pos/menu>', quantity: 2 }], parcelChargeMinor: 2000 },
    note: 'The order screen estimate: items, parcel charge, subtotal, tax heads, payable. Writes nothing. No parcelChargeMinor = the branch usual charge.',
  },
  'POST /pos/order/:id/fire': { body: { sessionVersion: 1 } },
  'POST /pos/session/:id/bill': { body: { splitKind: 'whole' } },
};

/** Which saved variable fills a path parameter, by the segment before it. */
function pathVariable(segments: readonly string[], index: number): string {
  const name = segments[index]!.slice(1);
  const before = segments[index - 1] ?? '';
  if (name === 'tenantSlug') return '{{tenantSlug}}';
  if (name === 'tenantId') return '{{tenantId}}';
  const byCollection: Record<string, string> = {
    tenants: '{{tenantId}}', subscriptions: '{{subscriptionId}}', plans: '{{planId}}',
    users: '{{userId}}', session: '{{sessionId}}', order: '{{orderId}}', bill: '{{billId}}',
    impersonation: '{{impersonationId}}',
  };
  return byCollection[before] ?? '';
}

const PLANE_FOLDERS: Record<string, { name: string; prefix: string; token: string | null }> = {
  public: { name: '1. Sign-in & public', prefix: '', token: null },
  platform: { name: '2. Platform (Super Admin & Sales Person)', prefix: '/api/platform', token: '{{platformToken}}' },
  tenant: { name: '3. Restaurant', prefix: '/api/t', token: '{{tenantToken}}' },
};

function sectionOf(route: RouteDefinition): string {
  if (route.plane !== 'tenant') return '';
  const first = route.url.split('/')[1] ?? '';
  if (first === 'pos') return 'KOT';
  if (first === 'kds') return 'Kitchen screen';
  if (first === 'billing') return 'Billing';
  const second = route.url.split('/')[2] ?? '';
  const names: Record<string, string> = {
    reports: 'Reports', branches: 'Branches', users: 'Staff', staff: 'Staff', access: 'Staff',
    roles: 'Roles', menu: 'Menu', devices: 'Tablets', stations: 'Kitchen setup', kitchens: 'Kitchen setup',
    printers: 'Kitchen setup', print: 'Kitchen setup', 'tax-classes': 'Tax', sessions: 'KOT',
    entitlements: 'Plan',
  };
  return names[second] ?? 'Other';
}

function item(route: RouteDefinition): object {
  const folder = PLANE_FOLDERS[route.plane]!;
  const full = `${folder.prefix}${route.url}`;
  const segments = full.split('/').filter(Boolean);
  const example = EXAMPLES[`${route.method} ${route.url}`] ?? {};
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(route.method);
  const leased = route.lease !== undefined && route.lease !== 'exempt';

  const headers = [
    ...(mutating ? [{ key: 'Idempotency-Key', value: '{{$guid}}', description: 'Required on POS writes and on Create restaurant; harmless elsewhere.' }] : []),
    ...(leased ? [{ key: 'X-Lease-Token', value: '{{leaseToken}}', description: 'From "POST /pos/session/:id/lease".' }] : []),
    ...(mutating ? [{ key: 'Content-Type', value: 'application/json' }] : []),
  ];

  const description = [
    example.note,
    route.permission ? `Permission: \`${route.permission.key}\`` : 'No sign-in needed.',
    route.plan && route.plan !== 'document'
      ? `Plan: ${'feature' in route.plan ? `needs ${route.plan.feature}` : 'reports' in route.plan ? `reports tier ${route.plan.reports}` : `counts against the ${route.plan.limit} limit`}`
      : null,
  ].filter(Boolean).join('\n\n');

  return {
    name: `${route.method} ${route.url}`,
    request: {
      method: route.method,
      header: headers,
      ...(folder.token === null
        ? { auth: { type: 'noauth' } }
        : {}),
      url: {
        raw: `{{baseUrl}}${full}${example.query ? `?${new URLSearchParams(example.query)}` : ''}`,
        host: ['{{baseUrl}}'],
        path: segments,
        ...(example.query ? { query: Object.entries(example.query).map(([key, value]) => ({ key, value })) } : {}),
        variable: segments.flatMap((s, i) => s.startsWith(':') ? [{ key: s.slice(1), value: pathVariable(segments, i) }] : []),
      },
      ...(mutating
        ? { body: { mode: 'raw', raw: JSON.stringify(example.body ?? {}, null, 2), options: { raw: { language: 'json' } } } }
        : {}),
      description,
    },
    ...(example.capture
      ? { event: [{ listen: 'test', script: { type: 'text/javascript', exec: [
          'if (pm.response.code === 200) {',
          '  const b = pm.response.json();',
          `  ${example.capture}`,
          '}',
        ] } }] }
      : {}),
  };
}

const routes = allRoutes({});
const folders = Object.entries(PLANE_FOLDERS).map(([plane, folder]) => {
  const mine = routes.filter((r) => r.plane === plane);
  const sections = new Map<string, RouteDefinition[]>();
  for (const route of mine) {
    const section = sectionOf(route);
    sections.set(section, [...(sections.get(section) ?? []), route]);
  }
  const items = [...sections.entries()].flatMap(([section, list]) =>
    section === '' ? list.map(item) : [{ name: section, item: list.map(item) }]);
  return {
    name: folder.name,
    item: items,
    ...(folder.token === null
      ? { auth: { type: 'noauth' } }
      : { auth: { type: 'bearer', bearer: [{ key: 'token', value: folder.token, type: 'string' }] } }),
  };
});

const collection = {
  info: {
    name: 'KatKitchen API',
    description: [
      'Every route the API serves, generated from the route table (`corepack pnpm postman`).',
      '',
      '1. Import this collection and the "KatKitchen local" environment; select the environment.',
      '2. Run "1. Sign-in & public > POST /api/auth/platform/login" -- it saves {{platformToken}}.',
      '3. Run "GET /plans" (saves {{planVersionId}}), then "POST /tenants" to create a restaurant (saves {{tenantId}}, {{tenantSlug}}, {{subscriptionId}}, {{inviteToken}}). Change the slug and email in its body first -- each must be unique.',
      '4. Run "POST /api/auth/invite/accept" to set the manager password, then "POST /api/auth/:tenantSlug/login" -- it saves {{tenantToken}}.',
      '5. Everything under "3. Restaurant" now runs as that restaurant.',
      '',
      'Access tokens last 15 minutes; run the matching refresh request when you get 401.',
    ].join('\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: folders,
  variable: ['platformToken', 'platformRefreshToken', 'tenantToken', 'tenantRefreshToken', 'tenantId',
    'tenantSlug', 'inviteToken', 'planId', 'planVersionId', 'subscriptionId', 'userId', 'sessionId',
    'orderId', 'billId', 'leaseToken', 'deviceId', 'impersonationId', 'staffSetupCode']
    .map((key) => ({ key, value: key === 'tenantSlug' ? 'spicegarden' : '' })),
};

const environment = {
  name: 'KatKitchen local',
  values: [
    { key: 'baseUrl', value: 'http://127.0.0.1:8080', enabled: true },
    { key: 'platformEmail', value: 'superadmin@katkitchen.com', enabled: true },
    { key: 'platformPassword', value: 'katkitchen@1', type: 'secret', enabled: true },
    { key: 'restaurantEmail', value: 'owner@spicegarden.test', enabled: true },
    { key: 'restaurantPassword', value: 'spice-garden-demo-2026', type: 'secret', enabled: true },
    { key: 'deviceFingerprint', value: 'postman-test-device', enabled: true },
  ],
};

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'KatKitchen.postman_collection.json'), `${JSON.stringify(collection, null, 2)}\n`);
await writeFile(path.join(OUT, 'KatKitchen-local.postman_environment.json'), `${JSON.stringify(environment, null, 2)}\n`);

const counted = folders.reduce((n, f) => n + JSON.stringify(f).split('"request":').length - 1, 0);
if (counted !== routes.length) {
  throw new Error(`collection has ${counted} requests but the route table has ${routes.length}`);
}
const unused = Object.keys(EXAMPLES).filter((k) => !routes.some((r) => `${r.method} ${r.url}` === k));
if (unused.length > 0) throw new Error(`examples for routes that do not exist: ${unused.join(', ')}`);
console.log(`wrote ${counted} requests to docs/postman/`);
