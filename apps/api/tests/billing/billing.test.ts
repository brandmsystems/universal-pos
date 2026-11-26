import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';
import {
  determinePlaceOfSupply, componentsForLine, roundOffMinor, stateCodeOfGstin,
  assertProfileCoherent, TaxProfileInvalidError,
  type SupplierRegistration, type TenantTaxProfile,
} from '../../src/modules/billing/placeOfSupply.js';
import { allocateSegmentCharges, directionOfChange, uninvoicedSegments } from '../../src/modules/billing/segments.js';
import {
  generateInvoice, cancelSubscriptionWithFinalInvoice,
} from '../../src/modules/billing/invoicing.js';
import {
  scheduleContraction, revokeScheduledChange, pendingChangeFor, applyDueChanges,
  applyExpansion, PendingChangeExistsError,
} from '../../src/modules/billing/scheduledChange.js';
import {
  ingestWebhook, recordPayment, verifySignature, redactPan,
  reconcileAgainstGateway, PanRefusedError,
} from '../../src/modules/billing/webhooks.js';
import {
  recordAttempt, scheduleFirstAttempt, nextAttemptAt, dunningQueue, recordOutreach,
  dunningConfig,
} from '../../src/modules/billing/dunning.js';
import { provisionTenant } from '../../src/modules/platform/provisioning.js';
import { seedPlatformAuthz, seedPermissionCatalogue } from '../../src/modules/authz/seed.js';

let owner: pg.Client;
let superAdminId: string;
let planId: string, planVersionId: string, smallPlanId: string, smallPlanVersionId: string;

const KA = '29', MH = '27';
const SUPPLIER: SupplierRegistration = {
  gstin: '29AABCU9603R1ZM', stateCode: KA,
  legalName: 'Katkitchen Technologies Private Limited', address: 'Bengaluru',
};

function profile(over: Partial<TenantTaxProfile> = {}): TenantTaxProfile {
  return {
    legalName: 'Test Restaurant LLP', gstin: null, stateCode: KA,
    countryCode: 'IN', billingAddress: 'Somewhere', isSez: false,
    lutNumber: null, financialYearStartsMonth: 4, ...over,
  };
}

