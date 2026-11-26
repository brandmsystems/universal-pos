import { useEffect } from 'react';
import {
  businessTypeOf, sectionTitle, type AdminSectionKey, type BusinessTypeDefinition,
} from '@universalpos/shared';

/**
 * How a screen takes its words, its navigation and its look from the business
 * type. The registry (shared `BUSINESS_TYPES`) is the only place a type is
 * described; nothing here, and no screen, branches on a type's name.
 */

/**
 * The sections a business shows, in its own order. `sections` is the screen's
 * full list (each names its address segment in `path`); a type's `nav` can only
 * pick from it. A section the type does not list is not offered at all.
 */
export function visibleSections<T extends { readonly path: string }>(
  sections: readonly T[], type: BusinessTypeDefinition,
): readonly T[] {
  const byPath = new Map(sections.map((section) => [section.path, section] as const));
  return type.nav.flatMap((key) => {
    const section = byPath.get(key);
    return section === undefined ? [] : [section];
  });
}

/** A section's title in this business's words, falling back to the screen's own. */
export function titleFor(type: BusinessTypeDefinition, section: { readonly path: string; readonly title: string }): string {
  return sectionTitle(type, section.path as AdminSectionKey, section.title);
}

/**
 * Applies a type's look to the document: `data-business-theme` (a hook for
 * per-type styling) and `data-radius` (read by styles/business-themes.css).
 * The accent colour is not written here: it goes through `useThemeColor`, so a
 * colour the business chose itself always wins over its type's default.
 */
export function applyBusinessTheme(type: BusinessTypeDefinition | null): void {
  const root = document.documentElement;
  if (type === null) {
    delete root.dataset['businessTheme'];
    delete root.dataset['radius'];
    return;
  }
  root.dataset['businessTheme'] = type.theme.id;
  if (type.theme.radius === 'soft') delete root.dataset['radius'];
  else root.dataset['radius'] = type.theme.radius;
}

/** The accent to use: the business's own colour, else its type's default (null = the product's). */
export function accentFor(own: string | null, type: BusinessTypeDefinition): string | null {
  return own ?? type.theme.primary;
}

/** The registry entry for a type key as an API sent it; an older API sends none, which is a restaurant. */
export function useBusinessType(key: string | null | undefined): BusinessTypeDefinition {
  const type = businessTypeOf(key);
  useEffect(() => {
    applyBusinessTheme(type);
    return () => applyBusinessTheme(null);
  }, [type]);
  return type;
}
