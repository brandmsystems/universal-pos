import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';
import { withTenantTransaction } from '../../src/core/database/unitOfWork.js';
import { peekTenantContext, type TenantContext } from '../../src/core/database/tenantContext.js';
import {
  claimLease, renewLease, releaseLease, forceReleaseLease, leaseState, requireLease,
  localKotReference, LeaseHeldError, LeaseNotHeldError,
} from '../../src/modules/offline/lease.js';
import { receiveBatch, orderDeductionQueue, openQuarantine, OFFLINE_ALLOWED, OFFLINE_FORBIDDEN, type SyncBatch } from '../../src/modules/offline/sync.js';
import {
  recordManualSettlement, manualSettlementsForPeriod, ManualSettlementIncompleteError,
} from '../../src/modules/offline/manualSettlement.js';
import {
  assertOfflineWindowFitsClaimRetention, OFFLINE_WINDOW_HOURS,
  REQUEST_CLAIM_RETENTION_DAYS, OFFLINE_WINDOW_SAFETY_FACTOR, LEASE_DURATION_MINUTES,
} from '../../src/modules/offline/window.js';
import { PERMISSIONS } from '../../src/modules/authz/permissions.js';
import { SYSTEM_ROLES } from '../../src/modules/authz/systemRoles.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';

let owner: pg.Client;
let pool: pg.Pool;
let tenantId: string, branchId: string, userId: string;
let deviceA: string, deviceB: string, leaseReason: string, manualReason: string;

const DATE = '2026-04-01';
const ctx = (): TenantContext => peekTenantContext()!;
const tx = <T>(fn: () => Promise<T>) => withTenantTransaction(pool, tenantId, fn);

async function makeSession(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO app.table_session (id,tenant_id,branch_id,business_date,opened_by_user_id)
     VALUES ($1,$2,$3,$4::date,$5)`, [id, tenantId, branchId, DATE, userId]);
  return id;
}

async function makeDevice(name: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO app.device (id,tenant_id,branch_id,name,fingerprint,registered_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, tenantId, branchId, name, randomUUID().replace(/-/g, ''), userId]);
  return id;
}

function batch(over: Partial<SyncBatch> & { sessionId?: string } = {}): SyncBatch {
  const sessionId = over.sessionId ?? randomUUID();
  return {
    clientBatchNo: over.clientBatchNo ?? 1,
    deviceId: over.deviceId ?? deviceA,
    branchId,
    offlineSince: over.offlineSince ?? new Date().toISOString(),
    operations: over.operations ?? [{
      kind: 'order.line.add', idempotencyKey: randomUUID(),
      sessionId, businessDate: DATE, payload: {},
    }],
  };
}

const noop = async () => {};

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  pool = new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER']!, max: 6 });
  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);

  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key='super_admin'`)).rows[0]!.id;
  const superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id,email,password_hash,full_name,platform_role_id)
     VALUES ($1,$2,'argon2id$stub','Root',$3)`, [superAdminId, `off+${superAdminId}@p.test`, roleId]);
  await owner.query(`INSERT INTO platform.plan (id,key,name) VALUES ($1,'off_plan','Off')
    ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
  const planId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan WHERE key='off_plan'`)).rows[0]!.id;
  await owner.query(
    `INSERT INTO platform.plan_version (id,plan_id,version,price_minor,currency,billing_period,published_at)
     VALUES ($1,$2,1,100000,'INR','monthly',now()) ON CONFLICT (plan_id,version) DO NOTHING`,
    [randomUUID(), planId]);
  const planVersionId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.plan_version WHERE plan_id=$1 AND version=1`, [planId])).rows[0]!.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const key = `off-${randomUUID()}`;
    const r = await provisionTenant(client, {
      idempotencyKey: key, slug: `o${key.slice(4, 12)}`, name: 'Offline Probe',
      currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: `${key}@o.test`,
      ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
      taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId });
    await client.query('COMMIT');
    tenantId = r.tenantId; branchId = r.firstBranchId; userId = r.ownerUserId;
  } finally { client.release(); }

  deviceA = await makeDevice('Terminal A');
  deviceB = await makeDevice('Terminal B');

  leaseReason = randomUUID();
  await owner.query(
    `INSERT INTO app.adjustment_reason (id,tenant_id,key,name)
     VALUES ($1,$2,'dead_tablet','Tablet unresponsive')`, [leaseReason, tenantId]);
  manualReason = randomUUID();
  await owner.query(
    `INSERT INTO app.adjustment_reason (id,tenant_id,key,name)
     VALUES ($1,$2,'outage_manual_card','Manual card machine during outage')`,
    [manualReason, tenantId]);
  await owner.query(
    `INSERT INTO app.adjustment_reason_kind (tenant_id,reason_id,kind)
     VALUES ($1,$2,'void')`, [tenantId, manualReason]);
});

