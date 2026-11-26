import { describe, expect, it } from 'vitest';
import { formatMinorRounded, minorFrom, previewPayment, type Minor } from '../src/lib/money.js';

/**
 * `previewPayment` mirrors the server's `takePayment`: non-cash first, each
 * REFUSED (not capped) above what is left; then cash pays what is left and the
 * rest is change. Integer minor units throughout.
 */

const m = (n: number): Minor => minorFrom(n);

describe('previewPayment', () => {
  it('UPI then cash: what is added and the balance left after both', () => {
    expect(previewPayment(m(41370), [{ method: 'upi', amountMinor: m(20000) }, { method: 'cash', cashReceivedMinor: m(10000) }]))
      .toEqual({ state: 'applies', lines: [{ method: 'upi', appliedMinor: 20000 }, { method: 'cash', appliedMinor: 10000 }],
        addedMinor: 30000, balanceAfterMinor: 11370, changeMinor: 0 });
  });

  it('cash over what is left is change, never sales -- and not part of what is added', () => {
    expect(previewPayment(m(41370), [{ method: 'card', amountMinor: m(30000) }, { method: 'cash', cashReceivedMinor: m(20000) }]))
      .toEqual({ state: 'applies', lines: [{ method: 'card', appliedMinor: 30000 }, { method: 'cash', appliedMinor: 11370 }],
        addedMinor: 41370, balanceAfterMinor: 0, changeMinor: 8630 });
  });

  it('non-cash is taken first whatever order it was typed in', () => {
    expect(previewPayment(m(1000), [{ method: 'cash', cashReceivedMinor: m(1000) }, { method: 'upi', amountMinor: m(600) }]))
      .toEqual({ state: 'applies', lines: [{ method: 'upi', appliedMinor: 600 }, { method: 'cash', appliedMinor: 400 }],
        addedMinor: 1000, balanceAfterMinor: 0, changeMinor: 600 });
  });

  it('a non-cash part above what is left is refused, as the server refuses it -- not capped', () => {
    expect(previewPayment(m(41370), [{ method: 'card', amountMinor: m(50000) }]))
      .toEqual({ state: 'refused', method: 'card', reason: 'exceeds_balance', leftMinor: 41370 });
    // The second part is measured against what the first left.
    expect(previewPayment(m(1000), [{ method: 'card', amountMinor: m(700) }, { method: 'upi', amountMinor: m(400) }]))
      .toEqual({ state: 'refused', method: 'upi', reason: 'exceeds_balance', leftMinor: 300 });
  });

  it('cash when the other methods already pay it all is refused, as the server refuses it', () => {
    expect(previewPayment(m(1000), [{ method: 'upi', amountMinor: m(1000) }, { method: 'cash', cashReceivedMinor: m(200) }]))
      .toEqual({ state: 'refused', method: 'cash', reason: 'already_paid', leftMinor: 0 });
  });

  it('stays in whole minor units -- one paise is one paise', () => {
    expect(previewPayment(m(1), [{ method: 'cash', cashReceivedMinor: m(3) }]))
      .toMatchObject({ addedMinor: 1, balanceAfterMinor: 0, changeMinor: 2 });
  });
});

describe('formatMinorRounded (display only)', () => {
  it('rounds to the nearest whole rupee, half up', () => {
    const shown = (minor: number) => formatMinorRounded(minorFrom(minor));
    expect(shown(29295)).toBe('₹293');
    expect(shown(19635)).toBe('₹196');
    expect(shown(19650)).toBe('₹197');
    expect(shown(19649)).toBe('₹196');
    expect(shown(100000)).toBe('₹1,000');
    expect(shown(0)).toBe('₹0');
  });
});