/** A tenant with a full billing setup. */
async function makeBillingTenant(opts: {
  gstin?: string | null; stateCode?: string; countryCode?: string;
  isSez?: boolean; lut?: string | null; fyStart?: number;
} = {}): Promise<{ tenantId: string; subscriptionId: string; branchId: string }> {
  const key = `bil-${randomUUID()}`;
  const r = await inTx(() => provisionTenant(owner, {
    idempotencyKey: key, slug: `b${key.slice(4, 12)}`, name: 'Billing Probe',
    currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: `${key}@o.test`,
    ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
    taxJurisdiction: 'IN',
    requestedByPlatformUserId: superAdminId,
  }));

  const exempt = opts.isSez || (opts.countryCode && opts.countryCode !== 'IN');
  await owner.query(
    `INSERT INTO platform.tenant_tax_profile
       (tenant_id, legal_name, gstin, state_code, country_code, billing_address,
        is_sez, sez_loa_number, lut_number, financial_year_starts_month,
        exemption_granted_by_platform_user_id, exemption_granted_at, exemption_evidence)
     VALUES ($1,'Test Restaurant LLP',$2,$3,$4,'Somewhere',$5,$6,$7,$8,$9,$10,$11)`,
    [r.tenantId, opts.gstin ?? null, opts.stateCode ?? KA, opts.countryCode ?? 'IN',
     opts.isSez ?? false, opts.isSez ? 'LOA/2026/1' : null,
     opts.lut ?? (exempt ? 'LUT/2026/44' : null), opts.fyStart ?? 4,
     exempt ? superAdminId : null, exempt ? new Date() : null,
     exempt ? 'Scanned LOA on file' : null],
  );

  const sub = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.subscription WHERE tenant_id = $1`, [r.tenantId])).rows[0]!;
  await owner.query(
    `UPDATE platform.subscription
        SET current_period_start = '2026-06-01T00:00:00Z',
            current_period_end   = '2026-07-01T00:00:00Z' WHERE id = $1`, [sub.id]);
  // #########################################################################
  // THIS USED TO INSERT THE OPENING SEGMENT, AND THAT IS WHY NO TENANT WAS EVER
  // INVOICED.
  //
  // `provisionTenant` created a subscription and no segment. `generateInvoice`
  // bills SEGMENTS, so a real tenant's invoice run found nothing, forever, with
  // a healthy-looking subscription row. Every assertion in this file passed
  // because this fixture supplied by hand the one row the production path
  // omitted -- the classic shape: code that is correct, tested, and joined to
  // the running system by nothing.
  //
  // So it MOVES the segment provisioning opened instead of adding one, and it
  // refuses if there is not exactly one to move. The fixture that hid the defect
  // is now the assertion that it stays fixed.
  // #########################################################################
  const moved = await owner.query(
    `UPDATE platform.subscription_segment
        SET starts_at = '2026-06-01T00:00:00Z'
      WHERE tenant_id = $1 AND subscription_id = $2 AND ends_at IS NULL`,
    [r.tenantId, sub.id]);
  if (moved.rowCount !== 1) {
    throw new Error(
      `provisionTenant left ${moved.rowCount} open subscription segments, not 1. ` +
        'Without exactly one, generateInvoice has nothing to bill and every ' +
        'billing assertion below would be measuring this fixture.',
    );
  }

  return { tenantId: r.tenantId, subscriptionId: sub.id, branchId: r.firstBranchId };
}

/** BEGIN/COMMIT with a guaranteed ROLLBACK, so one failure cannot poison the rest. */
async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  await owner.query('BEGIN');
  try {
    const result = await fn();
    await owner.query('COMMIT');
    return result;
  } catch (error) {
    await owner.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

const PERIOD = {
  periodStart: new Date('2026-06-01T00:00:00Z'),
  periodEnd: new Date('2026-07-01T00:00:00Z'),
  upTo: new Date('2026-07-01T00:00:00Z'),
  issueDate: '2026-07-01',
};

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
  await seedPermissionCatalogue(owner);
  await seedPlatformAuthz(owner);

  const roleId = (await owner.query<{ id: string }>(
    `SELECT id FROM platform.platform_role WHERE key='super_admin'`)).rows[0]!.id;
  superAdminId = randomUUID();
  await owner.query(
    `INSERT INTO platform.platform_user (id,email,password_hash,full_name,platform_role_id)
     VALUES ($1,$2,'argon2id$stub','Root',$3)`, [superAdminId, `bil+${superAdminId}@p.test`, roleId]);

  await owner.query(
    `INSERT INTO platform.supplier_gst_registration
       (id, state_code, gstin, legal_name, address, is_default)
     VALUES ($1,$2,$3,$4,'Bengaluru',true) ON CONFLICT DO NOTHING`,
    [randomUUID(), SUPPLIER.stateCode, SUPPLIER.gstin, SUPPLIER.legalName]);

  // #########################################################################
  // DO UPDATE, NOT DO NOTHING, AND THIS FIXTURE MEASURED LEFTOVER STATE.
  //
  // These two plan rows are keyed by a FIXED key, so on any install this file
  // has run against before, both inserts conflict and `DO NOTHING` kept
  // whatever the previous run left -- including `currency`, which THIS FILE
  // deliberately mutates: "refuses a period whose segments disagree about the
  // currency" sets a version to USD and restores INR in a `finally`. A
  // `finally` does not survive a killed process, a crashed worker, or a
  // Ctrl-C.
  //
  // The symptom when that happens is the one nobody would trace to a fixture:
  // both segments end up in the SAME currency, so the period no longer
  // disagrees, `generateInvoice` succeeds, and the test that exists to prove a
  // refusal reports `promise resolved instead of rejecting`. It reproduced
  // exactly by leaving one row on USD -- one failure, that message, everything
  // else green.
  //
  // So the fixture now FORCES the values it goes on to assert against. Same
  // rule as the run-scoped topics in tests/platform/outboxWorker.test.ts and
  // the reason the tax-class test rolls back its odd rate: a fixture may set up
  // state, and it may not inherit state it then measures.
  // #########################################################################
  for (const [key, name, price, limits] of [
    ['bil_pro', 'Pro', 500000, { branches: 10 }],
    ['bil_small', 'Small', 100000, { branches: 2 }],
  ] as const) {
    const pid = randomUUID();
    await owner.query(
      `INSERT INTO platform.plan (id,key,name) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name`,
      [pid, key, name]);
    const actual = (await owner.query<{ id: string }>(
      `SELECT id FROM platform.plan WHERE key=$1`, [key])).rows[0]!.id;
    await owner.query(
      `INSERT INTO platform.plan_version
         (id,plan_id,version,price_minor,currency,billing_period,published_at,limits)
       VALUES ($1,$2,1,$3,'INR','monthly',now(),$4::jsonb)
       ON CONFLICT (plan_id,version) DO UPDATE
         SET price_minor = EXCLUDED.price_minor,
             currency    = EXCLUDED.currency,
             limits      = EXCLUDED.limits`,
      [randomUUID(), actual, price, JSON.stringify(limits)]);
    const vid = (await owner.query<{ id: string }>(
      `SELECT id FROM platform.plan_version WHERE plan_id=$1 AND version=1`, [actual])).rows[0]!.id;
    if (key === 'bil_pro') { planId = actual; planVersionId = vid; }
    else { smallPlanId = actual; smallPlanVersionId = vid; }
  }

  // Non-vacuity, and the assertion the comment above is really about: if the
  // forcing above ever stops working, every currency assertion in this file
  // silently starts measuring whatever is in the database instead.
  const seeded = await owner.query<{ key: string; currency: string; price_minor: string }>(
    `SELECT p.key, pv.currency, pv.price_minor::text
       FROM platform.plan p JOIN platform.plan_version pv ON pv.plan_id = p.id
      WHERE p.key IN ('bil_pro','bil_small') AND pv.version = 1
      ORDER BY p.key`);
  expect(
    seeded.rows,
    'the plan fixture did not land the values this file asserts against; every '
      + 'currency and proration assertion below would be measuring leftover state',
  ).toEqual([
    { key: 'bil_pro', currency: 'INR', price_minor: '500000' },
    { key: 'bil_small', currency: 'INR', price_minor: '100000' },
  ]);
});

afterAll(async () => { await owner?.end(); });

/* --------------------------------------------------------- place of supply */

describe('A. GST place of supply', () => {
  it('reads the state from the GSTIN, which is the authority', () => {
    expect(stateCodeOfGstin('29AABCU9603R1ZM')).toBe('29');
    expect(() => stateCodeOfGstin('NOTAGSTIN')).toThrow(TaxProfileInvalidError);
  });

  it('refuses a GSTIN whose state contradicts the address, rather than reconciling', () => {
    // One of the two is wrong and we cannot know which. Guessing produces
    // invoices confidently addressed to the wrong jurisdiction.
    expect(() => assertProfileCoherent(profile({ gstin: '27AABCU9603R1ZM', stateCode: KA })))
      .toThrow(/One of them is wrong/);
  });

  it('splits intra-state into CGST and SGST and inter-state into IGST', () => {
    const same = determinePlaceOfSupply(profile({ gstin: '29AABCU9603R1ZM' }), SUPPLIER);
    expect(same.treatment).toBe('intra_state');
    const other = determinePlaceOfSupply(
      profile({ gstin: '27AABCU9603R1ZM', stateCode: MH }), SUPPLIER);
    expect(other.treatment).toBe('inter_state');

    expect(componentsForLine('intra_state', 100000, 1800).map((c) => c.name))
      .toEqual(['CGST', 'SGST']);
    expect(componentsForLine('inter_state', 100000, 1800).map((c) => c.name)).toEqual(['IGST']);
    // The halves must sum to the whole -- 9% + 9% = 18%, never 8.99 + 9.
    const halves = componentsForLine('intra_state', 100001, 1800);
    const igst = componentsForLine('inter_state', 100001, 1800);
    expect(halves.reduce((a, c) => a + c.amountMinor, 0))
      .toBe(igst.reduce((a, c) => a + c.amountMinor, 0));
  });

  it('treats an SEZ unit in our OWN state as inter-state, not intra-state', () => {
    // The case a naive state comparison gets wrong.
    const sez = determinePlaceOfSupply(
      profile({ gstin: '29AABCU9603R1ZM', isSez: true, lutNumber: 'LUT/1' }), SUPPLIER);
    expect(sez.treatment).toBe('sez');
    expect(componentsForLine('sez', 100000, 1800)).toEqual([]);
  });

  it('zero-rates an export and requires an LUT, the pay-and-refund route being excluded', () => {
    const exp = determinePlaceOfSupply(
      profile({ countryCode: 'AE', lutNumber: 'LUT/2' }), SUPPLIER);
    expect(exp.treatment).toBe('export');
    expect(exp.stateCode).toBe('96');
    expect(() => determinePlaceOfSupply(profile({ countryCode: 'AE' }), SUPPLIER))
      .toThrow(/Letter of Undertaking only/);
  });

  it('rounds the grand total to a whole rupee in both directions', () => {
    expect(roundOffMinor(10049)).toBe(-49);
    expect(roundOffMinor(10051)).toBe(49);
    expect(roundOffMinor(10000)).toBe(0);
    expect(roundOffMinor(10050)).toBe(-50);
  });
});

/* ------------------------------------------------------------- invoicing --- */

describe('A. a provisioned tenant is invoiceable at all, and the trial is free', () => {
  /**
   * #######################################################################
   * THE PATH NOTHING TESTED: PROVISION, WAIT, INVOICE.
   *
   * Every other assertion in this file starts from a fixture that moved the
   * opening segment into a known window. This one starts from `provisionTenant`
   * and touches no segment, because the defect was precisely that provisioning
   * opened none -- so a test that supplies one cannot see it.
   * #######################################################################
   */
  async function provisionOnly(): Promise<{ tenantId: string; subscriptionId: string;
    trialEnd: Date; }> {
    const key = `trial-${randomUUID()}`;
    const r = await inTx(() => provisionTenant(owner, {
      idempotencyKey: key, slug: `t${key.slice(6, 14)}`, name: 'Trial Probe',
      currency: 'INR', timezone: 'Asia/Kolkata', ownerEmail: `${key}@o.test`,
      ownerName: 'Owner', firstBranchName: 'Main', planVersionId,
      taxJurisdiction: 'IN',
      requestedByPlatformUserId: superAdminId,
    }));
    await owner.query(
      `INSERT INTO platform.tenant_tax_profile
         (tenant_id, legal_name, gstin, state_code, country_code, billing_address,
          is_sez, financial_year_starts_month)
       VALUES ($1,'Trial Restaurant LLP','29AABCU9603R1ZM',$2,'IN','Somewhere',false,4)`,
      [r.tenantId, KA]);
    const sub = (await owner.query<{ id: string; current_period_end: string }>(
      `SELECT id, current_period_end FROM platform.subscription WHERE tenant_id = $1`,
      [r.tenantId])).rows[0]!;
    return {
      tenantId: r.tenantId,
      subscriptionId: sub.id,
      trialEnd: new Date(sub.current_period_end),
    };
  }

  it('opens exactly one segment, and it begins where the trial ends', async () => {
    const t = await provisionOnly();
    const segments = await owner.query<{ starts_at: string; ends_at: string | null;
      quantity: number; }>(
      `SELECT starts_at, ends_at, quantity FROM platform.subscription_segment
        WHERE tenant_id = $1 ORDER BY starts_at`, [t.tenantId]);

    expect(segments.rows).toHaveLength(1);
    expect(new Date(segments.rows[0]!.starts_at).getTime())
      .toBe(t.trialEnd.getTime());
    // Open-ended: it is closed by the next plan change or cancellation, not by
    // provisioning guessing when the tenant will leave.
    expect(segments.rows[0]!.ends_at).toBeNull();
    expect(segments.rows[0]!.quantity).toBe(1);
  });

  it('does not start billing early when the plan changes DURING the trial', async () => {
    // ######################################################################
    // THE CASE THE SCHEMA FOUND, NOT A TYPO.
    //
    // `openSegment` closed the open segment by setting `ends_at = at`. With the
    // first segment starting at the TRIAL'S END, an upgrade on day three made
    // `ends_at` earlier than `starts_at` and `subscription_segment_ordered`
    // refused the whole change with a 409.
    //
    // Closing was the wrong verb: a segment that has not started has accrued
    // nothing, so it is superseded. And the replacement INHERITS its start --
    // otherwise the upgrade would begin billing on day three, ending the free
    // trial early, silently, in the tenant's disfavour.
    // ######################################################################
    const t = await provisionOnly();
    const smallPrice = (await owner.query<{ price_minor: string }>(
      `SELECT price_minor::text FROM platform.plan_version WHERE id=$1`,
      [smallPlanVersionId])).rows[0]!;

    const applied = await inTx(() => applyExpansion(owner, {
      tenantId: t.tenantId, subscriptionId: t.subscriptionId,
      planId: smallPlanId, planVersionId: smallPlanVersionId, quantity: 4,
      currentPriceMinor: Number(smallPrice.price_minor), currentQuantity: 1,
      targetPriceMinor: Number(smallPrice.price_minor),
      at: new Date(t.trialEnd.getTime() - 11 * 86_400_000),
    }));

    const segments = await owner.query<{ id: string; starts_at: string;
      ends_at: string | null; quantity: number; }>(
      `SELECT id, starts_at, ends_at, quantity FROM platform.subscription_segment
        WHERE tenant_id=$1 ORDER BY starts_at`, [t.tenantId]);

    // One segment, not two: nothing was closed, because nothing had begun.
    expect(segments.rows).toHaveLength(1);
    expect(segments.rows[0]!.id).toBe(applied.segmentId);
    expect(segments.rows[0]!.quantity).toBe(4);
    // Still the trial's end. This is the assertion that the trial was not cut
    // short by the upgrade.
    expect(new Date(segments.rows[0]!.starts_at).getTime()).toBe(t.trialEnd.getTime());
    expect(segments.rows[0]!.ends_at).toBeNull();
  });

  it('bills nothing while the tenant is still inside the trial', async () => {
    const t = await provisionOnly();
    const during = new Date(t.trialEnd.getTime() - 86_400_000);
    const invoice = await inTx(() => generateInvoice(owner, {
      tenantId: t.tenantId, subscriptionId: t.subscriptionId,
      periodStart: new Date(t.trialEnd.getTime() - 14 * 86_400_000),
      periodEnd: during, upTo: during,
      issueDate: during.toISOString().slice(0, 10),
    }));
    // Not an error and not a zero invoice: there is genuinely nothing to bill,
    // because the only segment has not started. A zero invoice would enter the
    // gapless series and have to be explained to the tenant forever.
    expect(invoice).toBeNull();
  });

  it('bills the first period once the trial has ended', async () => {
    const t = await provisionOnly();
    const after = new Date(t.trialEnd.getTime() + 30 * 86_400_000);
    const invoice = await inTx(() => generateInvoice(owner, {
      tenantId: t.tenantId, subscriptionId: t.subscriptionId,
      periodStart: t.trialEnd, periodEnd: after, upTo: after,
      issueDate: after.toISOString().slice(0, 10),
    }));

    expect(invoice, 'a provisioned tenant must be invoiceable').not.toBeNull();
    expect(invoice!.totalMinor).toBeGreaterThan(0);
    expect(invoice!.number).toMatch(/000001$/);
  });
});

describe('A. invoice generation', () => {
  it('takes the currency from the plan version, not from a literal', async () => {
    // The insert wrote 'INR' while plan_version.currency has been a column
    // since migration 0013. Harmless for one country and wrong in the worst way
    // for two: the AMOUNTS would be the foreign ones while the document said
    // rupees.
    const t = await makeBillingTenant({ gstin: '29AABCU9603R1ZM' });
    const inv = await inTx(() => generateInvoice(owner, { ...PERIOD, ...t }));
    const row = (await owner.query<{ currency: string }>(
      `SELECT currency FROM platform.invoice WHERE id=$1`, [inv!.invoiceId])).rows[0]!;
    const planCurrency = (await owner.query<{ currency: string }>(
      `SELECT currency FROM platform.plan_version WHERE id=$1`, [planVersionId])).rows[0]!;
    expect(row.currency).toBe(planCurrency.currency);
  });

  it('refuses a period whose segments disagree about the currency', async () => {
    // A plan re-priced into another currency mid-period. One invoice carries one
    // currency, so this is a decision about the customer rather than something
    // to resolve by picking the first segment.
    const t = await makeBillingTenant({ gstin: '29AABCU9603R1ZM' });
    // Two segments in one period on two plan versions -- a mid-period change --
    // and the second version priced in another currency. One segment on one
    // version can never disagree with itself, which is why this needs both.
    await owner.query(
      `UPDATE platform.subscription_segment SET ends_at='2026-06-15T00:00:00Z'
        WHERE tenant_id=$1 AND ends_at IS NULL`, [t.tenantId]);
    await owner.query(
      `INSERT INTO platform.subscription_segment
         (id, tenant_id, subscription_id, plan_id, plan_version_id, quantity, starts_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,1,'2026-06-15T00:00:00Z')`,
      [t.tenantId, t.subscriptionId, smallPlanId, smallPlanVersionId]);
    await owner.query(
      `UPDATE platform.plan_version SET currency='USD' WHERE id=$1`, [smallPlanVersionId]);
    try {
      // NON-VACUITY, in the test rather than only in the fixture.
      //
      // This assertion exists because its absence cost an afternoon. With one
      // plan version left on USD by an earlier killed run, BOTH segments came
      // out in the same currency, the period no longer disagreed,
      // `generateInvoice` succeeded, and the only symptom was `promise resolved
      // instead of rejecting` -- which reads as a broken refusal rather than a
      // fixture that had nothing to refuse. `beforeAll` now forces these rows;
      // this proves the setup landed, right where the refusal is expected.
      const priced = await owner.query<{ currency: string }>(
        `SELECT DISTINCT pv.currency
           FROM platform.subscription_segment s
           JOIN platform.plan_version pv ON pv.id = s.plan_version_id
          WHERE s.tenant_id = $1 AND s.invoiced_on_invoice_id IS NULL
          ORDER BY 1`, [t.tenantId]);
      expect(
        priced.rows.map((r) => r.currency),
        'the period must actually disagree, or the refusal below has nothing to refuse',
      ).toEqual(['INR', 'USD']);

      // ###################################################################
      // AND THE SAME QUESTION ASKED THROUGH THE READER ITSELF.
      //
      // The assertion above proves the ROWS disagree. It does not prove
      // `generateInvoice` SEES them disagree, and those are two different
      // claims -- the first version of this test asserted only the first, and
      // a run where the refusal did not fire still showed the data mixed.
      // `uninvoicedSegments` is the exact read `generateInvoice` makes; if it
      // comes back with one currency while the rows hold two, the fault is in
      // the read's predicates, not in the fixture, and the message says which
      // segments it actually returned.
      // ###################################################################
      const read = await uninvoicedSegments(owner, {
        tenantId: t.tenantId, subscriptionId: t.subscriptionId, upTo: PERIOD.upTo,
      });
      expect(
        [...new Set(read.map((seg) => seg.currency))].sort(),
        'generateInvoice reads the period through uninvoicedSegments, and it came '
          + 'back agreeing with itself while the rows disagree. What it returned: '
          + JSON.stringify(read.map((seg) => ({
            plan: seg.planKey,
            version: seg.planVersionId,
            currency: seg.currency,
            from: seg.startsAt.toISOString(),
            to: seg.endsAt ? seg.endsAt.toISOString() : null,
          }))),
      ).toEqual(['INR', 'USD']);

      await expect(inTx(() => generateInvoice(owner, { ...PERIOD, ...t })))
        .rejects.toThrow(/priced in/);
    } finally {
      await owner.query(
        `UPDATE platform.plan_version SET currency='INR' WHERE id=$1`, [smallPlanVersionId]);
    }
  });

  it('numbers gaplessly per tenant per financial year, and issues a coherent invoice', async () => {
    const t = await makeBillingTenant({ gstin: '29AABCU9603R1ZM' });
    const inv = await inTx(() => generateInvoice(owner, { ...PERIOD, ...t }));

    expect(inv).not.toBeNull();
    // Series code, then financial year, then a consecutive number within it.
    expect(inv!.number).toMatch(/^INV\/B[A-Z0-9-]+\/2026-27\/000001$/);
    expect(inv!.treatment).toBe('intra_state');
    expect(inv!.totalMinor % 100).toBe(0);
    expect(inv!.totalMinor).toBe(inv!.subtotalMinor + inv!.taxMinor + inv!.roundOffMinor);

    const comps = await owner.query<{ name: string }>(
      `SELECT DISTINCT name FROM platform.invoice_tax_component
        WHERE invoice_id=$1 ORDER BY name`, [inv!.invoiceId]);
    expect(comps.rows.map((c) => c.name)).toEqual(['CGST', 'SGST']);
  });

  it('is idempotent per period: a retried job issues no second document', async () => {
    const t = await makeBillingTenant({ gstin: '29AABCU9603R1ZM' });
    const first = await inTx(() => generateInvoice(owner, { ...PERIOD, ...t }));
    expect(first).not.toBeNull();

    const retry = await inTx(() => generateInvoice(owner, { ...PERIOD, ...t }));
    // Not an error -- nothing left to bill. The gapless series makes a duplicate
    // a permanent, visible defect, so this must not be near-missed.
    expect(retry).toBeNull();

    const count = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.invoice WHERE tenant_id=$1`, [t.tenantId]);
    expect(Number(count.rows[0]!.n)).toBe(1);
  });

  it('honours a per-tenant financial year boundary', async () => {
    const jan = await owner.query<{ fy: string }>(
      `SELECT platform.financial_year_label('2026-06-15'::date, 1::smallint) AS fy`);
    const apr = await owner.query<{ fy: string }>(
      `SELECT platform.financial_year_label('2026-03-15'::date, 4::smallint) AS fy`);
    expect(jan.rows[0]!.fy).toBe('2026-27');
    // March on an April basis belongs to the year that started last April.
    expect(apr.rows[0]!.fy).toBe('2025-26');
  });

  it('makes an issued invoice immutable', async () => {
    const t = await makeBillingTenant({ gstin: '29AABCU9603R1ZM' });
    const inv = await inTx(() => generateInvoice(owner, { ...PERIOD, ...t }));

    await expect(owner.query(
      `UPDATE platform.invoice SET total_minor = 1 WHERE id=$1`, [inv!.invoiceId]))
      .rejects.toThrow(/immutable/);
    // The payment stamp is the permitted transition.
    await expect(owner.query(
      `UPDATE platform.invoice SET status='paid', paid_at=now() WHERE id=$1`, [inv!.invoiceId]))
      .resolves.toBeTruthy();
  });

  it('refuses an invoice whose components contradict its declared treatment', async () => {
    const t = await makeBillingTenant({ gstin: '29AABCU9603R1ZM' });
    // Delete one half of the intra-state pair inside the same transaction: the
    // deferred trigger fires at COMMIT and must refuse it.
    await expect(inTx(async () => {
      const inv = await generateInvoice(owner, { ...PERIOD, ...t });
      await owner.query(
        `DELETE FROM platform.invoice_tax_component
          WHERE invoice_id=$1 AND name='SGST'`, [inv!.invoiceId]);
    })).rejects.toThrow(/CGST and SGST|sum to/);
  });

  it('bills segments for a mid-period upgrade on ONE invoice, with no credit note', async () => {
    const t = await makeBillingTenant({ gstin: '29AABCU9603R1ZM' });
    const inv = await inTx(async () => {
      await applyExpansion(owner, {
        tenantId: t.tenantId, subscriptionId: t.subscriptionId,
        planId, planVersionId, quantity: 3,
        currentPriceMinor: 500000, currentQuantity: 1, targetPriceMinor: 500000,
        at: new Date('2026-06-16T00:00:00Z'),
      });
      return generateInvoice(owner, { ...PERIOD, ...t });
    });

    const lines = await owner.query<{ kind: string; description: string }>(
      `SELECT kind, description FROM platform.invoice_line
        WHERE invoice_id=$1 ORDER BY line_no`, [inv!.invoiceId]);
    expect(lines.rows.filter((l) => l.kind === 'segment').length).toBe(2);

    // No credit note exists, and that is the point: Section 34 records a
    // reduction in a supply already made, which routine proration is not.
    const notes = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.credit_note WHERE tenant_id=$1`, [t.tenantId]);
    expect(Number(notes.rows[0]!.n)).toBe(0);
  });

  it('bills uninvoiced segments on cancellation, closing the cash-flow hole', async () => {
    const t = await makeBillingTenant({ gstin: '29AABCU9603R1ZM' });
    const { finalInvoice } = await inTx(() => cancelSubscriptionWithFinalInvoice(owner, {
      tenantId: t.tenantId, subscriptionId: t.subscriptionId,
      at: new Date('2026-06-20T00:00:00Z'), issueDate: '2026-06-20',
    }));

    expect(finalInvoice).not.toBeNull();
    expect(finalInvoice!.subtotalMinor).toBeGreaterThan(0);
    const status = await owner.query<{ s: string }>(
      `SELECT status AS s FROM platform.subscription WHERE id=$1`, [t.subscriptionId]);
    expect(status.rows[0]!.s).toBe('cancelled');
  });

  it('allocates segment charges with no residue', () => {
    const charges = allocateSegmentCharges(100000, [
      { id: 'a', days: 10, quantity: 1 },
      { id: 'b', days: 11, quantity: 1 },
      { id: 'c', days: 9, quantity: 1 },
    ]);
    expect(charges.reduce((a, c) => a + c.amountMinor, 0)).toBe(100000);
  });
});

