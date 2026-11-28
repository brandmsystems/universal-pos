import type { TenantContext } from '../../database/tenantContext.js';

/**
 * The TENANT's outward-supply return, from their own POS data.
 *
 * ###########################################################################
 * THIS SHARES NO CODE WITH src/modules/billing/. DELIBERATELY.
 *
 * That module computes OUR place of supply when WE invoice the tenant, on the
 * control plane, against platform.invoice. This one computes THEIR outward
 * supplies to THEIR customers, on the tenant plane, against app.bill. The two
 * have different supplier registrations, different recipients, different tables,
 * and different failure consequences. Sharing a "tax engine" between them would
 * mean a change made for one silently altering the other's filed returns.
 * ###########################################################################
 *
 * Every figure comes from the bill line's own snapshot -- `tax_rate_bps` and
 * `tax_components` as they stood when the bill was raised. A rate revision
 * therefore produces a return with BOTH rates in it, which is correct: the return
 * must reconcile to the paper that was handed to the customer.
 */

export interface RateBucket {
  readonly rateBps: number;
  /**
   * The head the supply was made under, as STAMPED on the bill. A period may
   * legitimately contain both, so it groups rather than being a property of the
   * return -- a branch that starts delivering across a state line has two.
   */
  readonly treatment: 'intra_state' | 'inter_state' | 'none';
  /** Where the supply was made. GSTR-1 reports B2CS per place of supply. */
  readonly placeOfSupplyStateCode: string | null;
  readonly taxableMinor: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
  /**
   * The heads actually PRINTED on the documents in this bucket, summed from
   * `bill_line.tax_components`. Reported beside the derived figures rather than
   * used as them -- see `reconcileReturnToBills`.
   */
  readonly printedHeadsMinor: number;
  readonly billCount: number;
}

export interface B2BSupply {
  readonly recipientGstin: string;
  readonly recipientName: string;
  readonly placeOfSupplyStateCode: string | null;
  readonly buckets: readonly RateBucket[];
}

export interface CreditNoteRow {
  readonly refundId: string;
  readonly billNo: number;
  readonly reasonKey: string | null;
  readonly taxableMinor: number;
  readonly taxMinor: number;
  readonly rateBps: number | null;
  readonly refundedAt: string;
}

export interface OutwardSupplyReturn {
  readonly branchId: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly supplierGstin: string | null;
  /** Registered recipients, itemised. */
  readonly b2b: readonly B2BSupply[];
  /** Everyone else, summarised per rate -- which is what B2CS is. */
  readonly b2c: readonly RateBucket[];
  /** A refund IS a Section 34 reduction of a supply already made. */
  readonly creditNotes: readonly CreditNoteRow[];
  readonly totals: {
    readonly taxableMinor: number;
    readonly cgstMinor: number;
    readonly sgstMinor: number;
    readonly igstMinor: number;
  };
}

/**
 * Components are read from the line's `tax_components` jsonb, which snapshots the
 * CGST/SGST/IGST split as it was applied.
 *
 * ###########################################################################
 * THE COMPONENTS ARE FOLDED TO ONE ROW PER LINE BEFORE ANYTHING IS SUMMED.
 *
 * Exploding a line into its components with a LATERAL join and then summing
 * `amount_minor` multiplies the TAXABLE VALUE by the number of components -- two
 * for an intra-state supply, so the return reports exactly double. The tax total
 * looks right, because those rows really are distinct, which is what makes it
 * hard to spot by eye. The reconciliation check is what caught it.
 * ###########################################################################
 */
