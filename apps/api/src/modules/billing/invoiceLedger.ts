import type pg from 'pg';

/**
 * The invoice list the billing console opens on.
 *
 * ###########################################################################
 * IT READS THE SNAPSHOT, NEVER THE LIVE PARTY OR THE LIVE PRICE.
 *
 * `platform.invoice` carries `recipient_legal_name`, `recipient_gstin` and
 * `recipient_state_code` on the row on purpose -- "a tenant relocating from
 * Karnataka to Maharashtra must not retroactively convert two years of invoices
 * from CGST+SGST to IGST". A list that joined `platform.tenant_tax_profile` for
 * a nicer-looking name would undo that at the point of display: the screen and
 * the PDF would then disagree about who was invoiced, and the screen is what
 * somebody reads out on a support call.
 *
 * The tenant join is for `tenant.slug` alone -- an operator-facing handle that
 * is not part of the document -- and the tenant NAME shown is the recipient
 * name the invoice recorded.
 * ###########################################################################
 */

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export function boundedLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(requested), MAX_PAGE_SIZE);
}

export interface InvoiceListRow {
  readonly invoiceId: string;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly number: string;
  readonly financialYear: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly status: string;
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly roundOffMinor: number;
  readonly totalMinor: number;
  readonly taxTreatment: string;
  readonly placeOfSupplyStateCode: string;
  /** As recorded ON the invoice. See the header. */
  readonly recipientLegalName: string;
  readonly recipientGstin: string | null;
  /** Captured payments against this invoice, summed. Zero is not "unpaid". */
  readonly capturedMinor: number;
  readonly paidAt: string | null;
  /** True once due_date has passed and the invoice is still `issued`. */
  readonly overdue: boolean;
}

export interface ListInvoicesParams {
  readonly tenantId?: string | undefined;
  readonly status?: string | undefined;
  /** Only invoices past their due date and still unpaid. */
  readonly overdueOnly?: boolean | undefined;
  readonly limit?: number | undefined;
  /** A Salesperson's own book: only restaurants that user provisioned. */
  readonly provisionedByPlatformUserId?: string | undefined;
}

export async function listInvoices(
  client: pg.ClientBase,
  params: ListInvoicesParams = {},
): Promise<readonly InvoiceListRow[]> {
  const result = await client.query<{
    id: string; tenant_id: string; slug: string; number: string; financial_year: string;
    issue_date: string; due_date: string; status: string; currency: string;
    subtotal_minor: string; tax_minor: string; round_off_minor: string; total_minor: string;
    tax_treatment: string; place_of_supply_state_code: string;
    recipient_legal_name: string; recipient_gstin: string | null;
    captured_minor: string; paid_at: string | null; overdue: boolean;
  }>(
    `SELECT i.id, i.tenant_id, t.slug::text AS slug, i.number, i.financial_year,
            i.issue_date::text, i.due_date::text, i.status, i.currency,
            i.subtotal_minor::text, i.tax_minor::text, i.round_off_minor::text,
            i.total_minor::text,
            i.tax_treatment, i.place_of_supply_state_code,
            i.recipient_legal_name, i.recipient_gstin,
            COALESCE((SELECT sum(g.amount_minor) FROM platform.gateway_payment g
                       WHERE g.invoice_id = i.id AND g.status = 'captured'), 0)::text
              AS captured_minor,
            i.paid_at::text,
            (i.status = 'issued' AND i.due_date < CURRENT_DATE) AS overdue
       FROM platform.invoice i
       JOIN platform.tenant t ON t.id = i.tenant_id
      WHERE ($1::uuid IS NULL OR i.tenant_id = $1::uuid)
        AND ($2::text IS NULL OR i.status = $2::text)
        AND ($3::boolean IS NOT TRUE
             OR (i.status = 'issued' AND i.due_date < CURRENT_DATE))
        AND ($5::uuid IS NULL OR EXISTS (
              SELECT 1 FROM platform.provisioning_request pr
               WHERE pr.tenant_id = i.tenant_id AND pr.requested_by_platform_user_id = $5::uuid))
      ORDER BY i.issue_date DESC, i.number DESC
      LIMIT $4::int`,
    [
      params.tenantId ?? null,
      params.status ?? null,
      params.overdueOnly ?? false,
      boundedLimit(params.limit),
      params.provisionedByPlatformUserId ?? null,
    ],
  );

  return result.rows.map((row) => ({
    invoiceId: row.id,
    tenantId: row.tenant_id,
    tenantSlug: row.slug,
    number: row.number,
    financialYear: row.financial_year,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    status: row.status,
    currency: row.currency,
    subtotalMinor: Number(row.subtotal_minor),
    taxMinor: Number(row.tax_minor),
    roundOffMinor: Number(row.round_off_minor),
    totalMinor: Number(row.total_minor),
    taxTreatment: row.tax_treatment,
    placeOfSupplyStateCode: row.place_of_supply_state_code,
    recipientLegalName: row.recipient_legal_name,
    recipientGstin: row.recipient_gstin,
    capturedMinor: Number(row.captured_minor),
    paidAt: row.paid_at,
    overdue: row.overdue,
  }));
}