afterAll(async () => { await pool?.end(); await owner?.end(); });

/* ------------------------------------------------------------- the lease --- */

describe('the session lease is the single-writer guarantee', () => {
  it('refuses a second device and admits the same device again', async () => {
    const s = await makeSession();
    await tx(() => claimLease(ctx(), { sessionId: s, deviceId: deviceA, branchId }));

    await expect(tx(() => claimLease(ctx(), { sessionId: s, deviceId: deviceB, branchId })))
      .rejects.toThrow(LeaseHeldError);

    // A terminal that reconnects mid-service must not have to distinguish
    // "claim" from "renew".
    await expect(tx(() => claimLease(ctx(), { sessionId: s, deviceId: deviceA, branchId })))
      .resolves.toBeTruthy();
  });

  it('is keyed on the SESSION, not the table', async () => {
    // A party moves from table 4 to table 7: one session, two table rows.
    const s = await makeSession();
    const cols = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='app' AND table_name='table_session_lease'`);
    const names = cols.rows.map((c) => c.column_name);

    assertCheckedSet({
      label: 'lease columns',
      checked: names,
      minimum: 8,
      mustInclude: ['session_id', 'device_id', 'expires_at', 'force_released_at'],
    });
    // A table-keyed lease would split at the move and hand table 7 to another
    // device, reintroducing the double writer.
    expect(names.filter((n) => /table_id|dining_table/.test(n))).toEqual([]);

    await tx(() => claimLease(ctx(), { sessionId: s, deviceId: deviceA, branchId }));
    for (const t of ['t4', 't7']) void t;
    const state = await tx(() => leaseState(ctx(), { sessionId: s, deviceId: deviceA }));
    expect(state.held).toBe(true);
  });

  it('caps the lease at 15 minutes on the ROW, not merely where it is issued', async () => {
    const s = await makeSession();
    await expect(owner.query(
      `INSERT INTO app.table_session_lease (id,session_id,tenant_id,branch_id,device_id,expires_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4, now() + interval '4 hours')`,
      [s, tenantId, branchId, deviceA]))
      .rejects.toThrow(/duration_capped/);
    expect(LEASE_DURATION_MINUTES).toBe(15);
  });

  it('gives an offline device its REMAINING window, never a fresh one', async () => {
    const s = await makeSession();
    const first = await tx(() => claimLease(ctx(), { sessionId: s, deviceId: deviceA, branchId }));

    // Expiry is absolute and only renewal moves it, so a device that cannot
    // reach the server cannot extend itself. No separate mechanism to get wrong.
    const untouched = await owner.query<{ e: string }>(
      `SELECT expires_at::text AS e FROM app.table_session_lease WHERE session_id=$1`, [s]);
    expect(untouched.rows[0]!.e).toBe(first.expiresAt);

    const renewed = await tx(() => renewLease(ctx(), { sessionId: s, deviceId: deviceA }));
    expect(new Date(renewed.expiresAt).getTime())
      .toBeGreaterThanOrEqual(new Date(first.expiresAt).getTime());
  });

  it('treats an expired lease as not held, by SERVER time', async () => {
    // A lease cannot be shortened by UPDATE -- force-release is the mechanism for
    // that -- so an already-expired lease is created as one. The CHECK caps the
    // grant at 15 minutes but says nothing about it being in the future.
    const s = await makeSession();
    await owner.query(
      `INSERT INTO app.table_session_lease (id,session_id,tenant_id,branch_id,device_id,
         claimed_at,expires_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4, now() - interval '20 minutes',
               now() - interval '5 minutes')`,
      [s, tenantId, branchId, deviceA]);

    const state = await tx(() => leaseState(ctx(), { sessionId: s, deviceId: deviceA }));
    expect(state).toEqual({ held: false, why: 'expired' });
    await expect(tx(() => requireLease(ctx(), { sessionId: s, deviceId: deviceA })))
      .rejects.toThrow(LeaseNotHeldError);
    await expect(tx(() => renewLease(ctx(), { sessionId: s, deviceId: deviceA })))
      .rejects.toThrow(/no live lease/);
  });

  it.each([
    ['the same device', () => deviceA],
    ['another device', () => deviceB],
  ])('lets %s pick up a session whose lease expired, as a NEW lease', async (_who, claimant) => {
    // A tablet that went quiet must not keep its table: the floor offers
    // "tap to pick it up", and before this the claim was refused -- renewal for
    // the same device, "held" for another -- until a manager force-released it.
    const s = await makeSession();
    const oldToken = randomUUID();
    await owner.query(
      `INSERT INTO app.table_session_lease (id,session_id,tenant_id,branch_id,device_id,token,
         claimed_at,expires_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5, now() - interval '20 minutes',
               now() - interval '5 minutes')`,
      [s, tenantId, branchId, deviceA, oldToken]);

    const fresh = await tx(() => claimLease(ctx(), { sessionId: s, deviceId: claimant(), branchId }));
    expect(fresh.deviceId).toBe(claimant());
    // A new epoch, never the expired one revived: work queued under the old
    // token stays refused, as after a release.
    expect(fresh.token).not.toBe(oldToken);
    expect(new Date(fresh.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const state = await tx(() => leaseState(ctx(), { sessionId: s, deviceId: claimant() }));
    expect(state.held).toBe(true);

    const rows = await owner.query<{ token: string; closed: boolean; expired_first: boolean }>(
      `SELECT token::text, released_at IS NOT NULL AS closed, expires_at <= released_at AS expired_first
         FROM app.table_session_lease WHERE session_id = $1 ORDER BY claimed_at`, [s]);
    expect(rows.rows).toEqual([
      { token: oldToken, closed: true, expired_first: true },
      { token: fresh.token, closed: false, expired_first: null },
    ]);
  });

  it('still refuses another device while the lease is LIVE', async () => {
    const s = await makeSession();
    await tx(() => claimLease(ctx(), { sessionId: s, deviceId: deviceA, branchId }));
    await expect(tx(() => claimLease(ctx(), { sessionId: s, deviceId: deviceB, branchId })))
      .rejects.toThrow(LeaseHeldError);
  });

  it('makes release and force-release one-way, and forbids reassignment', async () => {
    const s = await makeSession();
    await tx(() => claimLease(ctx(), { sessionId: s, deviceId: deviceA, branchId }));
    await tx(() => releaseLease(ctx(), { sessionId: s, deviceId: deviceA }));

    await expect(owner.query(
      `UPDATE app.table_session_lease SET released_at = NULL WHERE session_id=$1`, [s]))
      .rejects.toThrow(/one-way/);
    await expect(owner.query(
      `UPDATE app.table_session_lease SET device_id=$2 WHERE session_id=$1`, [s, deviceB]))
      .rejects.toThrow(/cannot be reassigned/);

    // A released lease frees the session for the next device -- the partial
    // unique index is what allows that, per rule 11.
    await expect(tx(() => claimLease(ctx(), { sessionId: s, deviceId: deviceB, branchId })))
      .resolves.toBeTruthy();
  });

  it('requires attribution and a reason for a force release', async () => {
    const s = await makeSession();
    await tx(() => claimLease(ctx(), { sessionId: s, deviceId: deviceA, branchId }));

    await expect(owner.query(
      `UPDATE app.table_session_lease SET force_released_at = now() WHERE session_id=$1`, [s]))
      .rejects.toThrow(/force_release_attributed/);

    const { strandedDeviceId } = await tx(() =>
      forceReleaseLease(ctx(), { sessionId: s, byUserId: userId, reasonId: leaseReason }));
    expect(strandedDeviceId).toBe(deviceA);
  });
});

/* -------------------------------------------------------------- the sync --- */

describe('sync adjudicates before it applies', () => {
  it('quarantines everything from a force-released device, never merges it', async () => {
    const s = await makeSession();
    await tx(() => claimLease(ctx(), { sessionId: s, deviceId: deviceA, branchId }));
    await tx(() => forceReleaseLease(ctx(), { sessionId: s, byUserId: userId, reasonId: leaseReason }));

    const outcome = await tx(() =>
      receiveBatch(ctx(), batch({ sessionId: s, clientBatchNo: 10 }), noop));

    expect(outcome.status).toBe('quarantined');
    expect(outcome.reason).toBe('lease_force_released');
    expect(outcome.appliedOperations).toBe(0);

    // The payload survives verbatim: a quarantined batch is evidence.
    const held = await owner.query<{ payload: { clientBatchNo: number } }>(
      `SELECT payload FROM app.sync_quarantine WHERE sync_batch_id=$1`, [outcome.batchId]);
    expect(held.rows[0]!.payload.clientBatchNo).toBe(10);
  });

  it('quarantines a batch older than the offline window rather than absorbing it', async () => {
    const s = await makeSession();
    await tx(() => claimLease(ctx(), { sessionId: s, deviceId: deviceA, branchId }));

    const weekOld = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
    const outcome = await tx(() =>
      receiveBatch(ctx(), batch({ sessionId: s, clientBatchNo: 11, offlineSince: weekOld }), noop));

    expect(outcome.status).toBe('quarantined');
    expect(outcome.reason).toBe('stale_beyond_window');
    expect(outcome.detail).toMatch(/average cost|purged/);
  });

  it('quarantines a forbidden operation instead of silently dropping it', async () => {
    const s = await makeSession();
    await tx(() => claimLease(ctx(), { sessionId: s, deviceId: deviceA, branchId }));

    const outcome = await tx(() => receiveBatch(ctx(), batch({
      sessionId: s, clientBatchNo: 12,
      operations: [
        { kind: 'order.line.add', idempotencyKey: randomUUID(), sessionId: s, businessDate: DATE, payload: {} },
        { kind: 'payment.tender', idempotencyKey: randomUUID(), sessionId: s, businessDate: DATE, payload: {} },
      ],
    }), noop));

    expect(outcome.status).toBe('quarantined');
    expect(outcome.reason).toBe('forbidden_operation');
    // The whole batch, not the allowed prefix: applying half a batch leaves the
    // device's view and the server's permanently divergent.
    expect(outcome.appliedOperations).toBe(0);
  });

  it('applies an in-window batch under a live lease, in device order', async () => {
    const s = await makeSession();
    await tx(() => claimLease(ctx(), { sessionId: s, deviceId: deviceA, branchId }));

    const seen: string[] = [];
    const outcome = await tx(() => receiveBatch(ctx(), batch({
      sessionId: s, clientBatchNo: 13,
      operations: ['order.line.add', 'order.line.edit_prefire', 'kot.fire'].map((kind) => ({
        kind: kind as 'kot.fire', idempotencyKey: randomUUID(),
        sessionId: s, businessDate: DATE, payload: { kind },
      })),
    }), async (op) => { seen.push(op.kind); }));

    expect(outcome.status).toBe('applied');
    expect(seen).toEqual(['order.line.add', 'order.line.edit_prefire', 'kot.fire']);
  });

  it('records a batch row either way, so a device stops retrying forever', async () => {
    const rows = await owner.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM app.sync_batch
        WHERE tenant_id=$1 GROUP BY status ORDER BY status`, [tenantId]);
    const byStatus = Object.fromEntries(rows.rows.map((r) => [r.status, Number(r.n)]));
    expect(byStatus['applied']).toBeGreaterThan(0);
    expect(byStatus['quarantined']).toBeGreaterThan(0);

    const open = await tx(() => openQuarantine(ctx(), { branchId }));
    expect(open.length).toBe(byStatus['quarantined']);
  });

  it('rejects a replayed batch number from the same device', async () => {
    const s = await makeSession();
    await tx(() => claimLease(ctx(), { sessionId: s, deviceId: deviceA, branchId }));
    await tx(() => receiveBatch(ctx(), batch({ sessionId: s, clientBatchNo: 99 }), noop));
    await expect(tx(() => receiveBatch(ctx(), batch({ sessionId: s, clientBatchNo: 99 }), noop)))
      .rejects.toThrow(/sync_batch_device_no_unique/);
  });

  it('drains queued deductions in business-date order, not arrival order', () => {
    const arrival = [
      { kotId: 'c', businessDate: '2026-04-03' },
      { kotId: 'a', businessDate: '2026-04-01' },
      { kotId: 'b', businessDate: '2026-04-02' },
    ];
    expect(orderDeductionQueue(arrival).map((q) => q.kotId)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the allowed and forbidden sets disjoint and named', () => {
    assertCheckedSet({
      label: 'offline allowed operations',
      checked: [...OFFLINE_ALLOWED],
      minimum: 5,
      mustInclude: ['order.line.add', 'kot.fire', 'session.open'],
    });
    assertCheckedSet({
      label: 'offline forbidden operations',
      checked: [...OFFLINE_FORBIDDEN],
      minimum: 7,
      mustInclude: ['bill.generate', 'payment.tender', 'payment.refund',
                    'order.void', 'order.comp', 'order.discount'],
    });
    const overlap = OFFLINE_ALLOWED.filter((k) => (OFFLINE_FORBIDDEN as readonly string[]).includes(k));
    expect(overlap).toEqual([]);
  });
});