/**
 * ###########################################################################
 * THE HEADS ARE DERIVED FROM THE STAMPED TREATMENT, NOT PARSED OUT OF JSONB.
 *
 * This query used to read `tax_components[].amount_minor` and bucket by
 * `name = 'CGST'`. Three things were wrong with that, all of them live:
 *
 *  1. `orderEntry` wrote `{name, rate_bps}` and NO amount, so for every row the
 *     product produced the amount was absent and every head summed to zero.
 *     1,012 such bill lines existed in the dev install against 657 that had the
 *     key -- and all 657 were written directly by test fixtures, which is why
 *     every GST assertion in the suite passed.
 *  2. `generateBill` wrote `JSON.stringify(components ?? null)`, storing a jsonb
 *     `null` SCALAR for a line with no components. `COALESCE` does not convert
 *     that, so `jsonb_array_elements` raised "cannot extract elements from a
 *     scalar" and this report answered 500 on real data.
 *  3. `tax_component.name` was tenant free text with no CHECK, so a class named
 *     'GST 5%' would have filed zeroes even once 1 and 2 were fixed.
 *
 * `bill.tax_treatment` and `bill_line.tax_minor` are BOTH snapshots on the
 * document, so splitting one by the other is still reading the paper -- the
 * priced-document rule is intact. The split reproduces `splitHeads` exactly,
 * per line and then summed: integer division floors to SGST and the remainder
 * goes to CGST. Splitting the SUM instead would drift by a paisa per odd line.
 *
 * `jsonb_typeof(...) = 'array'` and not COALESCE, for reason 2 above: those
 * 975 rows are still there and will be until they age out of every open period.
 * ###########################################################################
 */
const LINE_CTE = `
  WITH line AS (
    SELECT b.id AS bill_id, b.recipient_gstin, b.recipient_legal_name,
           b.place_of_supply_state_code AS pos, b.tax_treatment,
           bl.id AS line_id, bl.amount_minor, bl.tax_minor, bl.tax_rate_bps,
           bl.tax_components
      FROM app.bill b
      JOIN app.bill_line bl ON bl.tenant_id = b.tenant_id AND bl.bill_id = b.id
     WHERE b.tenant_id = $1 AND b.branch_id = $2
       AND b.business_date BETWEEN $3::date AND $4::date
       AND b.status <> 'void'
       -- A VAT or other-tax bill (0083) is not a GST supply and is never filed here.
       AND b.tax_account_type = 'gst'
  ),
  priced AS (
    SELECT l.*,
           CASE WHEN l.tax_treatment = 'intra_state'
                THEN l.tax_minor - (l.tax_minor / 2) ELSE 0 END AS cgst,
           CASE WHEN l.tax_treatment = 'intra_state'
                THEN l.tax_minor / 2 ELSE 0 END AS sgst,
           CASE WHEN l.tax_treatment = 'inter_state'
                THEN l.tax_minor ELSE 0 END AS igst,
           -- A SCALAR SUBQUERY, not a LATERAL join. Exploding a line into its
           -- components and then summing multiplied the TAXABLE value by the
           -- number of components -- two for an intra-state supply, so the
           -- return reported exactly double. That defect is structurally gone
           -- here: one row per line, always.
           COALESCE((SELECT sum((c.value ->> 'amount_minor')::bigint)
                       FROM jsonb_array_elements(
                              CASE WHEN jsonb_typeof(l.tax_components) = 'array'
                                   THEN l.tax_components ELSE '[]'::jsonb END) c), 0)
             AS printed
      FROM line l
  )`

const BUCKET_SELECT = `
  SELECT tax_rate_bps, tax_treatment, pos,
         SUM(amount_minor)::text     AS taxable_minor,
         SUM(cgst)::text             AS cgst_minor,
         SUM(sgst)::text             AS sgst_minor,
         SUM(igst)::text             AS igst_minor,
         SUM(printed)::text          AS printed_heads_minor,
         count(DISTINCT bill_id)::text AS bill_count`;

