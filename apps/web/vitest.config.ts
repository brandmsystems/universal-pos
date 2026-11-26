import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * ###########################################################################
 * THE CLIENT SUITE IS SEPARATE FROM THE ROOT SUITE, DELIBERATELY.
 *
 * The root config runs in Node against a real Postgres, and runs
 * `tests/hooks/defaultPartitionEmpty.ts` after every file. A render test wants
 * neither: it needs a DOM, and it has no business opening a database
 * connection to assert that an audit partition is empty.
 *
 * `web/package.json` has declared `"test": "vitest run"` since the workspace
 * was created, with no config and no test files -- a script joined to the
 * running system by nothing, which is the defect family CLAUDE.md names as this
 * codebase's default failure mode. This gives it something to run.
 * ###########################################################################
 */
/**
 * Windows only: a working directory spelled `c:\...` (VS Code and Git Bash hand
 * one over) gives Vite `c:\` paths while Node resolves react-dom's own `react` to
 * `C:\`, and Node's module cache keys the two apart -- two Reacts, and every
 * render test fails on a null hook dispatcher. The drive is spelled the way
 * Windows spells it before anything resolves. Elsewhere nothing changes.
 * Asserted by tests/reactSingleInstance.test.ts.
 */
if (process.platform === 'win32') process.chdir(realpathSync.native(process.cwd()));

export default defineConfig({
  /**
   * No `@vitejs/plugin-react`. It is typed against the workspace's vite 6 while
   * `vitest/config` carries vite 7, and the two Plugin types are not assignable
   * under `exactOptionalPropertyTypes` -- the same workspace-layout seam the
   * root config hit with `loadEnv`. Nothing here needs it: the plugin exists for
   * Fast Refresh, and vite's own esbuild compiles .tsx from the `jsx` setting in
   * tsconfig.json.
   */
  // The app's own '@' alias (vite.config.ts), so a test can render a component
  // that imports shadcn's generated pieces the way the app does.
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  test: {
    // jsdom rather than happy-dom: the components read `getComputedStyle` and
    // inline styles through the real CSSOM, and the gate's whole job is to
    // compare what is drawn.
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    // React 19 refuses `act` outside a declared act environment, and the
    // failure names neither the flag nor the file. Set once, here.
    setupFiles: ['./tests/setup.ts'],
  },
});
