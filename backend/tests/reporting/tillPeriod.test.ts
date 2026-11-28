import { describe, expect, it } from 'vitest';
import {
  TillPeriodUnknownError, TillRangeInvalidError, chosenRange, periodRange, resolveTillRange,
} from '../../src/modules/reports/tillSummary.js';

describe('My takings periods: business dates ending today', () => {
  it('a day is today alone', () => {
    expect(periodRange('day', '2026-10-22')).toEqual({ fromDate: '2026-10-22', toDate: '2026-10-22' });
  });

  it('a week starts on Monday, whatever day today is', () => {
    expect(periodRange('week', '2026-10-19').fromDate).toBe('2026-10-19'); // Monday itself
    expect(periodRange('week', '2026-10-22').fromDate).toBe('2026-10-19'); // Thursday
    expect(periodRange('week', '2026-10-25').fromDate).toBe('2026-10-19'); // Sunday, not the next Monday
    expect(periodRange('week', '2026-11-01').fromDate).toBe('2026-10-26'); // across a month boundary
  });

  it('a month starts on the 1st', () => {
    expect(periodRange('month', '2026-10-22')).toEqual({ fromDate: '2026-10-01', toDate: '2026-10-22' });
    expect(periodRange('month', '2026-03-01')).toEqual({ fromDate: '2026-03-01', toDate: '2026-03-01' });
  });
});

describe('My takings chosen range: business dates the person picks', () => {
  const problem = (fn: () => unknown): string => {
    try { fn(); } catch (error) {
      expect(error).toBeInstanceOf(TillRangeInvalidError);
      return (error as TillRangeInvalidError).problem;
    }
    throw new Error('not refused');
  };

  it('a range is returned as given, a single day included', () => {
    expect(chosenRange('2026-10-01', '2026-10-15', '2026-10-22')).toEqual({ fromDate: '2026-10-01', toDate: '2026-10-15' });
    expect(chosenRange('2026-10-22', '2026-10-22', '2026-10-22')).toEqual({ fromDate: '2026-10-22', toDate: '2026-10-22' });
  });

  it('refuses each unusable range, naming which problem it has', () => {
    expect(problem(() => chosenRange('2026-10-01', undefined, '2026-10-22'))).toBe('incomplete');
    expect(problem(() => chosenRange('', '2026-10-02', '2026-10-22'))).toBe('incomplete');
    expect(problem(() => chosenRange('01/10/2026', '2026-10-02', '2026-10-22'))).toBe('malformed');
    expect(problem(() => chosenRange('2026-02-30', '2026-03-02', '2026-10-22'))).toBe('malformed');
    expect(problem(() => chosenRange(['2026-10-01'], '2026-10-02', '2026-10-22'))).toBe('malformed');
    expect(problem(() => chosenRange('2026-10-10', '2026-10-09', '2026-10-22'))).toBe('reversed');
    expect(problem(() => chosenRange('2026-10-20', '2026-10-23', '2026-10-22'))).toBe('future');
  });

  it('366 business dates is the longest range, both ends counted', () => {
    expect(chosenRange('2025-10-22', '2026-10-22', '2026-10-22').fromDate).toBe('2025-10-22'); // 366 days
    expect(problem(() => chosenRange('2025-10-21', '2026-10-22', '2026-10-22'))).toBe('too_long');
  });

  it('either end makes it a chosen range; a named period beside it is refused, never silently preferred', () => {
    expect(resolveTillRange({ period: undefined, from: '2026-10-01', to: '2026-10-02', today: '2026-10-22' }))
      .toEqual({ period: 'custom', fromDate: '2026-10-01', toDate: '2026-10-02' });
    expect(resolveTillRange({ period: 'custom', from: '2026-10-01', to: '2026-10-02', today: '2026-10-22' }).period).toBe('custom');
    expect(() => resolveTillRange({ period: 'week', from: '2026-10-01', to: '2026-10-02', today: '2026-10-22' }))
      .toThrow(TillPeriodUnknownError);
    expect(problem(() => resolveTillRange({ period: undefined, to: '2026-10-02', today: '2026-10-22' }))).toBe('incomplete');
    expect(problem(() => resolveTillRange({ period: 'custom', today: '2026-10-22' }))).toBe('incomplete');
    expect(resolveTillRange({ period: undefined, today: '2026-10-22' })).toEqual({ period: 'day', fromDate: '2026-10-22', toDate: '2026-10-22' });
  });
});