/* ------------------------------------------------- contractions and quota --- */

describe('B. the expand/contract asymmetry', () => {
  it('classifies direction by total value, so seats and plans are one mechanism', () => {
    expect(directionOfChange(
      { planPriceMinor: 100, quantity: 1 }, { planPriceMinor: 500, quantity: 1 })).toBe('expand');
    expect(directionOfChange(
      { planPriceMinor: 100, quantity: 5 }, { planPriceMinor: 100, quantity: 2 })).toBe('contract');
    expect(directionOfChange(
      { planPriceMinor: 100, quantity: 1 }, { planPriceMinor: 100, quantity: 1 })).toBe('expand');
  });

  it('refuses to apply a contraction immediately', async () => {
    const t = await makeBillingTenant();
    await expect(applyExpansion(owner, {
      tenantId: t.tenantId, subscriptionId: t.subscriptionId,
      planId: smallPlanId, planVersionId: smallPlanVersionId, quantity: 1,
      currentPriceMinor: 500000, currentQuantity: 1, targetPriceMinor: 100000,
      at: new Date(),
    })).rejects.toThrow(/must be scheduled/);
  });

  it('makes a scheduled downgrade visible and revocable', async () => {
    const t = await makeBillingTenant();
    const change = await scheduleContraction(owner, {
      tenantId: t.tenantId, subscriptionId: t.subscriptionId, kind: 'downgrade',
      targetPlanId: smallPlanId, targetPlanVersionId: smallPlanVersionId,
    });
    const pending = await pendingChangeFor(owner, t.subscriptionId);
    expect(pending?.id).toBe(change.id);

    await expect(scheduleContraction(owner, {
      tenantId: t.tenantId, subscriptionId: t.subscriptionId, kind: 'downgrade',
      targetPlanId: smallPlanId, targetPlanVersionId: smallPlanVersionId,
    })).rejects.toThrow(PendingChangeExistsError);

    expect(await revokeScheduledChange(owner, { changeId: change.id })).toBe(true);
    expect(await pendingChangeFor(owner, t.subscriptionId)).toBeNull();
  });

  it('FAILS a downgrade that would leave the tenant over quota, and changes nothing', async () => {
    const t = await makeBillingTenant();
    // The rollup says eight branches are open and trading.
    await owner.query(
      `INSERT INTO platform.usage_counter (tenant_id, metric, metric_kind, as_of_date, value)
       VALUES ($1,'branches','level','2026-06-30',8)`, [t.tenantId]);

    const change = await scheduleContraction(owner, {
      tenantId: t.tenantId, subscriptionId: t.subscriptionId, kind: 'downgrade',
      targetPlanId: smallPlanId, targetPlanVersionId: smallPlanVersionId,
    });

    const results = await applyDueChanges(owner, { now: new Date('2026-07-02T00:00:00Z') });
    const mine = results.find((r) => r.changeId === change.id)!;
    expect(mine.outcome).toBe('failed');
    expect(mine.breaches).toEqual([{ metric: 'branches', current: 8, allowed: 2 }]);

    // THE POINT: the subscription did not move. Applying it would have disabled
    // six locations that are open.
    const sub = await owner.query<{ plan_version_id: string }>(
      `SELECT plan_version_id FROM platform.subscription WHERE id=$1`, [t.subscriptionId]);
    expect(sub.rows[0]!.plan_version_id).toBe(planVersionId);

    const notified = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.outbox
        WHERE topic='billing.downgrade_blocked' AND dedupe_key=$1`, [change.id]);
    expect(Number(notified.rows[0]!.n)).toBe(1);
  });

  it('applies a downgrade that fits, opening a new segment', async () => {
    const t = await makeBillingTenant();
    await owner.query(
      `INSERT INTO platform.usage_counter (tenant_id, metric, metric_kind, as_of_date, value)
       VALUES ($1,'branches','level','2026-06-30',1)`, [t.tenantId]);
    const change = await scheduleContraction(owner, {
      tenantId: t.tenantId, subscriptionId: t.subscriptionId, kind: 'downgrade',
      targetPlanId: smallPlanId, targetPlanVersionId: smallPlanVersionId,
    });
    const results = await applyDueChanges(owner, { now: new Date('2026-07-02T00:00:00Z') });
    expect(results.find((r) => r.changeId === change.id)!.outcome).toBe('applied');

    const sub = await owner.query<{ plan_version_id: string }>(
      `SELECT plan_version_id FROM platform.subscription WHERE id=$1`, [t.subscriptionId]);
    expect(sub.rows[0]!.plan_version_id).toBe(smallPlanVersionId);
  });

  it('refuses overlapping segments at the schema level', async () => {
    const t = await makeBillingTenant();
    await expect(owner.query(
      `INSERT INTO platform.subscription_segment
         (id,tenant_id,subscription_id,plan_id,plan_version_id,quantity,starts_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,1,'2026-06-15T00:00:00Z')`,
      [t.tenantId, t.subscriptionId, planId, planVersionId]))
      .rejects.toThrow(/no_overlap/);
  });
});

/* -------------------------------------------------------------- webhooks --- */

describe('C. webhooks are hostile input', () => {
  const SECRET = 'whsec_test';
  const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');

  it('verifies signatures and refuses a forgery, keeping it as evidence', async () => {
    const t = await makeBillingTenant();
    const body = JSON.stringify({ id: 'evt_1' });
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
    expect(verifySignature(body, 'deadbeef', SECRET)).toBe(false);

    const forged = await ingestWebhook(owner, {
      gateway: 'razorpay', rawBody: body, signatureHeader: 'deadbeef', secret: SECRET,
      gatewayEventId: `evt_forged_${randomUUID()}`, eventType: 'payment.captured',
      gatewayCreatedAt: new Date(), tenantId: t.tenantId, payload: {},
    });
    expect(forged.outcome).toBe('rejected_signature');

    const row = await owner.query<{ status: string; signature_verified: boolean }>(
      `SELECT status, signature_verified FROM platform.gateway_event WHERE id=$1`,
      [forged.eventId]);
    expect(row.rows[0]).toEqual({ status: 'rejected', signature_verified: false });

    // The schema will not let an unverified event reach any other terminal state.
    await expect(owner.query(
      `UPDATE platform.gateway_event SET status='processed', processed_at=now() WHERE id=$1`,
      [forged.eventId])).rejects.toThrow(/unverified_is_rejected/);
  });

  it('is idempotent on the gateway event id, defeating replay', async () => {
    const t = await makeBillingTenant();
    const body = JSON.stringify({ id: 'evt_2' });
    const eventId = `evt_${randomUUID()}`;
    const args = {
      gateway: 'razorpay' as const, rawBody: body, signatureHeader: sign(body),
      secret: SECRET, gatewayEventId: eventId, eventType: 'payment.captured',
      gatewayCreatedAt: new Date(), tenantId: t.tenantId, payload: {},
    };
    expect((await ingestWebhook(owner, args)).outcome).toBe('accepted');
    expect((await ingestWebhook(owner, args)).outcome).toBe('duplicate');
  });

  it('ignores an out-of-order event superseded by a newer processed one', async () => {
    const t = await makeBillingTenant();
    const body = JSON.stringify({ id: 'evt_3' });
    const newer = await ingestWebhook(owner, {
      gateway: 'razorpay', rawBody: body, signatureHeader: sign(body), secret: SECRET,
      gatewayEventId: `evt_new_${randomUUID()}`, eventType: 'subscription.updated',
      gatewayCreatedAt: new Date('2026-06-20T00:00:00Z'), tenantId: t.tenantId, payload: {},
    });
    await owner.query(
      `UPDATE platform.gateway_event SET status='processed', processed_at=now() WHERE id=$1`,
      [newer.eventId]);

    const older = await ingestWebhook(owner, {
      gateway: 'razorpay', rawBody: body, signatureHeader: sign(body), secret: SECRET,
      gatewayEventId: `evt_old_${randomUUID()}`, eventType: 'subscription.updated',
      gatewayCreatedAt: new Date('2026-06-10T00:00:00Z'), tenantId: t.tenantId, payload: {},
    });
    expect(older.outcome).toBe('stale');
  });

  it('never stores a card number, at three independent layers', async () => {
    const t = await makeBillingTenant();

    // 1. the application refuses it
    await expect(recordPayment(owner, {
      tenantId: t.tenantId, invoiceId: null, gateway: 'razorpay',
      eventId: randomUUID(),
      fact: { gatewayPaymentId: randomUUID(), amountMinor: 100, currency: 'INR',
              status: 'captured', methodToken: '4111111111111111' },
    })).rejects.toThrow(PanRefusedError);

    // 2. the column refuses it even if the application is bypassed
    await expect(owner.query(
      `INSERT INTO platform.gateway_payment
         (id,tenant_id,gateway,gateway_payment_id,amount_minor,currency,status,method_token)
       VALUES (gen_random_uuid(),$1,'razorpay',$2,100,'INR','pending','4111111111111111')`,
      [t.tenantId, randomUUID()])).rejects.toThrow(/token_is_not_a_pan/);

    // 3. no log line can carry one
    expect(redactPan('paid with 4111 1111 1111 1111 ok')).toBe('paid with [REDACTED-PAN] ok');
    expect(redactPan('order 12345 fine')).toBe('order 12345 fine');
  });

  it('self-heals a MISSED webhook by reconciling against the gateway', async () => {
    const t = await makeBillingTenant({ gstin: '29AABCU9603R1ZM' });
    const inv = await inTx(() => generateInvoice(owner, { ...PERIOD, ...t }));

    // No webhook ever arrived. A system that only learns by webhook cannot
    // discover what it never received.
    const result = await reconcileAgainstGateway(owner, {
      olderThan: new Date(Date.now() + 60_000),
      fetchPayments: async (invoiceId) =>
        invoiceId === inv!.invoiceId
          ? [{ gatewayPaymentId: `pay_${randomUUID()}`, amountMinor: inv!.totalMinor,
               currency: 'INR', status: 'captured' as const }]
          : [],
    });
    expect(result.healed).toBeGreaterThanOrEqual(1);

    const status = await owner.query<{ s: string }>(
      `SELECT status AS s FROM platform.invoice WHERE id=$1`, [inv!.invoiceId]);
    expect(status.rows[0]!.s).toBe('paid');
  });
});

/* --------------------------------------------------------------- dunning --- */

describe('D. dunning', () => {
  it('backs off rather than retrying a decline immediately', async () => {
    const config = await dunningConfig(owner);
    const first = nextAttemptAt(1, new Date('2026-07-01T00:00:00Z'), config)!;
    const second = nextAttemptAt(2, first, config)!;
    expect(first.toISOString().slice(0, 10)).toBe('2026-07-02');
    expect(second.getTime()).toBeGreaterThan(first.getTime());
    // Exhaustion stops retrying. It does NOT suspend.
    expect(nextAttemptAt(config.maxAttempts, first, config)).toBeNull();
  });

  it('starts the ladder clock on first failure without suspending', async () => {
    const t = await makeBillingTenant({ gstin: '29AABCU9603R1ZM' });
    const inv = await inTx(() => generateInvoice(owner, { ...PERIOD, ...t }));
    await scheduleFirstAttempt(owner, {
      tenantId: t.tenantId, invoiceId: inv!.invoiceId, at: new Date('2026-07-01T00:00:00Z') });

    await recordAttempt(owner, {
      tenantId: t.tenantId, invoiceId: inv!.invoiceId, attemptNo: 1,
      outcome: 'declined', gatewayErrorCode: 'insufficient_funds',
      at: new Date('2026-07-01T00:00:00Z'),
    });

    const tenant = await owner.query<{ status: string; delinquent_since: string | null }>(
      `SELECT status, delinquent_since::text FROM platform.tenant WHERE id=$1`, [t.tenantId]);
    // past_due is banner-only. A bank decline must not read-only a restaurant.
    expect(tenant.rows[0]!.status).toBe('past_due');
    expect(tenant.rows[0]!.delinquent_since).not.toBeNull();
  });

  it('recovers completely: status, day 0, a NEW entitlement version, and an invalidation', async () => {
    const t = await makeBillingTenant({ gstin: '29AABCU9603R1ZM' });
    const inv = await inTx(() => generateInvoice(owner, { ...PERIOD, ...t }));
    await scheduleFirstAttempt(owner, {
      tenantId: t.tenantId, invoiceId: inv!.invoiceId, at: new Date('2026-07-01T00:00:00Z') });
    await recordAttempt(owner, {
      tenantId: t.tenantId, invoiceId: inv!.invoiceId, attemptNo: 1,
      outcome: 'declined', at: new Date('2026-07-01T00:00:00Z') });

    const before = Number((await owner.query<{ v: string }>(
      `SELECT COALESCE(max(version),0)::text AS v FROM platform.entitlement_document
        WHERE tenant_id=$1`, [t.tenantId])).rows[0]!.v);

    await recordAttempt(owner, {
      tenantId: t.tenantId, invoiceId: inv!.invoiceId, attemptNo: 2,
      outcome: 'succeeded', at: new Date('2026-07-03T00:00:00Z') });

    const tenant = await owner.query<{ status: string; delinquent_since: string | null }>(
      `SELECT status, delinquent_since::text FROM platform.tenant WHERE id=$1`, [t.tenantId]);
    expect(tenant.rows[0]!.status).toBe('active');
    // The Phase 0 biconditional: active and a non-NULL day 0 cannot coexist.
    expect(tenant.rows[0]!.delinquent_since).toBeNull();

    const after = Number((await owner.query<{ v: string }>(
      `SELECT max(version)::text AS v FROM platform.entitlement_document WHERE tenant_id=$1`,
      [t.tenantId])).rows[0]!.v);
    expect(after).toBeGreaterThan(before);

    const invalidation = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.outbox
        WHERE topic='entitlement.invalidate' AND dedupe_key=$1`, [`${t.tenantId}:${after}`]);
    expect(Number(invalidation.rows[0]!.n)).toBe(1);
  });

  it('shows days-until-soft-lock from the ladder thresholds, not a second copy', async () => {
    const t = await makeBillingTenant({ gstin: '29AABCU9603R1ZM' });
    const inv = await inTx(() => generateInvoice(owner, { ...PERIOD, ...t }));
    await owner.query(
      `UPDATE platform.tenant SET status='past_due', delinquent_since='2026-07-01T00:00:00Z',
              status_changed_at=now() WHERE id=$1`, [t.tenantId]);
    await owner.query(`UPDATE platform.invoice SET due_date='2026-07-01' WHERE id=$1`,
      [inv!.invoiceId]);

    const queue = await dunningQueue(owner, { now: new Date('2026-07-04T00:00:00Z') });
    const row = queue.find((q) => q.tenantId === t.tenantId)!;
    expect(row).toBeDefined();
    // soft_lock is day 7; three days elapsed leaves four.
    expect(row.daysUntilSoftLock).toBe(4);

    await recordOutreach(owner, {
      tenantId: t.tenantId, invoiceId: inv!.invoiceId, channel: 'phone',
      byPlatformUserId: superAdminId, note: 'left voicemail' });
    const after = await dunningQueue(owner, { now: new Date('2026-07-04T00:00:00Z') });
    expect(after.find((q) => q.tenantId === t.tenantId)!.lastOutreachAt).not.toBeNull();
  });
});