/* ------------------------------------------------------ the coupled window */

describe('the offline window and claim retention are ONE constraint', () => {
  it('holds today, with the stated margin', () => {
    expect(() => assertOfflineWindowFitsClaimRetention()).not.toThrow();
    expect(OFFLINE_WINDOW_HOURS * OFFLINE_WINDOW_SAFETY_FACTOR)
      .toBeLessThan(REQUEST_CLAIM_RETENTION_DAYS * 24);
  });

  it('fails when either constant is moved without the other', () => {
    // Raising the window alone.
    expect(() => assertOfflineWindowFitsClaimRetention(72, REQUEST_CLAIM_RETENTION_DAYS))
      .toThrow(/one constraint/);
    // Lowering retention alone.
    expect(() => assertOfflineWindowFitsClaimRetention(OFFLINE_WINDOW_HOURS, 2))
      .toThrow(/replay/);
    // Moving both together stays legal.
    expect(() => assertOfflineWindowFitsClaimRetention(72, 21)).not.toThrow();
  });

  it('matches the retention the migration actually implements', async () => {
    const def = await owner.query<{ def: string }>(
      `SELECT pg_get_functiondef(oid) AS def FROM pg_proc
        WHERE proname = 'purge_request_claims'`);
    // The TS constant is a mirror of the SQL default; if someone changes the SQL
    // this catches the mirror going stale.
    expect(def.rows[0]!.def).toMatch(
      new RegExp(`retain_days integer DEFAULT ${REQUEST_CLAIM_RETENTION_DAYS}`));
  });
});