/**
 * A period this branch held two GST positions across.
 *
 * ###########################################################################
 * WHY THIS REFUSES INSTEAD OF SUMMING.
 *
 * `supplierGstin` on this return is resolved as the one distinct non-null
 * supplier GSTIN stamped on the period's bills. That is correct for a period the
 * branch spent entirely registered, and quietly wrong for one it registered
 * DURING: the pre-registration bills carry no GSTIN and no tax, the
 * post-registration ones carry both, and this function would report the whole
 * period's turnover under the GSTIN it found -- declaring supplies made before
 * the registration existed as supplies made under it.
 *
 * Nothing in the numbers reveals it. The buckets simply show a lower effective
 * rate than the menu says, which is exactly what a period with genuinely
 * exempt items looks like.
 *
 * So the period is refused and the change date is named, with the same shape and
 * for the same reason as `MixedCurrencyPeriodError` in invoicing: the split is a
 * decision about the filing, not one a report may make silently. File the two
 * parts as the two periods they are.
 * ###########################################################################
 */
export class GstPeriodSpansRegistrationChangeError extends Error {
  readonly code = 'gst_period_spans_registration_change';
  constructor(
    readonly branchId: string,
    readonly changeDates: readonly string[],
  ) {
    super(
      `this branch changed its GST position on ${changeDates.join(', ')}, inside the `
      + 'requested period. Supplies either side of that date were made under '
      + 'different registrations and cannot be filed as one period -- run the '
      + 'return for each part separately.',
    );
    this.name = 'GstPeriodSpansRegistrationChangeError';
  }
}

/**
 * This return is India's, and a tenant somewhere else is refused by name.
 *
 * ###########################################################################
 * WHY THIS EXISTS AT ALL, AND WHY IT IS NOT PARANOIA.
 *
 * Everything in this file is the Indian statutory return: GSTR-1's B2B and B2C
 * tables, the CGST/SGST/IGST heads, `place_of_supply_state_code`. That is
 * correct and it is not going to be generalised -- another country's return is
 * a different document with different tables, not this one with renamed
 * columns.
 *
 * What WOULD happen without this guard is worse than a wrong answer. Run
 * against a tenant in another jurisdiction, every query below still executes:
 * no bill has `tax_treatment = 'intra_state'`, so every bucket comes out at
 * zero and the caller is handed a clean NIL RETURN for a regime the restaurant
 * is not in. Nothing raises. That is the failure this whole phase exists to
 * prevent, arriving through the report instead of through the till.
 *
 * Unreachable today -- India is the only implemented jurisdiction -- and built
 * now because the day it becomes reachable is the day somebody files it.
 * ###########################################################################
 */
export class GstReturnWrongJurisdictionError extends Error {
  readonly statusCode = 409;
  readonly code = 'gst_return_wrong_jurisdiction';
  constructor(readonly jurisdictionCode: string) {
    super(
      `this is India's outward-supply return (GSTR-1) and this restaurant trades `
      + `under ${jurisdictionCode}'s tax rules, so it is not the return it files. `
      + 'It is refused rather than produced: every bucket would come out at zero '
      + 'and read as a lawful nil return, which is the one answer worse than an '
      + 'error. Take the turnover from the sales report until this '
      + "jurisdiction's own return is built.",
    );
    this.name = 'GstReturnWrongJurisdictionError';
  }
}

/**
 * A period containing supplies whose HEAD nobody recorded.
 *
 * ###########################################################################
 * WHY THIS REFUSES.
 *
 * Migration 0050 wrote `tax_treatment = 'unstated'` onto every bill that
 * charged tax at a branch with no state code -- 863 of them in the dev install,
 * carrying real tax. Their head cannot be reconstructed: the branch never
 * recorded which state it trades in, so whether the supply was CGST+SGST or
 * IGST is not a fact this database holds.
 *
 * Reporting them as intra-state would be the obvious guess and it is the wrong
 * one for exactly the reason 0037 sets out in capitals: the total would be
 * right and the document worthless, because credit claimed under the wrong head
 * is disallowed and the only remedy is to credit-note and reissue everything.
 * Reporting them as zero would understate the output tax.
 *
 * So the period is refused and the FIX IS STATED, because it is a small one and
 * it already has a screen: ANSWER THE BRANCH'S GST QUESTION. Only an `unstated`
 * branch can produce these -- a branch that says it is registered carries a
 * GSTIN and therefore a state code, and one that says it is not carries no tax
 * at all. `unstated` is migration 0048's legacy value, the GST registration
 * screen nags about it in red with a count, and answering it makes every bill
 * from that day carry a head.
 * ###########################################################################
 */
