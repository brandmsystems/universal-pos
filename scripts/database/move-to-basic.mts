/**
 * One-off: the product is Basic only. Every restaurant on another plan moves to
 * Basic NOW, and every other plan is retired (no longer sold or offered). Plans
 * and their versions are NOT deleted -- subscriptions, segments and invoices
 * reference them, and they are the billing record of what was sold.
 *
 * The move goes through the billing module's own path rather than an UPDATE:
 * `changeSubscription` schedules the downgrade, and `applyDueChanges` applies
 * it (new segment, subscription row, entitlement document republished and the
 * cache invalidated, quota check first). The one deviation is WHEN: the
 * scheduled change is made due now instead of at the period end, because the
 * other plans are being withdrawn, not chosen down from.
 *
 *   tsx --env-file-if-exists=.env scripts/move-to-basic.mts [--dry-run]
 *
 * Idempotent: a restaurant already on Basic is left alone; a retired plan stays
 * retired. Self-verifying: exits non-zero unless every live subscription ends on
 * Basic and only Basic is active.
 */
import pg from 'pg';
import { env } from '../../backend/src/config/env.js';
import { changeSubscription } from '../../backend/src/modules/billing/planChange.js';
import { applyDueChanges } from '../../backend/src/modules/billing/scheduledChange.js';
import { setPlanStatus } from '../../backend/src/modules/platform/planCatalogue.js';

const dryRun = process.argv.includes('--dry-run');
// ONE instant for 'due' and 'apply': the database clock and this process's clock
// differ across a Docker VM, and a change made due by one is not yet due to the other.
const now = new Date();

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: env.ownerDatabaseUrl() });
  await client.connect();
  try {
    await client.query('BEGIN');
    const basic = (await client.query<{ plan_id: string; version_id: string }>(
      `SELECT p.id AS plan_id, v.id AS version_id FROM platform.plan p
         JOIN platform.plan_version v ON v.plan_id = p.id
        WHERE p.key = 'basic' AND v.published_at IS NOT NULL
        ORDER BY v.version DESC LIMIT 1`)).rows[0];
    if (!basic) throw new Error('no published Basic plan version');
    const actor = (await client.query<{ id: string }>(
      `SELECT u.id FROM platform.platform_user u JOIN platform.platform_role r ON r.id = u.platform_role_id
        WHERE r.key = 'super_admin' AND u.status = 'active' ORDER BY u.created_at LIMIT 1`)).rows[0];
    if (!actor) throw new Error('no active Super Admin to record as the requester');

    const moving = await client.query<{ subscription_id: string; slug: string; plan_key: string }>(
      `SELECT s.id AS subscription_id, t.slug, p.key AS plan_key
         FROM platform.subscription s
         JOIN platform.tenant t ON t.id = s.tenant_id
         JOIN platform.plan p ON p.id = s.plan_id
        WHERE s.status IN ('trialing', 'active', 'past_due') AND p.key <> 'basic'
        ORDER BY t.slug`);
    for (const row of moving.rows) {
      console.log(`${dryRun ? 'would move' : 'moving'} ${row.slug}: ${row.plan_key} -> basic`);
      if (dryRun) continue;
      // Any pending change would block the new one (one pending change per subscription).
      await client.query(
        `UPDATE platform.scheduled_subscription_change SET status = 'revoked', revoked_at = now()
          WHERE subscription_id = $1 AND status = 'pending'`, [row.subscription_id]);
      const result = await changeSubscription(client, {
        subscriptionId: row.subscription_id, targetPlanVersionId: basic.version_id,
        requestedByPlatformUserId: actor.id,
      });
      if (result.effect === 'at_period_end') {
        await client.query(
          `UPDATE platform.scheduled_subscription_change SET effective_at = $2
            WHERE id = $1`, [result.scheduled.id, now]);
      }
    }
    if (!dryRun && moving.rows.length > 0) {
      for (const applied of await applyDueChanges(client, { now })) {
        console.log(`  change ${applied.changeId}: ${applied.outcome}`);
      }
    }

    const others = await client.query<{ id: string; key: string; status: string }>(
      `SELECT id, key, status FROM platform.plan WHERE key <> 'basic' ORDER BY key`);
    for (const plan of others.rows) {
      if (plan.status === 'retired') { console.log(`${plan.key}: already retired`); continue; }
      console.log(`${dryRun ? 'would retire' : 'retiring'} plan ${plan.key}`);
      if (!dryRun) await setPlanStatus(client, { planId: plan.id, status: 'retired' });
    }

    if (dryRun) { await client.query('ROLLBACK'); return; }

    // Positive postconditions, or nothing is kept.
    const left = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.subscription s JOIN platform.plan p ON p.id = s.plan_id
        WHERE s.status IN ('trialing', 'active', 'past_due') AND p.key <> 'basic'`);
    const active = await client.query<{ key: string }>(`SELECT key FROM platform.plan WHERE status = 'active'`);
    if (left.rows[0]!.n !== '0' || active.rows.map((r) => r.key).join(',') !== 'basic') {
      throw new Error(`postcondition failed: ${left.rows[0]!.n} live non-Basic subscription(s); active plans ${active.rows.map((r) => r.key).join(',')}`);
    }
    await client.query('COMMIT');
    console.log('done: every live subscription is on Basic; only Basic is active');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
