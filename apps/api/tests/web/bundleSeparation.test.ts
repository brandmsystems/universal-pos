import { describe, expect, it } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * The till, the manager screens and the control-plane console are separate
 * documents, and this proves it.
 *
 * ###########################################################################
 * A DOCUMENT SHIPS ONLY WHAT ITS SCREEN USES.
 *
 * Blast radius: a bug in admin code loaded on the till, or the control plane's
 * whole surface handed to every restaurant, is shipped whether or not a route
 * reaches it. (The kitchen screen and the separate KOT and Billing documents
 * were removed in 0077; Basic has ONE POS document, `index.html` -> `pos-*`.)
 *
 * This is enforced by reading the BUILT bundles, not by reading the imports: a
 * dynamic import, a re-export through a barrel file, or a bundler decision to
 * hoist a shared chunk would all defeat an import-graph check while shipping the
 * code anyway. The build output is the only thing that knows what actually ships.
 *
 * And "a bundle" is the entry chunk PLUS every chunk it loads, followed through
 * the built `import` statements. This file used to read only the files whose
 * NAMES began with the app's -- so when the bundler hoisted the Billing workspace
 * into a shared `Desk-*.js`, the KOT app shipped it and every assertion here
 * stayed green. A gate that reads a chunk's name instead of what it loads is the
 * hoisted-chunk hole this comment says the gate exists to close.
 *
 * It read a STALE build for a while too: after 0077 removed the kitchen and the
 * separate Billing documents, their old chunks sat in a dist nobody rebuilt, and
 * every assertion about them kept passing against code that no longer existed.
 * The `has a build` test below now also refuses a dist holding an entry for a
 * document the app no longer has.
 *
 * It is skipped when `web/dist` is absent -- this asserts a property of a build,
 * and a test that silently passes without one would be worse than no test.
 * ###########################################################################
 */

const DIST = path.resolve(import.meta.dirname, '../../../web/dist/assets');

/** The documents the web app builds, by entry-chunk prefix. Anything else in dist is stale. */
const DOCUMENTS = ['pos', 'admin', 'platform'] as const;

/**
 * Strings that appear only on the till: taking the order and the money. Each
 * must be distinctive enough not to collide -- 'Take it' was here once and
 * matched admin's "Yes, take it out", and a false positive in a gate like this
 * is as bad as a false negative: it teaches whoever hits it that the check is noise.
 */
const POS_MARKERS: readonly string[] = [
  'Add payment',
  'Complete payment',
  'Confirm order',
];

/**
 * Strings that appear only in the manager screens. Headings and button labels,
 * never prose: prose describing what is unbuilt is reworded every time something
 * gets built, which made earlier markers here go stale three times.
 */
const ADMIN_MARKERS: readonly string[] = [
  'Take out of use',
  'Bill printer',
  'Print a test page',
];

/**
 * Strings that appear only in the CONTROL PLANE console.
 *
 * ###########################################################################
 * A BRANCH ADMIN IS A RESTAURANT'S EMPLOYEE.
 *
 * The blast-radius argument above, one plane further out. Shipping the tenant
 * admin the code that lists every restaurant, changes plans and starts
 * impersonation sessions would put the control plane's whole surface area in a
 * document handed to every customer -- readable, and a map of what to attack.
 * ###########################################################################
 */
const PLATFORM_MARKERS: readonly string[] = [
  'Katkitchen control plane',
  // Button labels, not prose: an action a Super Admin clicks does not get
  // reworded with the page around it.
  'Add sales person',
  'New setup link',
];

/**
 * Everything an app SHIPS: its entry chunk and, transitively, every chunk it
 * imports -- static `from"./x.js"` and dynamic `import("./x.js")` alike.
 */
async function chunks(prefix: string): Promise<string[]> {
  const names = await readdir(DIST);
  const entry = names.filter((n) => n.startsWith(`${prefix}-`) && n.endsWith('.js'));
  if (entry.length !== 1) throw new Error(`expected one ${prefix} entry chunk, found ${entry.length}`);
  const seen = new Map<string, string>();
  const queue = [...entry];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    const text = await readFile(path.join(DIST, name), 'utf8');
    seen.set(name, text);
    for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)["']\.\/([^"']+\.js)["']/g)) queue.push(match[1]!);
  }
  return [...seen.values()];
}

async function built(): Promise<boolean> {
  try { return (await stat(DIST)).isDirectory(); } catch { return false; }
}

const bundle = async (prefix: (typeof DOCUMENTS)[number]): Promise<string> => (await chunks(prefix)).join('\n');

describe('the clients are separate documents', () => {
  it('has a build to inspect, of the documents the app has now', async () => {
    // Not a skip: if this fails, run `pnpm --filter web build` before trusting
    // the rest of this file.
    expect(await built(), `run the web build first; ${DIST} is missing`).toBe(true);
    const html = await readdir(path.dirname(DIST));
    expect(html.filter((n) => n.endsWith('.html')).sort()).toEqual(['admin.html', 'index.html', 'platform.html']);
    for (const document of DOCUMENTS) {
      expect((await readdir(DIST)).filter((n) => n.startsWith(`${document}-`) && n.endsWith('.js')), `${document} entry`).toHaveLength(1);
    }
    for (const stale of ['kds', 'billing', 'kot']) {
      expect((await readdir(DIST)).some((n) => n.startsWith(`${stale}-`) && n.endsWith('.js')), `a stale ${stale} entry in dist`)
        .toBe(false);
    }
  });

  it('keeps the manager screens and the control plane off the till', async () => {
    if (!await built()) return;
    const pos = await bundle('pos');
    expect(ADMIN_MARKERS.filter((m) => pos.includes(m)), 'admin reached the POS bundle').toEqual([]);
    expect(PLATFORM_MARKERS.filter((m) => pos.includes(m)), 'the control plane reached the POS bundle').toEqual([]);
  });

  it('keeps the till and the control plane out of the manager screens', async () => {
    if (!await built()) return;
    const admin = await bundle('admin');
    expect(POS_MARKERS.filter((m) => admin.includes(m)), 'the till reached the admin bundle').toEqual([]);
    expect(
      PLATFORM_MARKERS.filter((m) => admin.includes(m)),
      'the control-plane console reached a tenant-facing document. Something the platform app uses '
        + '(app/platform or a features/*/platform module) is imported from it, or a shared chunk pulled it in.',
    ).toEqual([]);
  });

  it('keeps the tenant planes out of the control-plane bundle', async () => {
    if (!await built()) return;
    // The other direction, and it is not symmetric decoration: a control-plane
    // screen importing a tenant-scoped component is how a console ends up
    // rendering one restaurant's data while claiming to show the estate.
    const platform = await bundle('platform');
    expect(POS_MARKERS.filter((m) => platform.includes(m))).toEqual([]);
    expect(ADMIN_MARKERS.filter((m) => platform.includes(m))).toEqual([]);
  });

  it('proves the markers are real, so the check is not vacuous', async () => {
    if (!await built()) return;
    // Each marker must be present in its OWN bundle. A typo in a marker would
    // otherwise make every assertion above pass forever.
    const own: readonly [(typeof DOCUMENTS)[number], readonly string[]][] =
      [['pos', POS_MARKERS], ['admin', ADMIN_MARKERS], ['platform', PLATFORM_MARKERS]];
    for (const [prefix, markers] of own) {
      const text = await bundle(prefix);
      expect(text.length).toBeGreaterThan(1_000);
      for (const marker of markers) expect(text.includes(marker), `${marker} is missing from the ${prefix} bundle`).toBe(true);
    }
  });
});