export class GstPeriodHasUnstatedTreatmentError extends Error {
  readonly statusCode = 409;
  readonly code = 'gst_period_has_unstated_treatment';
  constructor(
    readonly branchId: string,
    readonly billCount: number,
    readonly taxMinor: number,
  ) {
    super(
      `${billCount} bill(s) in this period charged tax before this branch had a `
      + `state code recorded, totalling ${(taxMinor / 100).toFixed(2)} of tax whose `
      + 'head -- CGST+SGST or IGST -- was never stated. They cannot be filed under '
      + 'a head the database does not hold. Answer the GST question for this '
      + 'branch on the GST registration screen; every bill from that day carries '
      + 'a head. These earlier ones need a treatment decision from whoever files.',
    );
    this.name = 'GstPeriodHasUnstatedTreatmentError';
  }
}

/**
 * A period whose supplies were made under the composition scheme.
 *
 * ###########################################################################
 * WHY THIS REFUSES RATHER THAN PRODUCING A RETURN THAT LOOKS FINE.
 *
 * A composition taxable person does not file GSTR-1. It files CMP-08 quarterly
 * and GSTR-4 annually, and it declares TURNOVER on which it pays 5% out of its
 * own pocket -- not outward supplies broken into rate buckets with tax
 * collected under heads.
 *
 * This report would happily produce that shape for such a branch, because the
 * arithmetic works: the bills exist, they carry no tax, and every bucket would
 * come out at zero. It would read as a lawful nil return, and it is not a
 * return at all -- it is the wrong form, filled in correctly.
 *
 * Read from the DOCUMENTS rather than from the branch, deliberately. The bills
 * carry `supplier_gst_registration` as a snapshot, and a period the branch
 * spent partly under the scheme is already refused by
 * `GstPeriodSpansRegistrationChangeError`. Asking the branch what it is TODAY
 * would answer a question about last quarter with this quarter's facts.
 * ###########################################################################
 */
export class GstReturnNotApplicableError extends Error {
  readonly statusCode = 409;
  readonly code = 'gst_return_not_applicable';
  constructor(readonly branchId: string, readonly position: string) {
    super(
      'the supplies in this period were made under the composition scheme, which '
      + 'does not file an outward-supply return. A composition taxable person '
      + 'declares turnover on CMP-08 quarterly and GSTR-4 annually and collects '
      + 'no tax, so there are no rate buckets to file. The turnover figures are '
      + 'on the sales report.',
    );
    this.name = 'GstReturnNotApplicableError';
  }
}

