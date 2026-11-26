/**
 * A restaurant's look: theme colour and logo. Checked in the browser for an
 * immediate answer and again on the server, which is the authority.
 */

export const THEME_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** `#FA5C00`, `fa5c00` or `#fa5c00` to `#fa5c00`; anything else to null. */
export function normaliseThemeColor(value: string): string | null {
  const hex = value.trim().toLowerCase().replace(/^#?/, '#');
  return THEME_COLOR_PATTERN.test(hex) ? hex : null;
}

/** Black or white, whichever reads better on the colour (WCAG relative luminance). */
export function readableOn(themeColor: string): '#000000' | '#ffffff' {
  const channel = (i: number): number => {
    const c = parseInt(themeColor.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return luminance > 0.179 ? '#000000' : '#ffffff';
}

export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoType = (typeof LOGO_TYPES)[number];
export const LOGO_MAX_BYTES = 256 * 1024;

export const ADDRESS_MIN_LENGTH = 5;
export const ADDRESS_MAX_LENGTH = 500;
