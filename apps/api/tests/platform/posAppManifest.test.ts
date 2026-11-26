import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { imageSize } from '../../src/modules/platform/branding.js';
import { UNIVERSALPOS_APP_ICONS, buildPosAppManifest } from '../../src/modules/platform/posApp.js';

/**
 * The installable POS app's manifest (pure parts). The HTTP route, per slug and
 * across restaurants, is in tests/http/staffAndBranding.test.ts.
 */

const b64 = (text: string): Buffer => Buffer.from(text, 'base64');

/** Real files made by Pillow, cut just past the header that holds the size. */
const JPEG_BASELINE_200x180 = b64('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAC0AMgDAQ==');
const JPEG_PROGRESSIVE_640 = b64('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wgARCAKAAoADAQ==');
const WEBP_LOSSY_256 = b64('UklGRswAAABXRUJQVlA4IMAAAACwEQCdASoAAQABPxE=');
const WEBP_LOSSLESS_300x120 = b64('UklGRiQAAABXRUJQVlA4TBgAAAAvK8EdAAdQrupH/wM=');
const WEBP_EXTENDED_512 = b64('UklGRnACAABXRUJQVlA4WAoAAAAQAAAA/wEA/wEAQUw=');

/** A PNG's signature and IHDR: all `imageSize` reads. */
function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), length, Buffer.from('IHDR'), ihdr, Buffer.alloc(4)]);
}

describe('imageSize reads a stored logo header', () => {
  it.each([
    ['image/png', pngHeader(512, 512), { width: 512, height: 512 }],
    ['image/png', pngHeader(400, 200), { width: 400, height: 200 }],
    ['image/jpeg', JPEG_BASELINE_200x180, { width: 200, height: 180 }],
    ['image/jpeg', JPEG_PROGRESSIVE_640, { width: 640, height: 640 }],
    ['image/webp', WEBP_LOSSY_256, { width: 256, height: 256 }],
    ['image/webp', WEBP_LOSSLESS_300x120, { width: 300, height: 120 }],
    ['image/webp', WEBP_EXTENDED_512, { width: 512, height: 512 }],
  ] as const)('%s → %o', (type, bytes, size) => {
    expect(imageSize(type, bytes)).toEqual(size);
  });

  it('answers null for a header it cannot read, never a guessed size', () => {
    expect(imageSize('image/png', pngHeader(10, 10).subarray(0, 20))).toBeNull();
    expect(imageSize('image/jpeg', JPEG_BASELINE_200x180.subarray(0, 40))).toBeNull();
    expect(imageSize('image/jpeg', Buffer.from([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(imageSize('image/webp', WEBP_LOSSY_256.subarray(0, 20))).toBeNull();
    expect(imageSize('image/gif', pngHeader(10, 10))).toBeNull();
  });
});

describe('buildPosAppManifest', () => {
  const kfc = { slug: 'kfc', name: 'KFC', themeColor: null };

  it('opens the restaurant POS and nothing else: start_url, scope and id are /{slug}/pos', () => {
    const manifest = buildPosAppManifest(kfc, null);
    expect(manifest).toMatchObject({
      id: '/kfc/pos', start_url: '/kfc/pos', scope: '/kfc/pos', display: 'standalone',
      name: 'KFC POS', short_name: 'KFC', theme_color: '#FA5C00', background_color: '#F7F7F7',
    });
    expect(manifest.icons).toEqual(UNIVERSALPOS_APP_ICONS);
  });

  it('two restaurants are two apps: no shared id, start_url or scope', () => {
    const a = buildPosAppManifest(kfc, null);
    const b = buildPosAppManifest({ slug: 'paragon', name: 'Paragon', themeColor: '#1d4ed8' }, null);
    expect(new Set([a.id, b.id]).size).toBe(2);
    expect(b).toMatchObject({ id: '/paragon/pos', start_url: '/paragon/pos', scope: '/paragon/pos', theme_color: '#1d4ed8' });
  });

  it.each(['image/png', 'image/webp'])('uses a %s logo as the only icon when it is square and big enough for a launcher', (type) => {
    const logo = { url: '/api/public/restaurants/kfc/logo?v=abc', contentType: type, width: 512, height: 512 };
    expect(buildPosAppManifest(kfc, logo).icons).toEqual([
      { src: logo.url, sizes: '512x512', type, purpose: 'any' },
    ]);
  });

  it.each([
    ['not square', 'image/png', 400, 200],
    ['too small', 'image/png', 128, 128],
    // Chrome refuses to install with a JPEG icon, however big and square.
    ['a JPEG', 'image/jpeg', 1254, 1254],
  ])('keeps the UniversalPOS icons when the logo is %s', (_why, type, width, height) => {
    const logo = { url: '/api/public/restaurants/kfc/logo?v=abc', contentType: type, width, height };
    expect(buildPosAppManifest(kfc, logo).icons).toEqual(UNIVERSALPOS_APP_ICONS);
  });

  it('UniversalPOS icons cover what Android and Chrome need: 192 and 512, and a maskable one', () => {
    expect(UNIVERSALPOS_APP_ICONS.map((i) => `${i.sizes}/${i.purpose}`)).toEqual(['192x192/any', '512x512/any', '512x512/maskable']);
  });

  it('every UniversalPOS icon the manifest names is a file the web build serves, at the size it declares', () => {
    for (const icon of UNIVERSALPOS_APP_ICONS) {
      const bytes = readFileSync(resolve(import.meta.dirname, '../../../web/public', `.${icon.src}`));
      const size = imageSize('image/png', bytes);
      expect(size === null ? null : `${size.width}x${size.height}`, icon.src).toBe(icon.sizes);
    }
  });
});