export async function outwardSupplyReturn(
  context: TenantContext,
  params: { branchId: string; fromDate: string; toDate: string },
): Promise<OutwardSupplyReturn> {
  const args = [context.tenantId, params.branchId, params.fromDate, params.toDate];

  // #########################################################################
  // BEFORE EVERY OTHER CHECK, AND READ OFF THE BILLS RATHER THAN THE TENANT.
  //
  // This is the only check that asks whether this document is the right
  // document at all -- the rest of the function decides whether an Indian
  // return can be FILED. See `GstReturnWrongJurisdictionError` for why a nil
  // return is the dangerous outcome here rather than a harmless one.
  //
  // FROM THE BILLS, not from `platform.tenant.tax_jurisdiction`. Two reasons,
  // and both are rules this file already lives by. It is the SNAPSHOT: a period
  // is judged by the regime its documents were issued under, exactly as the
  // composition check below reads `supplier_gst_registration` off the bills
  // rather than off the branch. And `tests/reporting/snapshotOnly.test.ts`
  // refuses this module an import outside the reporting layer -- correctly:
  // reaching for a live configuration read is how a filed figure comes to
  // change underneath the person who printed it. The gate refused the first
  // version of this guard, which read the tenant's current jurisdiction, and it
  // was right to.
  //
  // AN EMPTY PERIOD PASSES, and that is complete rather than a gap: with no
  // bills there is no supply to report under any regime, and a tenant in a
  // jurisdiction whose rules are not built cannot raise a bill at all --
  // `generateBill` refuses it by name. So every period that contains money
  // contains a stamped jurisdiction, and this sees it.
  // #########################################################################
  const foreign = await context.client.query<{ tax_jurisdiction: string }>(
    `SELECT DISTINCT tax_jurisdiction
       FROM app.bill
      WHERE tenant_id = $1 AND branch_id = $2
        AND business_date BETWEEN $3::date AND $4::date
        AND status <> 'void' AND tax_jurisdiction <> 'IN'
      ORDER BY 1
      LIMIT 1`,
    args,
  );
  if (foreign.rows.length > 0) {
    throw new GstReturnWrongJurisdictionError(foreign.rows[0]!.tax_jurisdiction);
  }

  // Checked FIRST, before a single figure is read. A refusal that arrived after
  // the numbers were computed would tempt a caller to use them.
  //
  // The boundary is `> fromDate`: a change dated exactly on the first day of the
  // period puts the WHOLE period under the new position, which is a clean
  // period and not a split one.
  const spanning = await context.client.query<{ business_date: string }>(
    `SELECT DISTINCT business_date::text
       FROM app.branch_gst_registration_change
      WHERE tenant_id = $1 AND branch_id = $2
        AND business_date > $3::date AND business_date <= $4::date
      ORDER BY 1`,
    args,
  );
  if (spanning.rows.length > 0) {
    throw new GstPeriodSpansRegistrationChangeError(
      params.branchId, spanning.rows.map((r) => r.business_date));
  }

  // Checked before any figure is read, like the change test above: a refusal
  // that arrived after the numbers were computed would tempt a caller to use
  // them.
  const position = await context.client.query<{ supplier_gst_registration: string }>(
    `SELECT DISTINCT supplier_gst_registration
       FROM app.bill
      WHERE tenant_id = $1 AND branch_id = $2
        AND business_date BETWEEN $3::date AND $4::date
        AND status <> 'void' AND tax_account_type = 'gst' AND supplier_gst_registration = 'composition'
      LIMIT 1`,
    args,
  );
  if (position.rows.length > 0) {
    throw new GstReturnNotApplicableError(params.branchId, 'composition');
  }

  // Checked third, and also before any figure is read. A period that fails
  // BOTH tests should hear about the registration change first: it is the one
  // with a date in it.
  const unstated = await context.client.query<{ n: string; tax: string }>(
    `SELECT count(*)::text AS n, COALESCE(sum(tax_minor), 0)::text AS tax
       FROM app.bill
      WHERE tenant_id = $1 AND branch_id = $2
        AND business_date BETWEEN $3::date AND $4::date
        AND status <> 'void' AND tax_account_type = 'gst' AND tax_treatment = 'unstated'`,
    args,
  );
  const unstatedRow = unstated.rows[0]!;
  if (Number(unstatedRow.n) > 0) {
    throw new GstPeriodHasUnstatedTreatmentError(
      params.branchId, Number(unstatedRow.n), Number(unstatedRow.tax));
  }

  const b2bRows = await context.client.query<{
    recipient_gstin: string; recipient_legal_name: string;
  } & BucketRow>(
    `${LINE_CTE}
     ${BUCKET_SELECT}, recipient_gstin, recipient_legal_name
       FROM priced
      WHERE recipient_gstin IS NOT NULL
      GROUP BY recipient_gstin, recipient_legal_name, pos, tax_treatment, tax_rate_bps
      ORDER BY recipient_gstin, tax_rate_bps`,
    args,
  );

  const byGstin = new Map<string, { name: string; pos: string | null; buckets: RateBucket[] }>();
  for (const r of b2bRows.rows) {
    const entry = byGstin.get(r.recipient_gstin)
      ?? { name: r.recipient_legal_name, pos: r.pos, buckets: [] };
    entry.buckets.push(toBucket(r));
    byGstin.set(r.recipient_gstin, entry);
  }

  const b2cRows = await context.client.query<BucketRow>(
    `${LINE_CTE}
     ${BUCKET_SELECT}
       FROM priced
      WHERE recipient_gstin IS NULL
      GROUP BY pos, tax_treatment, tax_rate_bps
      ORDER BY tax_rate_bps`,
    args,
  );

  const credits = await context.client.query<{
    id: string; bill_no: number; reason_key: string | null; taxable_minor: string | null;
    tax_minor: string | null; tax_rate_bps: number | null; refunded_at: string;
  }>(
    `SELECT r.id, b.bill_no, ar.key AS reason_key,
            r.taxable_minor::text, r.tax_minor::text, r.tax_rate_bps,
            r.refunded_at::text
       FROM app.refund r
       JOIN app.bill b ON b.tenant_id = r.tenant_id AND b.id = r.bill_id
       LEFT JOIN app.adjustment_reason ar ON ar.tenant_id = r.tenant_id AND ar.id = r.reason_id
      WHERE r.tenant_id = $1 AND r.branch_id = $2
        AND b.business_date BETWEEN $3::date AND $4::date
        AND b.tax_account_type = 'gst'
      ORDER BY r.refunded_at`,
    args,
  );

  const supplier = await context.client.query<{ supplier_gstin: string | null }>(
    `SELECT DISTINCT supplier_gstin FROM app.bill
      WHERE tenant_id = $1 AND branch_id = $2
        AND business_date BETWEEN $3::date AND $4::date
        AND supplier_gstin IS NOT NULL LIMIT 1`,
    args,
  );

  const b2b: B2BSupply[] = [...byGstin.entries()].map(([gstin, v]) => ({
    recipientGstin: gstin,
    recipientName: v.name,
    placeOfSupplyStateCode: v.pos,
    buckets: v.buckets,
  }));
  const b2c = b2cRows.rows.map(toBucket);

  const all = [...b2b.flatMap((s) => s.buckets), ...b2c];
  return {
    branchId: params.branchId,
    fromDate: params.fromDate,
    toDate: params.toDate,
    supplierGstin: supplier.rows[0]?.supplier_gstin ?? null,
    b2b,
    b2c,
    creditNotes: credits.rows.map((r) => ({
      refundId: r.id,
      billNo: r.bill_no,
      reasonKey: r.reason_key,
      taxableMinor: Number(r.taxable_minor ?? 0),
      taxMinor: Number(r.tax_minor ?? 0),
      rateBps: r.tax_rate_bps,
      refundedAt: r.refunded_at,
    })),
    totals: {
      taxableMinor: all.reduce((a, x) => a + x.taxableMinor, 0),
      cgstMinor: all.reduce((a, x) => a + x.cgstMinor, 0),
      sgstMinor: all.reduce((a, x) => a + x.sgstMinor, 0),
      igstMinor: all.reduce((a, x) => a + x.igstMinor, 0),
    },
  };
}