/* -------------------------------------------- out-of-band money, recorded --- */

describe('manual settlement records money taken outside the system', () => {
  async function makeBill(totalMinor: number): Promise<string> {
    const sessionId = await makeSession();
    const orderId = randomUUID(), billId = randomUUID(), lineId = randomUUID();
    await owner.query(
      `INSERT INTO app.sales_order (id,tenant_id,branch_id,session_id,business_date,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5::date,$6)`, [orderId, tenantId, branchId, sessionId, DATE, userId]);
    await owner.query(
      `INSERT INTO app.order_line (id,tenant_id,branch_id,order_id,kind,display_name,
         unit_price_minor,quantity,line_total_minor,created_by_user_id)
       VALUES ($1,$2,$3,$4,'item','Dish',$5,1,$5,$6)`,
      [lineId, tenantId, branchId, orderId, totalMinor, userId]);

    // The bill and its lines are ONE transaction: the balance trigger is
    // DEFERRABLE INITIALLY DEFERRED and fires at COMMIT, so a bill committed
    // alone is a bill with no lines. That is the invariant working, not a
    // fixture inconvenience.
    await owner.query('BEGIN');
    await owner.query(
      `INSERT INTO app.bill (id,tenant_id,branch_id,session_id,business_date,bill_no,
         split_kind,subtotal_minor,tax_minor,total_minor,generated_by_user_id,tax_treatment,
         tax_jurisdiction,premises_class,tax_account_type,prices_include_tax,currency)
       VALUES ($1,$2,$3,$4,$5::date,$6,'whole',$7,0,$7,$8,'none','IN','standard','gst',false,'INR')`,
      [billId, tenantId, branchId, sessionId, DATE,
       Math.floor(Math.random() * 1e9), totalMinor, userId]);
    await owner.query(
      `INSERT INTO app.bill_line (id,tenant_id,bill_id,order_line_id,share_bps,
         display_name,amount_minor,tax_minor)
       VALUES (gen_random_uuid(),$1,$2,$3,10000,'Dish',$4,0)`,
      [tenantId, billId, lineId, totalMinor]);
    await owner.query('COMMIT');
    return billId;
  }

  it('requires a reference, an authoriser and a reason', async () => {
    const billId = await makeBill(50000);
    await expect(tx(() => recordManualSettlement(ctx(), {
      billId, method: 'card', amountMinor: 50000, operatorReference: '  ',
      reasonId: manualReason, authorisedByUserId: userId, tenderedByUserId: userId,
    }))).rejects.toThrow(ManualSettlementIncompleteError);

    // And the schema refuses it too, independently of the application check.
    await expect(owner.query(
      `INSERT INTO app.tender (id,tenant_id,bill_id,kind,method,amount_minor,
         tendered_by_user_id,settled_offline_manually)
       VALUES ($1,$2,$3,'capture','card',50000,$4,true)`,
      [randomUUID(), tenantId, billId, userId]))
      .rejects.toThrow(/manual_settlement_complete/);
  });

  it('records the tender and surfaces it for the exception report', async () => {
    const billId = await makeBill(75000);
    const { tenderId } = await tx(() => recordManualSettlement(ctx(), {
      billId, method: 'card', amountMinor: 75000,
      operatorReference: 'SLIP-4471', reasonId: manualReason,
      authorisedByUserId: userId, tenderedByUserId: userId,
    }));
    expect(tenderId).toBeTruthy();

    const rows = await tx(() =>
      manualSettlementsForPeriod(ctx(), { branchId, fromDate: DATE, toDate: DATE }));
    const hit = rows.find((r) => r.tenderId === tenderId);
    expect(hit).toBeDefined();
    expect(hit!.operatorReference).toBe('SLIP-4471');
    expect(hit!.amountMinor).toBe(75000);
  });

  it('is NOT offline settlement: no device may tender offline', () => {
    // The distinction the whole feature rests on. If payment.tender ever became
    // an allowed offline operation this assertion is the thing that fails.
    expect((OFFLINE_ALLOWED as readonly string[])).not.toContain('payment.tender');
    expect(OFFLINE_FORBIDDEN).toContain('payment.tender');
  });
});

