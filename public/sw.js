/* Free Retro service worker: offline app shell + graceful API offline handling. */
const VERSION = "v2";
const SHELL = `free-retro-${VERSION}`;
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/fonts/caveat-600.woff2",
  "/fonts/patrick-hand-400.woff2",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // API: network-first; when offline, answer with a JSON 503 the app already handles
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request).catch(
        () =>
          new Response(JSON.stringify({ error: "offline" }), {
            status: 503,
            headers: { "content-type": "application/json; charset=utf-8" },
          })
      )
    );
    return;
  }

  // static app shell: serve from cache, refresh in the background
  event.respondWith(
    caches.match(event.request).then((hit) => {
      const refresh = fetch(event.request)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((cache) => cache.put(event.request, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});