interface BucketRow {
  tax_rate_bps: number;
  tax_treatment: 'intra_state' | 'inter_state' | 'none';
  pos: string | null;
  taxable_minor: string;
  cgst_minor: string;
  sgst_minor: string;
  igst_minor: string;
  printed_heads_minor: string;
  bill_count: string;
}

function toBucket(r: BucketRow): RateBucket {
  return {
    rateBps: r.tax_rate_bps,
    treatment: r.tax_treatment,
    placeOfSupplyStateCode: r.pos,
    taxableMinor: Number(r.taxable_minor),
    cgstMinor: Number(r.cgst_minor),
    sgstMinor: Number(r.sgst_minor),
    igstMinor: Number(r.igst_minor),
    printedHeadsMinor: Number(r.printed_heads_minor),
    billCount: Number(r.bill_count),
  };
}

export interface ReconciliationCheck {
  readonly matches: boolean;
  readonly returnTaxableMinor: number;
  readonly billTaxableMinor: number;
  readonly returnTaxMinor: number;
  readonly billTaxMinor: number;
  /**
   * The heads PRINTED on the documents, summed from `bill_line.tax_components`.
   *
   * ###########################################################################
   * THE ONE INDEPENDENT ASSERTION LEFT, AND WHY IT IS REPORTED SEPARATELY.
   *
   * Since the heads are derived from `tax_treatment` and `tax_minor`,
   * cgst + sgst = tax_minor holds by arithmetic and the reconciliation above
   * can no longer disagree about the TOTAL. What it can still catch is the
   * paper: whether the figures being filed are the ones the customer was
   * handed. That is a genuinely separate fact, because the components were
   * written at bill time by `splitHeads` and these buckets are computed now.
   *
   * FALSE IS EXPECTED FOR PRE-0050 DOCUMENTS and is not a defect: those bills
   * carry either a jsonb `null` scalar or `{name, rate_bps}` with no amount, so
   * nothing was ever printed to compare against. It is reported as its own
   * field rather than folded into `matches` so that a filer can tell "the paper
   * and the return disagree" from "these bills predate the heads existing".
   * ###########################################################################
   */
  readonly printedHeadsMinor: number;
  readonly printedHeadsMatch: boolean;
}

