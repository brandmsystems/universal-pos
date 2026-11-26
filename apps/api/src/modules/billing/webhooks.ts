import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * Gateway webhooks.
 *
 * ###########################################################################
 * A WEBHOOK IS NEVER THE SOLE SOURCE OF TRUTH, AND NEVER SUSPENDS ANYTHING.
 *
 * Delivery is at-least-once, arrives out of order, and is replayable by anyone
 * who can reach the endpoint. Three defences, none of which is optional:
 *
 *   1. Signature verification, constant-time. An unverified event is RECORDED as
 *      evidence of an attempted forgery and can only ever be rejected -- the
 *      schema will not let it reach any other terminal state.
 *   2. Idempotency on the gateway's own event id.
 *   3. A monotonic guard on the gateway's timestamp, so a late-delivered older
 *      event cannot undo a newer one. Same protection as
 *      entitlement_document.version, for the same reason.
 *
 * And a webhook never calls the ladder. It records payment facts; the ladder job
 * owns the thresholds and the audit trail. A gateway hiccup must not be able to
 * lock a restaurant out mid-service.
 * ###########################################################################
 */

export class SignatureInvalidError extends Error {
  readonly statusCode = 401;
  readonly code = 'webhook_signature_invalid';
  constructor() {
    super('webhook signature did not verify');
    this.name = 'SignatureInvalidError';
  }
}

export function verifySignature(
  rawBody: string, signatureHeader: string, secret: string,
): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = Buffer.from(signatureHeader, 'utf8');
  const computed = Buffer.from(expected, 'utf8');
  // Length check first: timingSafeEqual throws on a mismatch, and that throw is
  // itself a length oracle if it escapes.
  if (provided.length !== computed.length) return false;
  return timingSafeEqual(provided, computed);
}

/**
 * A PAN must never reach a log line. Applied at the logging boundary rather than
 * trusted not to occur -- the prohibition is absolute, so it needs a mechanism
 * and not a convention.
 */
export function redactPan(text: string): string {
  return text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, '[REDACTED-PAN]');
}

export type IngestOutcome =
  | 'accepted' | 'duplicate' | 'rejected_signature' | 'stale';

export interface IngestResult {
  readonly outcome: IngestOutcome;
  readonly eventId: string | null;
}

/**
 * Records the event. Does NOT act on it: recording and processing are separate so
 * a slow or failing processor cannot cause the gateway to retry forever, and so
 * an event that arrives during a deploy is not lost.
 */
