import { useEffect } from 'react';
import { THEME_COLOR_PATTERN, readableOn } from '@katkitchen/shared';

/**
 * A restaurant's own colour on its own screens: admin, POS and KDS.
 *
 * Every button, focus ring and highlight reads `--color-primary` (Tailwind's
 * theme variable), so setting it on the document root re-colours the whole app
 * without touching a component. `--primary` is set as well for anything written
 * against the plain name. The foreground is chosen for contrast, so a pale brand
 * colour still gets legible button text. Only a validated `#rrggbb` is ever
 * written into a style. Tints mix toward the surface: white on the light apps,
 * black on the kitchen screen's dark one.
 */
const PROPERTIES = [
  '--primary', '--color-primary', '--color-ring', '--color-ink-orange',
  '--color-primary-foreground', '--brand-gradient-from', '--color-accent', '--color-brand-secondary',
] as const;

export type Surface = 'light' | 'dark';

/**
 * `secondary`, when the restaurant set one, is its tinted surfaces (`--color-accent`:
 * bands, card accents, glows) in place of a tint of the primary. Buttons, rings and
 * filled marks stay the primary. Ignored without a primary: a lone second colour
 * has nothing to pair with.
 */
export function applyThemeColor(themeColor: string | null, surface: Surface = 'light', secondary: string | null = null): void {
  const root = document.documentElement.style;
  if (themeColor === null || !THEME_COLOR_PATTERN.test(themeColor)) {
    for (const property of PROPERTIES) root.removeProperty(property);
    return;
  }
  const toward = surface === 'light' ? 'white' : 'black';
  root.setProperty('--primary', themeColor);
  root.setProperty('--color-primary', themeColor);
  root.setProperty('--color-ring', themeColor);
  root.setProperty('--color-ink-orange', `color-mix(in srgb, ${themeColor} 75%, black)`);
  root.setProperty('--color-primary-foreground', readableOn(themeColor));
  root.setProperty('--brand-gradient-from', `color-mix(in srgb, ${themeColor} 70%, white)`);
  const second = secondary !== null && THEME_COLOR_PATTERN.test(secondary) ? secondary : null;
  root.setProperty('--color-accent', second !== null
    ? `color-mix(in srgb, ${second} ${surface === 'light' ? 22 : 30}%, ${toward})`
    : `color-mix(in srgb, ${themeColor} ${surface === 'light' ? 10 : 22}%, ${toward})`);
  if (second !== null) root.setProperty('--color-brand-secondary', second);
  else root.removeProperty('--color-brand-secondary');
}

export function useThemeColor(themeColor: string | null, surface: Surface = 'light', secondary: string | null = null): void {
  useEffect(() => {
    applyThemeColor(themeColor, surface, secondary);
    return () => applyThemeColor(null);
  }, [themeColor, surface, secondary]);
}