/**
 * The return must reconcile EXACTLY to the bills it came from.
 *
 * Summed independently -- off `bill_line` directly rather than through the
 * bucketing -- so this cannot agree with the return merely by sharing its
 * arithmetic. Exposed as a function rather than kept in a test so it can run as a
 * pre-filing check against real data.
 */
export async function reconcileReturnToBills(
  context: TenantContext,
  params: { branchId: string; fromDate: string; toDate: string },
): Promise<ReconciliationCheck> {
  const ret = await outwardSupplyReturn(context, params);

  const direct = await context.client.query<{ taxable: string; tax: string }>(
    `SELECT COALESCE(SUM(bl.amount_minor), 0)::text AS taxable,
            COALESCE(SUM(bl.tax_minor), 0)::text    AS tax
       FROM app.bill b
       JOIN app.bill_line bl ON bl.tenant_id = b.tenant_id AND bl.bill_id = b.id
      WHERE b.tenant_id = $1 AND b.branch_id = $2
        AND b.business_date BETWEEN $3::date AND $4::date
        AND b.status <> 'void' AND b.tax_account_type = 'gst'`,
    [context.tenantId, params.branchId, params.fromDate, params.toDate],
  );

  const billTaxable = Number(direct.rows[0]!.taxable);
  const billTax = Number(direct.rows[0]!.tax);
  const returnTax = ret.totals.cgstMinor + ret.totals.sgstMinor + ret.totals.igstMinor;
  const printed = [...ret.b2b.flatMap((sup) => sup.buckets), ...ret.b2c]
    .reduce((sum, bucket) => sum + bucket.printedHeadsMinor, 0);

  return {
    matches: ret.totals.taxableMinor === billTaxable && returnTax === billTax,
    returnTaxableMinor: ret.totals.taxableMinor,
    billTaxableMinor: billTaxable,
    returnTaxMinor: returnTax,
    billTaxMinor: billTax,
    printedHeadsMinor: printed,
    printedHeadsMatch: printed === returnTax,
  };
}
