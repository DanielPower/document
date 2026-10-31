// Docket's service worker. Docket needs its server for everything, so nothing is
// cached for offline use. It only shows a "can't reach Docket" page when a page
// load fails or is refused, e.g. on mobile data without Tailscale, instead of an error page.
const CACHE = "docket-offline-v1";
const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add(new Request(OFFLINE, { cache: "reload" }))));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  // Only page loads; API calls, files and assets go straight to the network.
  if (event.request.mode !== "navigate") return;
  // From outside the home network, Traefik's IP allowlist answers 403. Docket never does for a page.
  event.respondWith(
    fetch(event.request)
      .then((res) => (res.status === 403 ? caches.match(OFFLINE).then((o) => o ?? res) : res))
      .catch(() => caches.match(OFFLINE)),
  );
});