/* ------------------------------------------------------------ permissions --- */

describe('the two new keys are classed and placed correctly', () => {
  it('makes force-release escalation-class and manual settlement financial', () => {
    const byKey = Object.fromEntries(
      (PERMISSIONS as readonly { key: string; riskClass?: string; riskSubclass?: string }[])
        .map((p) => [p.key, p]));
    expect(byKey['table.session.lease.force_release']!.riskClass).toBe('escalation');
    expect(byKey['payment.settle.manual']!.riskClass).toBe('financial');
    // Transaction, not configuration: it belongs in the section an owner scans
    // for till fraud, not the one for menu edits.
    expect(byKey['payment.settle.manual']!.riskSubclass).toBe('transaction');
  });

  it('keeps the escalation key off every broadly assigned role', () => {
    for (const key of ['waiter', 'cashier', 'kds']) {
      const role = SYSTEM_ROLES.find((r) => r.key === key)!;
      expect(role.permissions, `${key}`).not.toContain('table.session.lease.force_release');
      expect(role.permissions, `${key}`).not.toContain('payment.settle.manual');
    }
    const manager = SYSTEM_ROLES.find((r) => r.key === 'manager')!;
    expect(manager.permissions).toContain('table.session.lease.force_release');
    expect(manager.permissions).toContain('payment.settle.manual');
  });
});

