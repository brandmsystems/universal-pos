/**
 * Payload preparation for an audit row.
 *
 * Order matters: redact first, then measure. Measuring first would let a secret
 * count towards the cap, and truncating first could leave half a hash in the row.
 */

export const PAYLOAD_LIMIT_BYTES = 64 * 1024;

/**
 * Never written to an audit row, at any size. Matching is on the key name, so a
 * new secret column is covered the moment it follows the convention.
 */
const REDACTED_KEYS = /(password|secret|token|pin)(_hash|_lookup)?$/i;

export const REDACTED = '[redacted]';

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.test(key) ? REDACTED : redact(inner);
  }
  return out;
}

export interface PreparedSide {
  readonly value: unknown;
  readonly truncated: boolean;
}

/**
 * Each side is capped independently, so a large `after` does not discard a small
 * `before` that would still have been useful.
 *
 * A truncated side keeps its keys, because knowing *which* fields changed is most
 * of the value even when the values are gone.
 */
export function prepareSide(input: unknown): PreparedSide {
  if (input === null || input === undefined) return { value: null, truncated: false };

  const cleaned = redact(input);
  const serialised = JSON.stringify(cleaned) ?? 'null';

  if (Buffer.byteLength(serialised, 'utf8') <= PAYLOAD_LIMIT_BYTES) {
    return { value: cleaned, truncated: false };
  }

  const keys =
    cleaned !== null && typeof cleaned === 'object' && !Array.isArray(cleaned)
      ? Object.keys(cleaned)
      : [];

  return {
    value: { _truncated: true, byte_length: Buffer.byteLength(serialised, 'utf8'), keys },
    truncated: true,
  };
}

export interface PreparedPayload {
  readonly before: unknown;
  readonly after: unknown;
  readonly truncated: boolean;
}

export function preparePayload(before: unknown, after: unknown): PreparedPayload {
  const a = prepareSide(before);
  const b = prepareSide(after);
  return { before: a.value, after: b.value, truncated: a.truncated || b.truncated };
}
