/* global self, caches -- a service worker's own globals */
/*
 * UniversalPOS POS service worker: what makes /{slug}/pos an installable app.
 *
 * It caches NOTHING. The POS's pages are re-checked on every load (nginx sends
 * no-cache) and its bundle files are content-hashed, so a deploy reaches an
 * installed app on its next launch, exactly as it reaches a browser tab. The
 * API -- sessions, orders, bills, staff -- never passes through here: only page
 * navigations are answered, and only to say there is no connection.
 *
 * Registered by services/posApp.ts with the restaurant's own POS as its scope.
 */

const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>No connection · UniversalPOS POS</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #F7F7F7; color: #111111; font-family: system-ui, -apple-system, sans-serif; }
  main { max-width: 360px; margin: 24px; padding: 28px; border: 1px solid #E2E2E2; border-radius: 20px;
         background: #FFFFFF; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { font-size: 15px; line-height: 1.5; color: #6B6B6B; margin: 0 0 20px; }
  button { width: 100%; height: 48px; border: 0; border-radius: 14px; font-size: 16px; font-weight: 700;
           background: linear-gradient(180deg, #F9A008, #FA5C00); color: #000000; }
</style></head>
<body><main>
  <h1>No connection</h1>
  <p>The POS needs the internet to open. Check the Wi-Fi or mobile data, then try again.</p>
  <button type="button" onclick="location.reload()">Try again</button>
</main></body></html>`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Nothing is ever cached here; clear anything a browser kept for this origin's worker.
    for (const key of await caches.keys()) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  // Everything but opening a page -- the API, scripts, logos -- goes to the
  // network untouched, exactly as without a worker.
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE_PAGE, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })));
});
