import type pg from 'pg';
import type { Consumer } from './outboxWorker.js';

/**
 * The registered consumers.
 *
 * Every one of these is idempotent, and the per-consumer ledger is what makes
 * that true rather than assumed: the worker claims `(consumer, topic,
 * dedupe_key)` before doing the work, so a redelivery is skipped rather than
 * re-applied.
 *
 * `touchesTenantData` is a positive declaration, not something inferred from the
 * topic name. A consumer that says false and then writes an app row writes it
 * with no tenant GUC set, and `app.current_tenant_id()` raises -- loudly, which
 * is the design.
 */

/**
 * Stock deductions replayed from a device that was offline.
 *
 * ORDERED, by business date. Weighted average cost is order-dependent: applying
 * Tuesday's issue before Monday's values Monday against a basis that had already
 * moved. The ordered_group is set by the enqueuer to the branch, and order_seq to
 * the business date, so the worker cannot claim a later day while an earlier one
 * is still unresolved.
 */
export const stockDeductConsumer: Consumer = {
  name: 'stock.deduct',
  topics: ['stock.deduct.queued'],
  touchesTenantData: true,
  async handle(client: pg.ClientBase, message): Promise<void> {
    const kotId = message.payload['kotId'];
    if (typeof kotId !== 'string') {
      throw new Error(`stock.deduct.queued payload has no kotId: ${JSON.stringify(message.payload)}`);
    }
    // The deduction itself is already idempotent on the (kot, product) dedupe
    // key in stock_movement, so this is the second of two independent guards.
    const { deductForKot } = await import('../inventory/deduct.js');
    const entitlement = message.payload['entitlement'];
    await deductForKot(
      // No actor: a queued deduction is a system action, and the audit writer
      // refuses to attribute it to a membership nobody held.
      { client, tenantId: message.tenantId!, actor: null },
      {
        kotId,
        entitlement: entitlement as never,
        actorUserId: (message.payload['actorUserId'] as string | undefined) ?? null,
      },
    );
  },
};

/** Invalidates the tenant plane's cached entitlement document. Control plane only. */
export const entitlementInvalidationConsumer: Consumer = {
  name: 'entitlement.invalidate',
  topics: ['entitlement.invalidate'],
  touchesTenantData: false,
  async handle(_client: pg.ClientBase, message): Promise<void> {
    // A DEL: the tenant plane refills a missing entry from the document table
    // on its next request (`resolveEntitlement`), so dropping the entry is all
    // an upgrade, a downgrade or a lock needs to show up at once rather than
    // after the five-minute TTL. A failure throws, and the outbox retries it.
    if (message.tenantId === null) {
      throw new Error('entitlement.invalidate message carries no tenant id');
    }
    const { createRedis, RedisEntitlementCache } = await import('../platform/redisEntitlementCache.js');
    const redis = createRedis();
    try {
      await redis.connect();
      await new RedisEntitlementCache(redis).invalidate(message.tenantId);
    } finally {
      await redis.quit().catch(() => undefined);
    }
  },
};

/** Everything that ends in an email. Delivery is someone else's problem. */
export const notificationConsumer: Consumer = {
  name: 'notification',
  topics: [
    'tenant.owner_invite',
    'billing.downgrade_blocked',
    'billing.dunning_outreach',
    'impersonation.started',
  ],
  touchesTenantData: false,
  async handle(_client: pg.ClientBase, message): Promise<void> {
    // Handing off to the mail provider is I/O against a third party, which is
    // exactly what must NOT happen inside the enqueueing transaction -- the
    // reason the outbox exists at all.
    void message;
  },
};

export const CONSUMERS: readonly Consumer[] = [
  stockDeductConsumer,
  entitlementInvalidationConsumer,
  notificationConsumer,
];
