import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * Transactional outbox.
 *
 * Messages are written in the SAME transaction as the state change that produced
 * them, so a rolled-back provisioning cannot leave a queued invite email, and a
 * committed tenant cannot fail to queue one.
 *
 * Delivery is AT LEAST ONCE. A worker can crash after a downstream system has
 * accepted a message but before the row is marked delivered, so redelivery is
 * normal operation rather than an error path. Consumers must be idempotent, and
 * `markConsumed` is how that is made true instead of assumed.
 */

export interface OutboxMessage {
  readonly topic: string;
  /** Stable across redeliveries of the same logical event. */
  readonly dedupeKey: string;
  readonly payload: Record<string, unknown>;
  readonly availableAt?: Date;
}

export interface OutboxRow {
  id: string;
  topic: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Enqueuing the same (topic, dedupeKey) twice is a no-op rather than an error:
 * a retried provisioning must not produce two invite emails.
 */
export async function enqueue(
  client: pg.ClientBase,
  message: OutboxMessage,
): Promise<{ id: string; created: boolean }> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.outbox (id, topic, dedupe_key, payload, available_at)
     VALUES ($1, $2, $3, $4::jsonb, COALESCE($5, now()))
     ON CONFLICT (topic, dedupe_key) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      message.topic,
      message.dedupeKey,
      JSON.stringify(message.payload),
      message.availableAt ?? null,
    ],
  );

  const inserted = result.rows[0];
  if (inserted) return { id: inserted.id, created: true };

  const existing = await client.query<{ id: string }>(
    `SELECT id FROM platform.outbox WHERE topic = $1 AND dedupe_key = $2`,
    [message.topic, message.dedupeKey],
  );
  return { id: existing.rows[0]!.id, created: false };
}

/**
 * Claims due messages with FOR UPDATE SKIP LOCKED so several workers can drain
 * concurrently without handing the same message to two of them.
 */
export async function claimBatch(
  client: pg.ClientBase,
  limit = 20,
): Promise<readonly OutboxRow[]> {
  const result = await client.query<OutboxRow>(
    `SELECT id, topic, dedupe_key, payload, attempts
       FROM platform.outbox
      WHERE delivered_at IS NULL AND available_at <= now()
      ORDER BY available_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return result.rows;
}

/**
 * Records that a consumer has handled a logical event, returning false if it had
 * already handled it. This is the exactly-once EFFECT that at-least-once delivery
 * cannot provide on its own -- the primary key does the work, not a prior SELECT.
 */
export async function markConsumed(
  client: pg.ClientBase,
  consumer: string,
  topic: string,
  dedupeKey: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO platform.outbox_consumption (consumer, topic, dedupe_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (consumer, topic, dedupe_key) DO NOTHING`,
    [consumer, topic, dedupeKey],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markDelivered(client: pg.ClientBase, id: string): Promise<void> {
  // status AND delivered_at, together. status became the discriminator when the
  // worker landed; setting the timestamp alone leaves a row that claims to be
  // pending and delivered at once, which the consistency CHECK now refuses.
  await client.query(
    `UPDATE platform.outbox
        SET status = 'delivered', delivered_at = now(), claimed_at = NULL, claimed_by = NULL
      WHERE id = $1`,
    [id],
  );
}