/* ---------------------------------------------------------- paper trail --- */

describe('a KOT always carries something a human can read aloud', () => {
  it('accepts a device-local reference when the sequence is not yet assigned', () => {
    const ref = localKotReference(deviceA, 17);
    expect(ref).toMatch(/^L-[A-Za-z0-9]{4,12}-\d+$/);
  });

  it('refuses a KOT with neither a sequence nor a local reference', async () => {
    const sessionId = await makeSession();
    const orderId = randomUUID(), fireId = randomUUID();
    const stationId = randomUUID();
    await owner.query(`INSERT INTO app.station_code (tenant_id,code,name) VALUES ($1,'grill','Grill')
      ON CONFLICT DO NOTHING`, [tenantId]);
    await owner.query(
      `INSERT INTO app.kitchen_station (id,tenant_id,branch_id,code,name)
       VALUES ($1,$2,$3,'grill','Grill')`, [stationId, tenantId, branchId]);
    await owner.query(
      `INSERT INTO app.sales_order (id,tenant_id,branch_id,session_id,business_date,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5::date,$6)`, [orderId, tenantId, branchId, sessionId, DATE, userId]);
    await owner.query(
      `INSERT INTO app.kot_fire (id,tenant_id,branch_id,order_id,business_date,fire_no,fired_by_user_id)
       VALUES ($1,$2,$3,$4,$5::date,1,$6)`, [fireId, tenantId, branchId, orderId, DATE, userId]);

    await expect(owner.query(
      `INSERT INTO app.kot (id,tenant_id,branch_id,fire_id,station_id,business_date)
       VALUES ($1,$2,$3,$4,$5,$6::date)`,
      [randomUUID(), tenantId, branchId, fireId, stationId, DATE]))
      .rejects.toThrow(/human_reference/);

    // The offline ticket is legal precisely because it carries the device's own.
    await expect(owner.query(
      `INSERT INTO app.kot (id,tenant_id,branch_id,fire_id,station_id,business_date,local_reference)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7)`,
      [randomUUID(), tenantId, branchId, fireId, stationId, DATE, localKotReference(deviceA, 3)]))
      .resolves.toBeTruthy();
  });
});
