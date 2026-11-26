import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  determinePlaceOfSupply, componentsForLine, roundOffMinor,
  type SupplierRegistration, type TenantTaxProfile,
} from './placeOfSupply.js';
import { allocateSegmentCharges, daysBetween, uninvoicedSegments } from './segments.js';

/**
 * Invoice generation.
 *
 * Everything numeric and every tax identity is SNAPSHOTTED. An invoice never
 * dereferences a plan row or a tax profile for a number, so a PDF reissued six
 * months later matches the original -- the priced-document rule, applied to a
 * document that a tax authority may read.
 */

export class MixedCurrencyPeriodError extends Error {
  readonly statusCode = 422;
  readonly code = 'mixed_currency_period';
  constructor(readonly currencies: readonly string[]) {
    super(
      `this period's segments are priced in ${currencies.join(' and ')}. One invoice ` +
        'carries one currency, so a plan re-priced into another currency mid-period ' +
        'needs the period closed and a decision about the customer rather than a ' +
        'document that names one currency and totals another.',
    );
    this.name = 'MixedCurrencyPeriodError';
  }
}

export class InvoiceAlreadyIssuedError extends Error {
  readonly statusCode = 409;
  readonly code = 'invoice_already_issued';
  constructor(readonly number: string) {
    super(
      `an invoice already covers this period (${number}). Generation is idempotent per ` +
        'period because the gapless series makes a duplicate a permanent, visible defect.',
    );
    this.name = 'InvoiceAlreadyIssuedError';
  }
}

export class NoTaxProfileError extends Error {
  readonly statusCode = 422;
  readonly code = 'no_tax_profile';
  constructor(readonly tenantId: string) {
    super(`tenant ${tenantId} has no tax profile; an invoice cannot state a place of supply`);
    this.name = 'NoTaxProfileError';
  }
}

async function loadSupplier(client: pg.ClientBase): Promise<SupplierRegistration> {
  const r = await client.query<{
    gstin: string; state_code: string; legal_name: string; address: string;
  }>(
    `SELECT gstin, state_code, legal_name, address
       FROM platform.supplier_gst_registration
      WHERE is_default AND status = 'active'`,
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error(
      'no default supplier GST registration. Our own registration is DATA, not a constant, ' +
        'and an invoice cannot be issued without knowing which registration made the supply.',
    );
  }
  return {
    gstin: row.gstin, stateCode: row.state_code,
    legalName: row.legal_name, address: row.address,
  };
}