/* ------------------------------------------------------------ boundaries --- */

describe('E. what must not happen', () => {
  it('has no path from a webhook to the ladder or to tenant.status', () => {
    // Comments are stripped FIRST. The module explains at length that it never
    // calls the ladder, and an assertion that matched that prose would be testing
    // the comment rather than the code -- passing for the wrong reason, and
    // failing the moment someone rewords a paragraph.
    const code = readFileSync('src/modules/billing/webhooks.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    // A gateway hiccup must not be able to lock a restaurant out mid-service.
    expect(code, 'a webhook must not write tenant status').not.toMatch(/platform\.tenant\b/);
    expect(code, 'a webhook must not reach the ladder').not.toMatch(/ladder/i);
    expect(code, 'a webhook must not touch day 0').not.toMatch(/delinquent_since/);

    // Non-vacuity: stripping must not have removed the code along with the prose.
    expect(code).toMatch(/platform\.gateway_event/);
    expect(code).toMatch(/platform\.gateway_payment/);
  });

  it('keeps every billing module out of schema app', () => {
    const files = readdirSync('src/modules/billing').filter((f) => f.endsWith('.ts'));
    assertCheckedSet({
      label: 'billing modules',
      checked: files,
      minimum: 5,
      mustInclude: ['invoicing.ts', 'placeOfSupply.ts', 'segments.ts', 'dunning.ts',
                    'webhooks.ts', 'scheduledChange.ts'],
    });
    const offenders = files.filter((f) =>
      /\bapp\.[a-z_]+/.test(readFileSync(`src/modules/billing/${f}`, 'utf8')));
    // The control plane never queries tenant data. Usage flows up as aggregates.
    expect(offenders).toEqual([]);
  });

  it('holds no threshold of its own in the dunning module', () => {
    const source = readFileSync('src/modules/billing/dunning.ts', 'utf8');
    // The ladder owns 7/15/45/135. A second copy would drift and the queue screen
    // would confidently show a date the ladder disagrees with.
    for (const n of ['7', '15', '45', '135']) {
      expect(source).not.toMatch(new RegExp(`softLockDays\\s*=\\s*${n}`));
    }
    expect(source).toMatch(/ladderThresholds\(/);
  });

  it('forbids a platform -> app foreign key, still', async () => {
    const bad = await owner.query<{ name: string }>(
      `SELECT c.conname AS name
         FROM pg_constraint c
         JOIN pg_class src ON src.oid = c.conrelid
         JOIN pg_namespace sn ON sn.oid = src.relnamespace
         JOIN pg_class tgt ON tgt.oid = c.confrelid
         JOIN pg_namespace tn ON tn.oid = tgt.relnamespace
        WHERE c.contype = 'f' AND sn.nspname = 'platform' AND tn.nspname = 'app'`);
    expect(bad.rows).toEqual([]);
  });

  it('will not let a tenant grant itself a zero rating', async () => {
    const t = await makeBillingTenant({ gstin: '29AABCU9603R1ZM' });
    // No platform user named, no evidence: refused outright.
    await expect(owner.query(
      `UPDATE platform.tenant_tax_profile SET is_sez = true WHERE tenant_id=$1`, [t.tenantId]))
      .rejects.toThrow(/re-grant it against evidence|tenant_exemption_attributed/);

    // Even naming a stale grant is refused: the grant must be re-stated.
    await expect(owner.query(
      `UPDATE platform.tenant_tax_profile
          SET country_code='AE', lut_number='LUT/9' WHERE tenant_id=$1`, [t.tenantId]))
      .rejects.toThrow(/re-grant it against evidence|tenant_exemption_attributed/);
  });
});
