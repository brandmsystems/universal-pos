/**
 * Parsing the server's own timestamps.
 *
 * ###########################################################################
 * `timestamptz::text` IS NOT ISO 8601, AND Date.parse SILENTLY RETURNS NaN.
 *
 * Postgres renders `2026-09-01 14:56:42.009022+00`: a space instead of `T`, six
 * fractional digits, and a TWO-DIGIT offset. `Date.parse` needs `T` and an
 * offset of `+00:00` or `Z`, so the naive `.replace(' ', 'T')` produces NaN --
 * which does not throw, does not warn, and propagates as a number.
 *
 * It cost a lease countdown that rendered `NaNm NaNs` and, worse, a screen that
 * declared itself read-only: `secondsRemaining > 0` is FALSE for NaN, so the
 * order pane told the waiter the tablet was not holding a table it was holding.
 * A comparison against NaN fails closed, which is the safe direction and
 * therefore the direction nobody notices in a test that only checks refusals.
 *
 * So there is one parser, it is total, and it returns null rather than NaN --
 * because null is a value the type system makes you handle.
 * ###########################################################################
 */

const SHAPE =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*([+-]\d{2}(?::?\d{2})?|Z)?$/;

export function parsePgTimestamp(text: string): number | null {
  const match = SHAPE.exec(text.trim());
  if (!match) return null;
  const [, date, time, zoneRaw] = match;

  // No zone at all means the column was `timestamp` rather than `timestamptz`,
  // which is a server-side mistake this client cannot correct -- treated as UTC
  // and NOT as local time, because local would differ per tablet.
  const zone = zoneRaw === undefined || zoneRaw === 'Z'
    ? 'Z'
    : zoneRaw.length === 3 ? `${zoneRaw}:00`
      : zoneRaw.length === 5 ? `${zoneRaw.slice(0, 3)}:${zoneRaw.slice(3)}`
        : zoneRaw;

  const parsed = Date.parse(`${date}T${time}${zone}`);
  return Number.isFinite(parsed) ? parsed : null;
}
