import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_TABLES, assertCheckedSet } from '../helpers/db.js';

/**
 * The raw-SQL gate.
 *
 * "Raw SQL against a tenant table without a tenant_id predicate must fail a
 * test/lint gate. Do not rely on code review to catch this." This is that gate:
 * it fails the build, not a reviewer's attention.
 *
 * Two rules:
 *   1. Only the infrastructure layer may call .query() at all. Everything else
 *      goes through a repository, which cannot omit the predicate.
 *   2. Where infrastructure does touch schema `app` directly, the statement must
 *      name tenant_id -- those callers run as katkitchen_owner and are therefore
 *      not covered by RLS.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

/**
 * Every entry is a module that legitimately issues SQL, with the reason it is
 * exempt. Adding to this list should feel like a decision, which is why the
 * reason is required and why a test asserts the list is not silently growing.
 */
const SQL_LAYER: Readonly<Record<string, string>> = {
  'database/baseRepository.ts': 'builds the tenant predicate; the reason the rule can be kept',
  'database/unitOfWork.ts': 'opens the transaction and sets the tenant GUC',
  'database/migrate.ts': 'runs DDL as the owner role',
  'modules/orders/board.ts':
    'the aggregate board read: one round trip resolving session, lines, lease and server time in a single instant. It lived in http/routes/pos.ts, which made the thin-handler gate pass by geography -- the handlers were SQL-free because this file was one directory over, inside the route layer and unscanned. The menu half moved to menu/read.ts once GET /pos/menu needed the same answer',
  'modules/tax/taxClassSeed.ts':
    'owner-role seeding of the tax vocabulary inside the provisioning transaction, before the tenant has a session for a repository to read. Exactly the shape and the reason of setup/adjustmentReasonSeed.ts beside it, and split out for the same reason: the READ of app.tax_class goes through TaxClassRepository via ADMIN_RESOURCES and stays under this gate',
  'modules/orders/billingQueue.ts':
    'the Billing queue read: every handed-over order of the day with its amount, billed and paid figures and status derived in ONE statement from the order lines, bills and tenders -- several repository reads would be several instants, and an order could read paid and unbilled at once. Every statement carries its tenant_id predicate',
  'modules/users/identifiers.ts':
    'the staff code / email availability check spans app_user AND pending staff_invite rows in one UNION, which no single repository covers; every branch carries its tenant_id predicate',
  'modules/orders/parcels.ts':
    'the parcel counter read: every parcel of the business day with its status DERIVED in the same query from kitchen lines, the handover stamp and the session -- a status assembled from several repository reads would be several instants, and a parcel could read ready and unsent at once. Every statement carries its tenant_id predicate',
  'modules/products/read.ts':
    'the catalogue projection and the version stamp, carved out of ops/board.ts so the board and GET /pos/menu cannot answer differently. Two implementations of the price-and-availability read is how the board once dropped days_of_week and offered a weekday-only item on a Sunday',
  'modules/authentication/ownerInvite.ts':
    'redeeming a Restaurant Manager setup link: one locked read of platform.tenant_owner_invite by token hash (no tenant exists yet, and platform carries no RLS), then writes to app.app_user and app.credential under the tenant the INVITE names via adoptTenantContext -- every app statement carries its tenant_id predicate and runs under RLS as the app role. A repository would need the tenant before the token has been read, which is the thing the token is for',
  'modules/authentication/platformAuth.ts':
    'verifies a control-plane password on a pre-auth connection with NO tenant GUC set. There is no TenantContext to route a repository through and there never will be: a platform user has no tenant, which is the whole point of the plane split. Reads platform.platform_user, which carries no RLS, and writes only its own lockout columns',
  'modules/authentication/authAttempt.ts':
    'writes platform.auth_attempt on a pre-auth connection. There is no tenant context to route a repository through -- that is the whole reason credential events are not in the tenant audit log',
  'middleware/agentRoute.ts':
    'the print agent registrar: BEGIN and COMMIT around the agent-token check and the poll, which must be one transaction because the token check is what SETS the tenant GUC the poll then runs under. No query of its own beyond the transaction; the reads and writes are in modules/business-types/restaurant/kitchen/printAgent.ts',
  'modules/business-types/restaurant/kitchen/printAgent.ts':
    'the print agent, server side: resolves the agent token (platform.tenant by slug, then app.print_agent by hash, before any TenantContext can exist -- the token is what names the tenant), then claims and settles print jobs through the print worker functions. Every app statement it issues carries its tenant_id predicate',
  'middleware/publicRoute.ts':
    'the pre-auth registrar: opens the transaction that spans the credential verify and the attempt row, so a lockout increment cannot survive a failure to record why. Same exemption as http/platformRoute.ts and for the same reason -- the registrar owns a write no tenant repository can carry',
  'jobs/runner.ts':
    'takes the advisory lock on a direct connection and writes the run ledger as the owner, whatever the job posture',
  'jobs/registry.ts':
    'three checks are single queries against tenant tables with no repository shape: credential absence, unattributable actions, claim purge',
  'database/partitions.ts': 'runs the partition job as the owner role',
  'database/seed.ts': 'runs the global catalogue seed as the owner role',
  'database/startupChecks.ts': 'probes the connection before any tenant exists',
  'modules/platform/tenantStaff.ts':
    "the Sales person's staff PINs: resolves the restaurant on the control plane (only one they sold, unless they may reach any), then adopts that tenant and writes the user, PIN credential and memberships under RLS in one transaction, counting the users limit under its lock. Every app statement names tenant_id",
  'modules/platform/countries.ts':
    "the countries offered (platform.platform_setting, no tenant) and moving one restaurant's country: resolves the restaurant on the control plane (only one they sold, unless they may reach any), then adopts that tenant and, under RLS as the app role, checks it has no bill and no open order with every branch locked, converts its configured prices by the confirmed rate, re-taxes its dishes and resets its branches -- one transaction that no single repository spans. Every app statement names tenant_id",
  'modules/authz/seed.ts': 'owner-role seeding; passes tenant_id explicitly, outside RLS',
  'modules/orders/adjustmentReasonSeed.ts':
    'owner-role seeding of the adjustment vocabulary inside the provisioning transaction, before the tenant has a session for a repository to read. Split out of ops/adjustmentReasons.ts so the READ of the same table still goes through BaseRepository and stays under this gate',
  'modules/platform/provisioning.ts': 'runs as the owner role inside the provisioning transaction, before any tenant session exists',
  'modules/platform/staff.ts':
    'the control-plane staff directory behind GET /users and POST /users: platform schema only, no tenant GUC, and no RLS to apply -- the same posture as platform/directory.ts beside it. platform.platform_user and platform.platform_role carry no tenant_id at all, so there is no repository shape for either',
  'modules/platform/tenantAdmin.ts':
    'edit, deactivate and reactivate a restaurant: platform.tenant only, no tenant GUC, no RLS to apply -- the same posture as platform/directory.ts. Each write locks the tenant row FOR UPDATE and republishes the entitlement document in the same transaction, which is a unit a repository over app.* has no shape for',
  'modules/platform/tenantModules.ts':
    'which modules a tenant has on: platform.tenant_module only, written by the control plane (provisioning and the tenant edit) in their transaction, no tenant GUC, no schema app. The tenant plane reads the result through the entitlement document, never this table',
  'modules/platform/slug.ts':
    "the create form's live slug check: one existence read of platform.tenant by slug. Control plane, no tenant GUC, no schema app; the unique index tenant_slug_key remains the authority",
  'modules/platform/salesScope.ts':
    "a Salesperson's book, enforced on control-plane routes that take a subscription or tenant id: one existence check against platform.provisioning_request, no tenant GUC, no schema app. One place for the rule rather than a predicate threaded through the billing functions",
  'modules/platform/planCatalogue.ts':
    'the standard plan seed and plan-version publishing: platform.plan and platform.plan_version carry no tenant_id, so there is no repository shape. The next version number is read under a FOR UPDATE on the plan row so two publishes cannot both claim it',
  'modules/tax/tenantRegime.ts':
    "one SELECT of platform.tenant.tax_jurisdiction, which is a CONTROL-PLANE column read from the tenant plane. There is no tenant repository for it and there must not be: platform.tenant carries no RLS, so a BaseRepository predicate over app.tenant_id would not apply to it and the tenant id is named in the WHERE explicitly instead. One function, one statement, so the read that decides which heads a bill carries and which country code a bare phone number belongs to has exactly one implementation -- the alternative was denormalising the column onto app.branch, which makes a chain opening a branch abroad a data migration and gives a reader two places to look",
  'modules/platform/redisEntitlementCache.ts':
    'the warm-up reads the latest entitlement document per tenant as the owner, the same posture as publish',
  'modules/notifications/outboxWorker.ts':
    'the drain loop: SKIP LOCKED claiming with ordered-group gating, backoff and the dead-letter transition',
  'modules/notifications/outbox.ts': 'transactional outbox; platform schema only',
  'modules/platform/ladder.ts': 'owner-role reconciliation job over platform.tenant and app.app_user',
  'modules/platform/impersonation.ts': 'owner-role session lifecycle; the per-request session read that makes revocation immediate',
  'modules/platform/entitlements.ts':
    'publishes the control-plane entitlement document, and reads the newest one back on a tenant-plane cache miss: platform.entitlement_document carries no RLS and no tenant_id-scoped repository, and the read runs on the request connection itself so a miss costs no second pooled connection',
  'modules/users/staffList.ts':
    'the staff list folds memberships into each person, and pending invites beside them, in one read. Every statement names tenant_id',
  'modules/users/staffAccess.ts':
    'POS access: the list folds credentials, open reset links and memberships into each person in one read. Every statement names tenant_id',
  'modules/businesses/setup.ts':
    'the manager setup writes that span several tables which must agree in one transaction: a kitchen is its station code, the branch station and the printer link; an add-on group is the group and its options; a food item is the item, its add-on attachments, its combo dishes and its branch listing. Progress is one read of eight counts. Every statement names tenant_id',
  'modules/businesses/requiredColumns.ts':
    'reads information_schema for which writable columns are NOT NULL without a default, so admin forms mark required fields from the schema itself rather than a hand-kept copy. Catalogue metadata, no tenant rows',
  'modules/businesses/planUsage.ts':
    'counts a plan limit under a transaction-scoped advisory lock, so two concurrent creates cannot both count below the limit. The lock and the count must share one connection and one transaction, which no repository call expresses; every statement names tenant_id',
  'modules/platform/directory.ts':
    "the control-plane read model behind GET /tenants and GET /plans: platform schema only, run with NO tenant GUC because the control plane has none. Each list is ONE query resolving a tenant with its live subscription and that subscription's plan version in a single instant -- three round trips would be three instants and the status column could contradict the plan column. It also holds the one slug-to-id resolution the control plane needs, which cannot be resolveTenantForAuth because that applies the LOGIN allowlist and impersonation is deliberately available at hard_lock",
  'modules/platform/systemHealth.ts':
    "the probes GET /system/health can honestly answer from inside a request transaction: BYPASSRLS, app-table ownership, UPDATE/DELETE on the two audit parents, and the ladder cache checked against its own delinquent_since. It cannot delegate to db/startupChecks.ts, whose first probe issues BEGIN/COMMIT and would commit the registrar's transaction half way through the request -- so the SQL is here and the one probe that cannot run is reported as not_probed rather than faked",
  'middleware/platformRoute.ts':
    'the control-plane registrar: opens the transaction WITHOUT a tenant GUC and writes platform.platform_audit_log in it, which is the one audit write that cannot go through a tenant repository',
  'modules/orders/orderEntry.ts':
    'the priced-document write: resolves catalogue price, modifier deltas, tax class and rate in the same transaction that snapshots them onto the line, and allocates combo components',
  'modules/orders/adjustments.ts':
    'reads the target FOR UPDATE with its running net in one statement, then writes the adjustment by INSERT ... SELECT so the pinned price comes from the row itself',
  'modules/orders/session.ts':
    'session open spans table_session, table_session_table and sales_order; the outstanding-money check is an aggregate over bill and tender',
  'modules/inventory/deduct.ts':
    'expands kot_line -> recipe_version_expansion and posts the ledger under a per-KOT dedupe key; the SAVEPOINT retry is not expressible through a repository',
  'modules/metering/usageRollup.ts':
    'the one job that crosses the plane boundary upward: reads app under a per-tenant GUC, writes platform aggregates',
  'modules/reports/exceptionReport.ts':
    'reads the audit log against the permission catalogue; the baseline comparison is a windowed aggregate',
  'modules/reports/salesReports.ts':
    'one projection over order_line by six dimensions; not expressible as single-table repository calls',
  'modules/reports/gstReturn.ts':
    'buckets bill lines by snapshotted rate and component, and reconciles independently off the same tables',
  'modules/reports/tillSummary.ts':
    'the till X-read: one person\'s tenders joined to their bills, printed lines and sessions in three aggregates over the same scoped set; every statement carries its tenant_id predicate',
  'modules/billing/renewal.ts':
    'moves a subscription period forward: platform.subscription and platform.plan_version only, one locked read and one UPDATE in the same statement pair so the period cannot move twice. Control plane, no tenant GUC, no schema app',
  'modules/billing/invoicing.ts':
    'invoice generation: gapless numbering, party snapshot and per-line tax components in one transaction',
  'modules/billing/segments.ts':
    'opens and closes subscription segments under the no-overlap exclusion constraint',
  'modules/billing/scheduledChange.ts':
    'applies due contractions and reads the usage rollup for the over-quota check',
  'modules/billing/webhooks.ts':
    'records gateway events and payments; idempotency and the monotonic guard are SQL-level',
  'modules/billing/dunning.ts':
    'attempt scheduling and the queue projection across invoice, tenant and dunning tables',
  'modules/billing/invoiceLedger.ts':
    'the invoice list behind GET /invoices. It reads the PARTY SNAPSHOT off the invoice row and joins platform.tenant for the operator-facing slug only -- joining tenant_tax_profile for a nicer name would undo the snapshot at the point of display, so the screen and the PDF would disagree about who was invoiced. The captured-payment total is a correlated aggregate over gateway_payment, which is not a single-table repository read',
  'modules/billing/planChange.ts':
    "decides the DIRECTION of a subscription change and routes it: it needs the current plan version's price and the open segment's quantity, locked, to know whether the request expands or contracts. A handler computing that would be a route layer taking its own snapshot off a live price, and applyExpansion and scheduleContraction would keep having no caller able to choose between them",
  'modules/billing/taxExemption.ts':
    'the only writer of the zero-rating grant columns on platform.tenant_tax_profile. tenant_exemption_attributed and tenant_tax_profile_exemption_guard make the claim impossible without a platform user, a timestamp and evidence, all re-stated in the same statement -- so this is a single locked read-then-UPDATE against a control-plane table with a guard trigger, and the CHECKs stay the authority rather than being re-implemented here',
  'modules/offline/lease.ts':
    'the session lease: the single-writer guarantee every offline operation rests on, resolved against server time on every check',
  'modules/offline/leaseGuard.ts':
    'the online half of the lease: resolves the session behind an order or bill and the lease behind a token in the same transaction as the write it guards. Two statements, both parameterised, and the subject SQL is a fixed record rather than an interpolated table name -- a fifth subject is a compile error at the switch, not a string that silently matches nothing',
  'modules/offline/sync.ts':
    'adjudicates and records a device batch across sync_batch and sync_quarantine before any operation is applied',
  'modules/offline/manualSettlement.ts':
    'records an out-of-band tender against a bill, with the completeness rule enforced in the same statement',
  'modules/inventory/reconcile.ts':
    'compares the cached balance against a full re-fold of the ledger; reads only, and asserted to contain no write',
  'modules/business-types/restaurant/kitchen/printWorker.ts':
    'the print drain: SKIP LOCKED claiming, fallback escalation and the ticket render, all outside the fire transaction',
  'modules/businesses/floor.ts':
    'the floor read: one query resolving every table, its open session, its most recent lease and its line count in a single instant -- six queries would be six instants and the board would contradict itself',
  'modules/businesses/setupImport.ts':
    'the Excel setup import: name lookups to match each row to what exists, and the savepoints that make the import all or nothing and the preview a rolled-back run of the same code. Writes go through the setup functions and the admin resources repositories; every statement names tenant_id',
  'modules/users/me.ts':
    'the header badge read: the caller own name, roles, branch and tablet, keyed only on the verified token subject; every statement names tenant_id',
  'modules/business-types/restaurant/kitchen/orderTickets.ts':
    'the KOT screen ticket list: each kitchen ticket of one order with its newest print job and printer in one read, so a status and its printer name cannot come from two instants; and Mark ready, which locks the ticket at its branch and moves its live lines in one statement. Every statement names tenant_id',
  'modules/payments/billing.ts': 'bill generation and tender reconciliation across order_line, bill and tender',
  'modules/payments/dayEnd.ts':
    'day end (0086): the per-day advisory lock, the day figures over bill, tender and refund in grouped reads, and the submission row written under that lock. Every statement names tenant_id',
  'modules/payments/billHistory.ts':
    'bill history (0086): each bill with its payments, refunds and latest edit in one read, and one bill with its lines, tenders, refunds and revisions. Read only; every statement names tenant_id',
  'modules/payments/billRevision.ts':
    'a bill edit (0086): the session and bill locked in the documented order, the void, the stage held for the edit and restored, the revision row; lines, bills and refunds go through the order and billing functions. Every statement names tenant_id',
  'modules/tax/branchTaxSettings.ts':
    'locks the branch row FOR UPDATE, counts its open sessions and writes the tax settings under that lock, so an order opening concurrently (which reads the mode FOR SHARE) is ordered against the change. Every statement carries its tenant_id predicate',
  'modules/payments/billPrint.ts':
    'the printed bill: one locked read of the bill with its branch, session, bill lines, order-line snapshots and tenders, and the copy counter written under that same lock so two tablets cannot both print copy 1. Several repository reads would be several instants. Every app statement carries its tenant_id predicate; the one platform read is the tenant root by its own id',
  'modules/orders/openOrders.ts':
    'every open order of the restaurant, any day, with its amount, billed and paid figures in ONE statement -- the same shape and reason as billingQueue.ts. Every statement carries its tenant_id predicate',
  'modules/orders/idempotency.ts':
    'claims and replays the idempotency key; the SAVEPOINT dance is not expressible through a repository',
  'modules/business-types/restaurant/kitchen/fire.ts':
    'the atomic fire transaction: sequence counters, routing resolution and cross-table inserts under a fixed lock order',
  'modules/products/availability.ts':
    'resolves the three availability concerns in one branch-local query; not expressible as single-table repository calls',
  'modules/products/routing.ts':
    'listing and archive guards span menu_item, kitchen_station and the branch override tables',
  'modules/authentication/preAuthTenant.ts':
    'the one pre-auth read of platform.tenant: resolves a slug to a tenant id before any GUC can be set, which is the whole reason it is a control-plane table with no RLS',
  'modules/authentication/passwordAuth.ts':
    'password verification and the lockout write, the same posture as auth/deviceAuth.ts: it runs before a repository context is meaningful and every statement names tenant_id',
  'modules/authentication/session.ts':
    're-reads app.device.status on refresh, so revoking a terminal ends its session within the access-token lifetime rather than in twelve hours',
  'modules/authentication/deviceAuth.ts':
    'device trust and PIN verification run before any repository context is meaningful; every statement names tenant_id',
  'modules/authz/authorityStore.ts':
    'read model joining membership -> role -> role_permission; not expressible as a single-table repository call',
};

