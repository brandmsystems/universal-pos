import { createHash } from 'node:crypto';
import {
  ADDRESS_MAX_LENGTH, ADDRESS_MIN_LENGTH, LOGO_MAX_BYTES, LOGO_TYPES, normaliseThemeColor,
  type LogoType,
} from '@universalpos/shared';

/**
 * Validation for a restaurant's address, theme colour and logo. Pure: no SQL,
 * so provisioning, the edit and the logo upload all apply the same rules.
 */

export class BrandingInvalidError extends Error {
  readonly statusCode = 400;
  readonly code = 'branding_invalid';
  constructor(detail: string) {
    super(detail);
    this.name = 'BrandingInvalidError';
  }
}

/** Undefined means "not sent"; null or blank means "clear it". The same rule for both brand colours. */
export function themeColorOf(value: unknown, field = 'themeColor'): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const colour = typeof value === 'string' ? normaliseThemeColor(value) : null;
  if (colour === null) throw new BrandingInvalidError(`${field} must be a hex colour like #fa5c00.`);
  return colour;
}

export function addressOf(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < ADDRESS_MIN_LENGTH || text.length > ADDRESS_MAX_LENGTH) {
    throw new BrandingInvalidError(
      `address must be ${ADDRESS_MIN_LENGTH} to ${ADDRESS_MAX_LENGTH} characters.`);
  }
  return text;
}

/**
 * The file's first bytes, not the declared type, decide what it is. A renamed
 * HTML file sent as image/png would otherwise be stored and later served from
 * our own origin.
 */
function sniff(bytes: Buffer): LogoType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export interface CheckedLogo {
  readonly contentType: LogoType;
  readonly bytes: Buffer;
  readonly sha256: Buffer;
}

export function checkedLogo(input: { contentType?: unknown; dataBase64?: unknown }): CheckedLogo {
  if (typeof input.contentType !== 'string'
    || !(LOGO_TYPES as readonly string[]).includes(input.contentType)) {
    throw new BrandingInvalidError('the logo must be a PNG, JPEG or WebP image.');
  }
  if (typeof input.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.dataBase64)) {
    throw new BrandingInvalidError('dataBase64 must be the image, base64-encoded.');
  }
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (bytes.length === 0) throw new BrandingInvalidError('the logo file is empty.');
  if (bytes.length > LOGO_MAX_BYTES) {
    throw new BrandingInvalidError(`the logo must be at most ${LOGO_MAX_BYTES / 1024} KB.`);
  }
  const actual = sniff(bytes);
  if (actual !== input.contentType) {
    throw new BrandingInvalidError(
      actual === null
        ? 'the file is not a PNG, JPEG or WebP image.'
        : `the file is a ${actual.slice(6).toUpperCase()}, not ${input.contentType.slice(6).toUpperCase()}.`);
  }
  return { contentType: actual, bytes, sha256: createHash('sha256').update(bytes).digest() };
}

/**
 * A stored logo's pixel size, read from its header (the bytes were sniffed on
 * upload, so the type is known). Null when the header cannot be read: the caller
 * then treats the logo as unusable rather than guessing a size.
 */
export function imageSize(contentType: string, bytes: Buffer): { width: number; height: number } | null {
  if (contentType === 'image/png') {
    // IHDR is the first chunk: width and height, big-endian, at bytes 16 and 20.
    return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
  }
  if (contentType === 'image/jpeg') {
    // Walk the segments to the first start-of-frame (SOF0-SOF15, but not DHT,
    // JPG or DAC, which share the range): height then width, big-endian.
    let at = 2;
    while (at + 9 <= bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker === 0xff) { at += 1; continue; }
      const length = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
      }
      at += 2 + length;
    }
    return null;
  }
  if (contentType === 'image/webp' && bytes.length >= 30) {
    const chunk = bytes.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    if (chunk === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** Versioned by content, so a replaced logo is never served from a stale cache. */
export function logoUrl(slug: string, sha256: Buffer | null): string | null {
  return sha256 === null ? null
    : `/api/public/restaurants/${slug}/logo?v=${sha256.subarray(0, 6).toString('hex')}`;
}