export async function ingestWebhook(
  client: pg.ClientBase,
  params: {
    gateway: 'razorpay' | 'stripe' | 'manual';
    rawBody: string;
    signatureHeader: string;
    secret: string;
    gatewayEventId: string;
    eventType: string;
    gatewayCreatedAt: Date;
    tenantId?: string | null;
    payload: Record<string, unknown>;
  },
): Promise<IngestResult> {
  const verified = verifySignature(params.rawBody, params.signatureHeader, params.secret);

  const eventId = randomUUID();
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO platform.gateway_event
       (id, gateway, gateway_event_id, event_type, gateway_created_at, tenant_id,
        payload, signature_verified, status, status_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
     ON CONFLICT (gateway, gateway_event_id) DO NOTHING
     RETURNING id`,
    [eventId, params.gateway, params.gatewayEventId, params.eventType,
     params.gatewayCreatedAt, params.tenantId ?? null,
     JSON.stringify(params.payload), verified,
     verified ? 'pending' : 'rejected',
     verified ? null : 'signature did not verify; retained as evidence, never processed'],
  );

  if (inserted.rowCount === 0) return { outcome: 'duplicate', eventId: null };
  if (!verified) return { outcome: 'rejected_signature', eventId };

  // Monotonic guard: an older event for the same tenant that arrives after a
  // newer one has already been processed must not be acted on.
  if (params.tenantId) {
    const newer = await client.query(
      `SELECT 1 FROM platform.gateway_event
        WHERE tenant_id = $1 AND gateway = $2 AND id <> $3
          AND status = 'processed' AND gateway_created_at > $4 LIMIT 1`,
      [params.tenantId, params.gateway, eventId, params.gatewayCreatedAt],
    );
    if (newer.rowCount && newer.rowCount > 0) {
      await client.query(
        `UPDATE platform.gateway_event
            SET status = 'ignored', processed_at = now(),
                status_detail = 'superseded by a newer event already processed'
          WHERE id = $1`, [eventId]);
      return { outcome: 'stale', eventId };
    }
  }

  return { outcome: 'accepted', eventId };
}

export interface PaymentFact {
  readonly gatewayPaymentId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: 'pending' | 'captured' | 'failed' | 'refunded';
  readonly failureCode?: string | null;
  readonly methodToken?: string | null;
  readonly methodBrand?: string | null;
  readonly methodLast4?: string | null;
}

export class PanRefusedError extends Error {
  readonly statusCode = 400;
  readonly code = 'pan_refused';
  constructor() {
    super(
      'a value resembling a card number was supplied. Card numbers are never stored; ' +
        'token references only, without exception.',
    );
    this.name = 'PanRefusedError';
  }
}

/**
 * Records a payment and settles the invoice if it covers it.
 *
 * Notably absent: any call to the ladder. Recovery is recomputed by the ladder
 * job from `delinquent_since`, which is the only place the thresholds live.
 */
export async function recordPayment(
  client: pg.ClientBase,
  params: {
    tenantId: string; invoiceId: string | null; gateway: string;
    fact: PaymentFact; eventId: string;
  },
): Promise<{ paymentId: string; invoicePaid: boolean }> {
  if (params.fact.methodToken && /\d{13,19}/.test(params.fact.methodToken.replace(/[ -]/g, ''))) {
    throw new PanRefusedError();
  }

  const paymentId = randomUUID();
  await client.query(
    `INSERT INTO platform.gateway_payment
       (id, tenant_id, invoice_id, gateway, gateway_payment_id, amount_minor, currency,
        status, failure_code, method_token, method_brand, method_last4, captured_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (gateway, gateway_payment_id) DO NOTHING`,
    [paymentId, params.tenantId, params.invoiceId, params.gateway,
     params.fact.gatewayPaymentId, params.fact.amountMinor, params.fact.currency,
     params.fact.status, params.fact.failureCode ?? null,
     params.fact.methodToken ?? null, params.fact.methodBrand ?? null,
     params.fact.methodLast4 ?? null,
     params.fact.status === 'captured' ? new Date() : null],
  );

  let invoicePaid = false;
  if (params.fact.status === 'captured' && params.invoiceId) {
    const settled = await client.query(
      `UPDATE platform.invoice SET status = 'paid', paid_at = now()
        WHERE id = $1 AND status = 'issued'
          AND total_minor <= (SELECT COALESCE(SUM(amount_minor), 0)
                                FROM platform.gateway_payment
                               WHERE invoice_id = $1 AND status = 'captured')`,
      [params.invoiceId],
    );
    invoicePaid = (settled.rowCount ?? 0) > 0;
  }

  await client.query(
    `UPDATE platform.gateway_event SET status = 'processed', processed_at = now()
      WHERE id = $1`, [params.eventId]);

  return { paymentId, invoicePaid };
}

export interface ReconciliationResult {
  readonly checked: number;
  readonly healed: number;
  readonly stillMissing: readonly string[];
}

/**
 * The self-heal for a MISSED webhook.
 *
 * A system that only learns by webhook has no way to discover what it never
 * received. This walks invoices that look unpaid and asks the gateway directly;
 * anything the gateway considers captured is recorded here as if the webhook had
 * arrived.
 *
 * `fetchPayments` is injected so this module holds no HTTP client and stays
 * testable without a network.
 */
export async function reconcileAgainstGateway(
  client: pg.ClientBase,
  params: {
    olderThan: Date;
    fetchPayments: (invoiceId: string) => Promise<readonly PaymentFact[]>;
  },
): Promise<ReconciliationResult> {
  const candidates = await client.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM platform.invoice
      WHERE status = 'issued' AND issued_at < $1
      ORDER BY issued_at`,
    [params.olderThan],
  );

  let healed = 0;
  const stillMissing: string[] = [];

  for (const invoice of candidates.rows) {
    const facts = await params.fetchPayments(invoice.id);
    const captured = facts.filter((f) => f.status === 'captured');
    if (captured.length === 0) {
      stillMissing.push(invoice.id);
      continue;
    }

    for (const fact of captured) {
      const eventId = randomUUID();
      await client.query(
        `INSERT INTO platform.gateway_event
           (id, gateway, gateway_event_id, event_type, gateway_created_at, tenant_id,
            payload, signature_verified, status, status_detail)
         VALUES ($1,'manual',$2,'reconciliation.payment',now(),$3,$4::jsonb,true,'pending',
                 'discovered by reconciliation, not by webhook')
         ON CONFLICT (gateway, gateway_event_id) DO NOTHING`,
        [eventId, `recon:${fact.gatewayPaymentId}`, invoice.tenant_id,
         JSON.stringify({ invoiceId: invoice.id, gatewayPaymentId: fact.gatewayPaymentId })],
      );
      const result = await recordPayment(client, {
        tenantId: invoice.tenant_id, invoiceId: invoice.id,
        gateway: 'manual', fact, eventId,
      });
      if (result.invoicePaid) healed += 1;
    }
  }

  return { checked: candidates.rowCount ?? 0, healed, stillMissing };
}
