import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { RESERVED_SLUGS, SLUG_PATTERN, SUPERADMIN_SEGMENT } from '@universalpos/shared';

/**
 * The API is a separate origin in production and proxied in development, so the
 * client only ever knows relative paths. A hardcoded host in the client is the
 * thing that makes a build environment-specific.
 */
export default defineConfig({
  plugins: [
    react(),
    /**
     * `/{slug}` -> the restaurant app, in development as in production
     * (deploy/web.nginx.conf does the same). Without it the dev server's
     * fallback would serve the POS for `/abc-restaurant`.
     */
    {
      name: 'katkitchen-restaurant-slug',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const path = (req.url ?? '').split('?')[0] ?? '';
          // `/superadmin` and `/superadmin/{section}`: the control-plane
          // document. A reserved slug, so no restaurant rule below matches it.
          if (new RegExp(`^/${SUPERADMIN_SEGMENT}(?:/[a-z][a-z-]*)?/?$`).test(path)) {
            req.url = '/platform.html';
            next();
            return;
          }
          // Each restaurant's POS: `/{slug}/pos`, and the earlier `/{slug}/kot`
          // and `/{slug}/billing`, which open the same document, as in production.
          const tablet = /^\/([^/]+)\/(pos|kot|billing)\/?$/.exec(path);
          if (tablet && SLUG_PATTERN.test(tablet[1]!) && !RESERVED_SLUGS.has(tablet[1]!)) {
            req.url = '/index.html';
            next();
            return;
          }
          // `/{slug}` and a restaurant admin screen, `/{slug}/{section}`.
          const admin = /^\/([^/]+)(?:\/[a-z][a-z-]*)?\/?$/.exec(path);
          if (admin && SLUG_PATTERN.test(admin[1]!) && !RESERVED_SLUGS.has(admin[1]!)) {
            req.url = '/admin.html';
          }
          next();
        });
      },
    },
    /**
     * Scoped by CSS import, not by plugin config: this plugin scans the whole
     * project for class-name candidates, but it only emits a stylesheet where
     * one imports `tailwindcss` -- each of the four shells in `src/app/<app>/`
     * imports its OWN sheet from `src/styles/<app>.css` with its own theme
     * values, so one plugin instance serves four visually distinct apps.
     * Vite's own per-entry code splitting is what keeps each one's CSS out of
     * the other documents' output, the same way JS is kept apart.
     */
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // shadcn's generated components import from '@/lib/utils' etc. by
      // convention -- this is that alias, scoped to `web/src`.
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    // A collision must FAIL, not walk to the next port. Vite's default is to
    // port-walk, which is how a browser tab pointed at 5173 quietly showed a
    // different project's dev server and three rounds of debugging blamed the
    // cache.
    strictPort: true,
    proxy: {
      // ####################################################################
      // 127.0.0.1 AND NOT `localhost`, WHICH IS NOT THE SAME ADDRESS.
      //
      // `localhost` resolves to ::1 before 127.0.0.1 on Windows. Docker
      // Compose publishes the api service on BOTH 0.0.0.0:8080 and [::]:8080,
      // and a `pnpm dev:api` started alongside it binds 127.0.0.1:8080
      // successfully -- Windows permits the specific bind over the wildcard
      // one rather than refusing it.
      //
      // So both servers run, both look healthy, and which one answers depends
      // on how the client spells the host. Through `localhost` the proxy
      // reached the CONTAINER -- an older image with no control-plane login --
      // so POST /api/auth/platform/login fell through to
      // /api/auth/:tenantSlug/login and refused with `tenant_unknown`, while a
      // curl to 127.0.0.1 on the same port returned a token. Hours of it
      // looking like a password problem.
      //
      // Same family as the POS port note below, and worse: that collision
      // serves the wrong app, this one serves the wrong VERSION of the right
      // app, which is far harder to see.
      // ####################################################################
      '/api': { target: process.env.API_ORIGIN ?? 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
  /**
   * Three entry points, one build.
   *
   * The KDS is a separate DOCUMENT rather than a route inside the POS, and that
   * is a decision rather than a convenience: a kitchen screen is a different
   * device, a different posture (nobody signs in and out of it mid-service, and
   * nobody taps it with wet hands more than once), and it must not ship the POS's
   * money code to a screen bolted above a tandoor. Separate documents also mean
   * a POS bug cannot take the kitchen display down with it.
   */
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        pos: resolve(import.meta.dirname, 'index.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
        // A fourth document, not a route inside admin. A branch admin is a
        // restaurant's employee and must not be shipped the code that lists
        // every tenant, changes plans and starts impersonation sessions.
        // Enforced at the bundle by tests/web/bundleSeparation.test.ts, because
        // a dynamic import or a hoisted chunk defeats an import-graph rule while
        // shipping the code anyway.
        platform: resolve(import.meta.dirname, 'platform.html'),
      },
    },
  },
});
