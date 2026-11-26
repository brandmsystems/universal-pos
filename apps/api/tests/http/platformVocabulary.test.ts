import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ownerClient } from '../helpers/db.js';
import {
  tenantStatusWord, tenantStatusTone,
  subscriptionStatusWord, subscriptionStatusTone,
  invoiceStatusWord,
} from '../../../web/src/app/platform/tokens.js';

/**
 * The tone functions return Tailwind classes now (Phase 20's redesign moved
 * the platform console's colour VALUES into globals.css), not the hex-bearing
 * `p` object this file used to import. The three literal strings below are
 * tokens.ts's own -- copied here as named constants rather than re-imported,
 * because a private module-level constant is not exported and this test's
 * job is to check the PUBLIC function's output, not reach into its internals.
 */
const NEUTRAL = 'text-muted-foreground';
const WARN = 'text-status-warn';
const STOP = 'text-status-critical';

/**
 * ###########################################################################
 * THE CONSOLE HOLDS THREE COPIES OF A SCHEMA VOCABULARY, SO THEY ARE GATED.
 *
 * `adminSurface.test.ts` already does this for `gst_registration` and
 * `premises_class`, and the argument is written out there: no API response
 * carries the permitted values, so the list has to live on the client, and a
 * copy nothing checks is the shape this repo keeps finding.
 *
 * The control-plane console was written without applying it, and the cost showed
 * the first time the screen was opened against real data. `platform.tenant.status`
 * has SEVEN rungs; the client knew four of them, invented two that no column
 * permits (`suspended`, `delinquent` -- dead branches that could never run), and
 * rendered `hard_lock` and `retention` in the same neutral grey as `active`. A
 * restaurant the product had stopped serving looked exactly like a healthy one.
 *
 * So: the CHECK constraints are the authority, read out of the catalogue rather
 * than restated here -- a hardcoded expectation would be a fourth copy and would
 * pass forever.
 * ###########################################################################
 */

let owner: pg.Client;

beforeAll(async () => { owner = ownerClient(); await owner.connect(); });
afterAll(async () => { await owner?.end(); });

async function permitted(constraint: string): Promise<readonly string[]> {
  const row = (await owner.query<{ src: string }>(
    `SELECT pg_get_constraintdef(oid) AS src FROM pg_constraint WHERE conname = $1`,
    [constraint])).rows[0];
  expect(row, `the constraint ${constraint} could not be read; the gate is vacuous`)
    .toBeDefined();
  return [...row!.src.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
}

describe('the console knows every value its columns permit', () => {
  it('has words for the seven rungs of the suspension ladder and for deactivated', async () => {
    const values = await permitted('tenant_status_known');
    expect(values).toEqual([
      'active', 'deactivated', 'hard_lock', 'past_due', 'purge_pending', 'purged',
      'retention', 'soft_lock',
    ]);

    // Every value gets a word that is not merely the raw value spaced out. The
    // fallback exists so an unknown rung is visible rather than blank; a value
    // the schema permits TODAY must not be relying on it.
    for (const status of values) {
      const word = tenantStatusWord(status);
      expect(word, `${status} has no word`).not.toBe(status.replace(/_/g, ' '));
    }
  });

  it('colours every rung below soft_lock as a stop, including ones added later',
    async () => {
      const values = await permitted('tenant_status_known');
      for (const status of values) {
        const tone = tenantStatusTone(status);
        if (status === 'active') expect(tone, status).toBe(NEUTRAL);
        else if (status === 'past_due' || status === 'soft_lock') {
          expect(tone, status).toBe(WARN);
        } else expect(tone, `${status} withholds service and must read as a stop`)
          .toBe(STOP);
      }

      // An eighth rung added to the ladder must NOT come out neutral. Every rung
      // added so far has been worse than the last, so the unknown case defaults
      // to the loud end -- asserted, because a default nobody checks is a
      // default that quietly becomes wrong.
      expect(tenantStatusTone('some_rung_added_in_2027')).toBe(STOP);
    });

  it('keeps the subscription vocabulary separate from the ladder', async () => {
    const values = await permitted('subscription_status_known');
    expect(values).toEqual(['active', 'cancelled', 'expired', 'past_due', 'trialing']);
    for (const status of values) {
      expect(subscriptionStatusWord(status), `${status} has no word`)
        .not.toBe(status.replace(/_/g, ' '));
    }

    // The two columns share `active` and `past_due` and nothing else. `trialing`
    // is not a tenant state and `hard_lock` is not a subscription state, so one
    // map covering both would be wrong for one of them -- which is what the
    // first version of the console did.
    expect(tenantStatusWord('hard_lock')).toBe('Hard locked');
    expect(subscriptionStatusWord('trialing')).toBe('Trialing');
    expect(subscriptionStatusTone('cancelled')).toBe(STOP);
  });

  it('has words for every invoice status', async () => {
    const values = await permitted('invoice_status_known');
    expect(values).toEqual(['issued', 'paid', 'void']);
    for (const status of values) {
      expect(invoiceStatusWord(status), `${status} has no word`)
        .not.toBe(status.replace(/_/g, ' '));
    }
  });

  it('invents nothing: every word maps a value some column permits', async () => {
    // The other direction, and the one that would have caught `suspended` and
    // `delinquent` on the day they were written. A word for a value no column
    // can hold is a branch that never runs and a reader who believes it does.
    const known = new Set([
      ...await permitted('tenant_status_known'),
      ...await permitted('subscription_status_known'),
      ...await permitted('invoice_status_known'),
    ]);

    const invented = ['suspended', 'delinquent', 'archived', 'deleted']
      .filter((status) => known.has(status));
    expect(invented, 'this list is meant to name values NO column permits')
      .toEqual([]);

    for (const status of ['suspended', 'delinquent']) {
      // They must fall through the map rather than resolve to a word, which is
      // what proves the invented entries are gone.
      expect(tenantStatusWord(status), `${status} is not a tenant status`)
        .toBe(status);
      expect(subscriptionStatusWord(status), `${status} is not a subscription status`)
        .toBe(status);
    }
  });
});
