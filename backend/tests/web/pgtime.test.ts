import { describe, expect, it } from 'vitest';
import { parsePgTimestamp } from '../../../frontend/src/lib/pgtime.js';

/**
 * The parser for the server's own timestamps.
 *
 * This exists because `Date.parse('2026-09-01T14:56:42.009022+00')` is NaN, and
 * NaN cost a screen that told a waiter it was not holding a table it was holding:
 * `secondsRemaining > 0` is false for NaN, so the read-only branch won. The bug
 * was invisible in every server test -- the value was correct in the response --
 * and invisible in a client test that only asserted refusals, because the wrong
 * answer WAS a refusal.
 */
describe('parsing timestamptz::text as Postgres actually renders it', () => {
  it('accepts the exact shape the server sends', () => {
    // A space, six fractional digits, and a TWO-DIGIT offset. All three differ
    // from ISO 8601, and the last one is what Date.parse rejects.
    const parsed = parsePgTimestamp('2026-09-01 14:56:42.009022+00');
    expect(parsed).not.toBeNull();
    expect(new Date(parsed!).toISOString()).toBe('2026-09-01T14:56:42.009Z');
  });

  it('is what the naive replace gets wrong, so the test is not vacuous', () => {
    expect(Number.isNaN(Date.parse('2026-09-01 14:56:42.009022+00'.replace(' ', 'T'))))
      .toBe(true);
  });

  it('handles the offsets a non-UTC deployment would produce', () => {
    const cases: readonly [string, string][] = [
      ['2026-09-01 20:26:42+05:30', '2026-09-01T14:56:42.000Z'],
      ['2026-09-01 20:26:42+0530', '2026-09-01T14:56:42.000Z'],
      ['2026-09-01 09:56:42-05', '2026-09-01T14:56:42.000Z'],
      ['2026-09-01T14:56:42Z', '2026-09-01T14:56:42.000Z'],
    ];
    for (const [text, iso] of cases) {
      const parsed = parsePgTimestamp(text);
      expect(parsed, text).not.toBeNull();
      expect(new Date(parsed!).toISOString(), text).toBe(iso);
    }
  });

  it('treats a zoneless timestamp as UTC, never as tablet-local', () => {
    // A `timestamp` column instead of `timestamptz` is a server mistake the
    // client cannot fix -- but reading it as local time would make two tablets
    // in two timezones disagree about the same row, which is worse.
    expect(new Date(parsePgTimestamp('2026-09-01 14:56:42')!).toISOString())
      .toBe('2026-09-01T14:56:42.000Z');
  });

  it('returns null rather than NaN for anything it cannot read', () => {
    for (const bad of ['', 'tomorrow', '2026-13-45 99:99:99', 'null', '2026-09-01']) {
      expect(parsePgTimestamp(bad), bad).toBeNull();
    }
  });
});
