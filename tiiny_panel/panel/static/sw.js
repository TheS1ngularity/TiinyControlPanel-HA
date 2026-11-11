/* Service worker for the installed app. It caches nothing (the page gets a fresh session token on every
   start); it only shows a friendly page when the panel's server isn't running. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;  // everything else goes straight to the network
  event.respondWith(fetch(req).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tiiny Control Panel</title>' +
    '<body style="font:16px/1.5 system-ui,sans-serif;max-width:34em;margin:12vh auto;padding:0 20px;color:#1f2330">' +
    '<h1 style="font-size:22px">The Tiiny Control Panel isn’t running</h1>' +
    '<p>Start it on this computer with <code>python3 tiiny_ui.py</code> (or from your app menu), then reload this window.</p></body>',
    {status: 503, headers: {'Content-Type': 'text/html; charset=utf-8'}})));
});