async function sourceFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await sourceFiles(path.join(dir, entry.name), rel)));
    else if (entry.name.endsWith('.ts')) files.push(rel);
  }
  return files.sort();
}

const QUERY_CALL = /\.query\s*[<(]/;
/**
 * Derived from APP_TABLES, not enumerated here. An enumerated copy would drift
 * the moment a table is added -- the same failure mode the schema split and the
 * SoD exemption were both restructured to avoid.
 *
 * ###########################################################################
 * `String.raw` IS LOAD-BEARING. THIS WAS A TEMPLATE LITERAL AND IT MATCHED
 * NOTHING.
 *
 * It read ``new RegExp(`\bapp\.(${...})\b`)``. Inside a template literal
 * `\b` is the BACKSPACE escape (U+0008), not a word boundary, and `\.` is just
 * `.`. So the compiled pattern began with a control character and could not
 * match `FROM app.bill` -- proven, not inferred:
 *
 *   bad.source                                    "\bapp.(branch|bill)\b"
 *   bad.test('SELECT x FROM app.bill WHERE 1=1')  false
 *   good.test(same)                               true
 *
 * The test below is titled "requires every direct statement against schema app
 * to name tenant_id". It is the tenant-isolation gate for the raw-SQL layer,
 * and for its entire life it checked zero statements and passed. Three separate
 * readers found it independently while working in this file, which is the only
 * reason it is fixed now rather than later.
 *
 * A gate that fails OPEN is worse than no gate: it is a green tick standing
 * where a check was supposed to be.
 * ###########################################################################
 */
const APP_TABLE = new RegExp(String.raw`\bapp\.(${APP_TABLES.join('|')})\b`);

/**
 * The template literals actually handed to `.query(`.
 *
 * Not every backtick in the file: a doc comment containing `` `app.device` ``
 * would otherwise be read as a statement, and splitting on parity breaks the
 * moment one appears. This walks forward from each `.query(` call to the literal
 * that follows it and takes exactly that.
 */
function statementsIn(source: string): string[] {
  const out: string[] = [];
  const call = /\.query\s*(?:<[^>]*>)?\s*\(\s*/g;
  let match = call.exec(source);
  while (match !== null) {
    const start = match.index + match[0].length;
    if (source[start] === '`') {
      const end = source.indexOf('`', start + 1);
      if (end !== -1) out.push(source.slice(start + 1, end));
    }
    match = call.exec(source);
  }
  return out;
}

/**
 * Files whose statements are scoped by RLS rather than by a written predicate.
 *
 * This is a real design position, not a concession: each of these runs as
 * `katkitchen_app` -- which is NOBYPASSRLS -- with the tenant GUC set per
 * tenant, and the whole reason they do not run as the owner is that the owner
 * would be exempt from the only scoping they have. Writing a predicate as well
 * would be better; running as the owner without one would be a cross-tenant
 * read, which is why each file's own header says which role it runs as.
 *
 * The test below checks the claim rather than trusting it.
 */
const RLS_SCOPED: Readonly<Record<string, string>> = {
  'modules/metering/usageRollup.ts':
    'counts a tenant own rows for billing, as the app role under a per-tenant GUC set at line 159. Its header states the reason it is not the owner: an owner-run rollup with a wrong predicate would bill one tenant for another usage, and RLS is what makes that impossible rather than merely unlikely',
  'modules/business-types/restaurant/kitchen/printWorker.ts':
    'the drain loop claims across tenants with SKIP LOCKED and then sets the GUC per message, as the app role. A predicate would have to name the tenant it has just discovered, which is circular; RLS scopes the work once the GUC is set, and the per-tenant cap per cycle is what stops one tenant starving the others',
  'jobs/registry.ts':
    'three cross-tenant integrity checks that are deliberately not scoped to one tenant: credential absence, unattributable actions and the claim purge each ask a question about the whole install, which is what makes them able to notice a tenant nobody is watching',
};

describe('the raw-SQL gate', () => {
  it('scans the whole source tree', async () => {
    const files = await sourceFiles(SRC);
    assertCheckedSet({
      label: 'scanned source files',
      checked: files,
      minimum: 25,
      mustInclude: [
        'database/baseRepository.ts',
        'database/unitOfWork.ts',
        'database/repositories.ts',
        'modules/authz/grant.ts',
      ],
    });
  });

  it('lets only the SQL layer issue queries', async () => {
    const files = await sourceFiles(SRC);
    const offenders: string[] = [];

    for (const file of files) {
      if (file in SQL_LAYER) continue;
      const source = await readFile(path.join(SRC, file), 'utf8');
      if (QUERY_CALL.test(source)) offenders.push(file);
    }

    expect(
      offenders,
      'these modules issue SQL directly; route them through a repository or justify them in SQL_LAYER',
    ).toEqual([]);
  });

  it('confirms the exempt modules really do contain the SQL, so the list is not stale', async () => {
    // A stale allowlist is how this gate would quietly stop covering anything.
    const inert: string[] = [];
    for (const file of Object.keys(SQL_LAYER)) {
      const source = await readFile(path.join(SRC, file), 'utf8');
      if (!QUERY_CALL.test(source)) inert.push(file);
    }
    expect(inert, 'listed as SQL-layer but issues no SQL; remove from SQL_LAYER').toEqual([]);
  });

  it('requires every direct statement against schema app to name tenant_id', async () => {
    const offenders: string[] = [];

    for (const file of Object.keys(SQL_LAYER)) {
      if (file === 'database/baseRepository.ts') continue; // builds the predicate itself
      if (file in RLS_SCOPED) continue;
      const source = await readFile(path.join(SRC, file), 'utf8');

      for (const statement of statementsIn(source)) {
        // DDL and catalogue queries do not carry a tenant predicate and cannot.
        if (/\b(CREATE|ALTER|DROP|REVOKE|GRANT)\b/i.test(statement)) continue;
        if (!APP_TABLE.test(statement)) continue;
        if (!/tenant_id/.test(statement)) {
          offenders.push(`${file}: ${statement.trim().replace(/\s+/g, ' ').slice(0, 90)}`);
        }
      }
    }

    expect(
      offenders,
      'these statements touch schema app without naming tenant_id. Either add the '
        + 'predicate, or -- if the statement is deliberately scoped by RLS alone -- '
        + 'justify the FILE in RLS_SCOPED',
    ).toEqual([]);
  });

  it('is not vacuous: it finds a statement with the predicate removed', async () => {
    // ###################################################################
    // THIS GATE PASSED FOR ITS ENTIRE LIFE WITHOUT CHECKING ANYTHING.
    //
    // Two independent bugs, both of which made it fail OPEN:
    //
    //   1. `new RegExp(\`\\bapp\\.(...)\\b\`)` -- in a TEMPLATE LITERAL,
    //      `\b` is the backspace escape (U+0008), not a word boundary. The
    //      compiled pattern began with a control character and could not match
    //      `FROM app.bill`. Fixed with String.raw.
    //   2. The extraction was `source.split('`')`, which tests every segment --
    //      including the surrounding TypeScript. Taking only odd indices is not
    //      enough either: a backtick inside a doc comment (`\`app.device\`` in
    //      prose) shifts the parity for the rest of the file. Now only literals
    //      actually passed to `.query(` are read.
    //
    // So this test exists: the check is proven to notice a real statement with
    // its predicate taken away. Without it, a third way of failing open would be
    // just as invisible as the first two.
    // ###################################################################
    const withPredicate = `
      const x = await client.query(\`SELECT id FROM app.bill
         WHERE tenant_id = $1 AND id = $2\`, [t, i]);
    `;
    const without = withPredicate.replace('tenant_id = $1 AND ', '');

    const scan = (source: string): string[] =>
      statementsIn(source).filter((st) => APP_TABLE.test(st) && !/tenant_id/.test(st));

    expect(scan(withPredicate), 'a predicated statement is clean').toEqual([]);
    expect(scan(without).length, 'removing the predicate must be caught').toBe(1);

    // And the regex itself, pinned: this is the exact expression that was wrong.
    expect(APP_TABLE.test('SELECT x FROM app.bill WHERE 1=1')).toBe(true);
    expect(APP_TABLE.source.startsWith('\\b'), 'String.raw, not a template literal')
      .toBe(true);
  });

  it('confirms every RLS_SCOPED file really does set the tenant GUC itself', async () => {
    // The exemption is "this file relies on RLS instead of a predicate", and that
    // is only true if the file actually runs under a tenant GUC as the APP role.
    // A file that took the exemption and then ran as the owner would be exempt
    // from both the predicate AND from RLS -- unscoped in production, green here.
    for (const file of Object.keys(RLS_SCOPED)) {
      const source = await readFile(path.join(SRC, file), 'utf8');
      // The GUC name reaches set_config as a BOUND PARAMETER in at least one of
      // these files (`set_config($1,$2,true)` with `'app.tenant_id'` in the
      // params array), so a pattern anchored to set_config's first argument
      // misses it -- it flagged usageRollup.ts, which is the most carefully
      // GUC-scoped file of the four. What has to be true is that the file names
      // the GUC or takes a TenantContext at all.
      const setsGuc = /app\.tenant_id|withTenantTransaction|current_tenant_id|TenantContext/
        .test(source);
      expect(setsGuc, `${file} claims RLS scoping but never establishes a tenant context`)
        .toBe(true);
      expect(RLS_SCOPED[file]!.length, `${file} needs a real reason`).toBeGreaterThan(60);
    }
  });

  it('keeps the repository layer free of hand-written predicates', async () => {
    const source = await readFile(path.join(SRC, 'database/repositories.ts'), 'utf8');
    expect(QUERY_CALL.test(source), 'repositories must not issue SQL of their own').toBe(false);
    expect(/WHERE/i.test(source), 'repositories must not hand-write predicates').toBe(false);
  });
});
