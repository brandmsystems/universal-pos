import { SUPERADMIN_SEGMENT } from '@katkitchen/shared';

/**
 * The control-plane console's two addresses, served by ONE document
 * (platform.html): Super Admin at `/superadmin/{section}`, every other platform
 * role at `/platform.html`. The address follows the signed-in role; it decides
 * nothing -- every screen's read is authorised by the server against the token.
 */
export const PLATFORM_ENTRY = '/platform.html';

const SECTION_SEGMENT = /^[a-z][a-z-]*$/;

/**
 * The section a `/superadmin` address names: '' for `/superadmin` itself, the
 * raw segment for `/superadmin/{section}`, null for any other address. Whether
 * the segment names a section is the shell's call.
 */
export function superadminSectionFromPath(pathname: string = window.location.pathname): string | null {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts[0] !== SUPERADMIN_SEGMENT || parts.length > 2) return null;
  const section = parts[1] ?? '';
  return section === '' || SECTION_SEGMENT.test(section) ? section : null;
}

export function superadminPath(section: string): string {
  return section === '' ? `/${SUPERADMIN_SEGMENT}` : `/${SUPERADMIN_SEGMENT}/${section}`;
}