async function loadTaxProfile(
  client: pg.ClientBase, tenantId: string,
): Promise<TenantTaxProfile> {
  const r = await client.query<{
    legal_name: string; gstin: string | null; state_code: string; country_code: string;
    billing_address: string; is_sez: boolean; lut_number: string | null;
    financial_year_starts_month: number;
  }>(
    `SELECT legal_name, gstin, state_code, country_code, billing_address, is_sez,
            lut_number, financial_year_starts_month
       FROM platform.tenant_tax_profile WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = r.rows[0];
  if (!row) throw new NoTaxProfileError(tenantId);
  return {
    legalName: row.legal_name, gstin: row.gstin, stateCode: row.state_code,
    countryCode: row.country_code, billingAddress: row.billing_address,
    isSez: row.is_sez, lutNumber: row.lut_number,
    financialYearStartsMonth: row.financial_year_starts_month,
  };
}

async function settings(client: pg.ClientBase): Promise<{
  gstRateBps: number; sacCode: string; dueDays: number;
}> {
  const r = await client.query<{ key: string; value: string }>(
    `SELECT key, value #>> '{}' AS value FROM platform.platform_setting
      WHERE key IN ('invoice.gst_rate_bps', 'invoice.sac_code', 'invoice.due_days')`,
  );
  const byKey = new Map(r.rows.map((x) => [x.key, x.value]));
  const rate = Number(byKey.get('invoice.gst_rate_bps'));
  const due = Number(byKey.get('invoice.due_days'));
  const sac = byKey.get('invoice.sac_code');
  if (!Number.isFinite(rate) || !Number.isFinite(due) || !sac) {
    throw new Error('invoice settings are missing or non-numeric');
  }
  return { gstRateBps: rate, sacCode: sac, dueDays: due };
}

export interface GeneratedInvoice {
  readonly invoiceId: string;
  readonly number: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly roundOffMinor: number;
  readonly totalMinor: number;
  readonly treatment: string;
  readonly lineCount: number;
}

/**
 * Generates the invoice for everything uninvoiced up to `upTo`.
 *
 * Idempotent per period by construction rather than by a guard: it bills
 * SEGMENTS, and a billed segment carries the invoice that billed it. A retried
 * job finds nothing to bill and returns null rather than issuing a second
 * document.
 */
export async function generateInvoice(
  client: pg.ClientBase,
  params: {
    tenantId: string;
    subscriptionId: string;
    periodStart: Date;
    periodEnd: Date;
    upTo: Date;
    issueDate: string;
  },
): Promise<GeneratedInvoice | null> {
  const segments = await uninvoicedSegments(client, {
    tenantId: params.tenantId,
    subscriptionId: params.subscriptionId,
    upTo: params.upTo,
  });
  if (segments.length === 0) return null;

  const [supplier, profile, cfg] = await Promise.all([
    loadSupplier(client),
    loadTaxProfile(client, params.tenantId),
    settings(client),
  ]);
  const pos = determinePlaceOfSupply(profile, supplier);

  const fy = (await client.query<{ fy: string }>(
    `SELECT platform.financial_year_label($1::date, $2::smallint) AS fy`,
    [params.issueDate, profile.financialYearStartsMonth],
  )).rows[0]!.fy;

  const seqNo = Number((await client.query<{ n: string }>(
    `SELECT platform.next_document_no($1, 'invoice', $2)::text AS n`,
    [params.tenantId, fy],
  )).rows[0]!.n);

  // The series code makes the number globally unique while each tenant's series
  // stays consecutive. Rule 46 wants the SUPPLIER's numbering unique for the
  // financial year, and parallel per-tenant counters only satisfy that if the
  // series is identifiable in the number -- otherwise two tenants both issue
  // INV/2026-27/000001 and our own books carry duplicates.
  const series = (await client.query<{ slug: string }>(
    `SELECT slug FROM platform.tenant WHERE id = $1`, [params.tenantId],
  )).rows[0]!.slug.toUpperCase();
  const number = `INV/${series}/${fy}/${String(seqNo).padStart(6, '0')}`;

  // Allocate each plan's period price across its own segments. A segment on plan
  // A must not borrow rounding from plan B: they are separate supplies at
  // separate prices.
  const byPlanVersion = new Map<string, typeof segments[number][]>();
  for (const s of segments) {
    const list = byPlanVersion.get(s.planVersionId) ?? [];
    list.push(s);
    byPlanVersion.set(s.planVersionId, list);
  }

  const periodDays = daysBetween(params.periodStart, params.periodEnd);
  interface DraftLine {
    segmentId: string; description: string; from: Date; to: Date;
    quantity: number; unitPriceMinor: number; amountMinor: number;
  }
  const draft: DraftLine[] = [];

  for (const [, group] of byPlanVersion) {
    const spans = group.map((s) => {
      const from = s.startsAt < params.periodStart ? params.periodStart : s.startsAt;
      const to = s.endsAt && s.endsAt < params.periodEnd ? s.endsAt : params.periodEnd;
      return { id: s.id, days: daysBetween(from, to), quantity: s.quantity, from, to, seg: s };
    });

    // The full-period price for this plan at each segment's quantity, allocated by
    // days. Where one segment spans the whole period this is simply the price.
    const fullPeriodValue = spans[0]!.seg.priceMinor * periodDays;
    const scaled = Math.round(
      (fullPeriodValue * spans.reduce((a, s) => a + s.days * s.quantity, 0))
      / (periodDays * periodDays),
    );

    const charges = allocateSegmentCharges(scaled, spans);
    for (const c of charges) {
      const span = spans.find((s) => s.id === c.segmentId)!;
      draft.push({
        segmentId: c.segmentId,
        description: `${span.seg.planName} (${span.seg.planKey}) x${span.quantity}`,
        from: span.from, to: span.to,
        quantity: span.quantity,
        unitPriceMinor: span.seg.priceMinor,
        amountMinor: c.amountMinor,
      });
    }
  }

  // #########################################################################
  // THE CURRENCY COMES FROM THE PLAN VERSION, NOT FROM A LITERAL.
  //
  // This insert wrote 'INR' while `plan_version.currency` has been a column
  // since migration 0013. Harmless for one country and wrong the first time a
  // plan is priced in anything else -- and wrong in the worst way, because the
  // AMOUNTS would still be the foreign ones while the document said rupees.
  //
  // An invoice may not MIX currencies, so a period whose segments disagree is
  // refused rather than resolved by picking the first. That state means a plan
  // was re-priced in another currency mid-period, which is a decision somebody
  // has to make about the customer rather than one this function can make.
  // #########################################################################
  const currencies = [...new Set(segments.map((segment) => segment.currency))];
  if (currencies.length > 1) {
    throw new MixedCurrencyPeriodError(currencies);
  }
  const currency = currencies[0] ?? 'INR';

  const subtotal = draft.reduce((a, l) => a + l.amountMinor, 0);
  const perLineComponents = draft.map((l) =>
    componentsForLine(pos.treatment, l.amountMinor, cfg.gstRateBps));
  const tax = perLineComponents.flat().reduce((a, c) => a + c.amountMinor, 0);
  const roundOff = roundOffMinor(subtotal + tax);
  const total = subtotal + tax + roundOff;

  const dueDate = new Date(params.issueDate);
  dueDate.setUTCDate(dueDate.getUTCDate() + cfg.dueDays);

  const invoiceId = randomUUID();
  await client.query(
    `INSERT INTO platform.invoice
       (id, tenant_id, subscription_id, financial_year, sequence_no, number,
        period_start, period_end, issue_date, due_date,
        supplier_gstin, supplier_state_code, supplier_legal_name,
        recipient_gstin, recipient_state_code, recipient_legal_name, recipient_address,
        place_of_supply_state_code, tax_treatment, lut_number,
        currency, subtotal_minor, tax_minor, round_off_minor, total_minor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,
             $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$25,$21,$22,$23,$24)`,
    [invoiceId, params.tenantId, params.subscriptionId, fy, seqNo, number,
     params.periodStart, params.periodEnd, params.issueDate,
     dueDate.toISOString().slice(0, 10),
     supplier.gstin, supplier.stateCode, supplier.legalName,
     profile.gstin, pos.stateCode, profile.legalName, profile.billingAddress,
     pos.stateCode, pos.treatment, pos.lutNumber,
     subtotal, tax, roundOff, total, currency],
  );

  let lineNo = 0;
  for (const [i, l] of draft.entries()) {
    const lineId = randomUUID();
    lineNo += 1;
    await client.query(
      `INSERT INTO platform.invoice_line
         (id, tenant_id, invoice_id, kind, line_no, segment_id, description, sac_code,
          period_from, period_to, quantity, unit_price_minor, amount_minor)
       VALUES ($1,$2,$3,'segment',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [lineId, params.tenantId, invoiceId, lineNo, l.segmentId, l.description, cfg.sacCode,
       l.from, l.to, l.quantity, l.unitPriceMinor, l.amountMinor],
    );
    for (const c of perLineComponents[i]!) {
      await client.query(
        `INSERT INTO platform.invoice_tax_component
           (id, tenant_id, invoice_id, invoice_line_id, name, rate_bps, amount_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), params.tenantId, invoiceId, lineId, c.name, c.rateBps, c.amountMinor],
      );
    }
    await client.query(
      `UPDATE platform.subscription_segment SET invoiced_on_invoice_id = $2
        WHERE id = $1`, [l.segmentId, invoiceId],
    );
  }

  if (roundOff !== 0) {
    lineNo += 1;
    await client.query(
      `INSERT INTO platform.invoice_line
         (id, tenant_id, invoice_id, kind, line_no, description, amount_minor)
       VALUES ($1,$2,$3,'round_off',$4,'Round Off',$5)`,
      [randomUUID(), params.tenantId, invoiceId, lineNo, roundOff],
    );
  }

  return {
    invoiceId, number,
    subtotalMinor: subtotal, taxMinor: tax, roundOffMinor: roundOff, totalMinor: total,
    treatment: pos.treatment, lineCount: lineNo,
  };
}

/**
 * Cancellation is a BILLING EVENT.
 *
 * Without this, a tenant who cancels mid-period is never billed for the segments
 * since their last invoice -- the one cash-flow hole the segment model has. So
 * cancelling closes the open segment and issues a final invoice for everything
 * uninvoiced, before the subscription is closed.
 */
export async function cancelSubscriptionWithFinalInvoice(
  client: pg.ClientBase,
  params: { tenantId: string; subscriptionId: string; at: Date; issueDate: string },
): Promise<{ finalInvoice: GeneratedInvoice | null }> {
  await client.query(
    `UPDATE platform.subscription_segment SET ends_at = $3
      WHERE tenant_id = $1 AND subscription_id = $2 AND ends_at IS NULL`,
    [params.tenantId, params.subscriptionId, params.at],
  );

  const period = (await client.query<{ s: string; e: string }>(
    `SELECT current_period_start::text AS s, current_period_end::text AS e
       FROM platform.subscription WHERE id = $1`, [params.subscriptionId],
  )).rows[0]!;

  const finalInvoice = await generateInvoice(client, {
    tenantId: params.tenantId,
    subscriptionId: params.subscriptionId,
    periodStart: new Date(period.s),
    periodEnd: new Date(period.e),
    upTo: params.at,
    issueDate: params.issueDate,
  });

  await client.query(
    `UPDATE platform.subscription
        SET status = 'cancelled', cancelled_at = $2, updated_at = now()
      WHERE id = $1`,
    [params.subscriptionId, params.at],
  );

  return { finalInvoice };
}
