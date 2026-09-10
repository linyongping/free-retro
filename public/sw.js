/* Free Retro service worker: offline app shell + graceful API offline handling. */
const VERSION = "v5";
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

// Code and markup change on every deploy. Serving these cache-first means the
// first visit after a release always runs the previous build, so they go to the
// network first and only fall back to the cache when offline.
const NETWORK_FIRST = new Set(["/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest"]);

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

  const cacheIt = (res) => {
    // Clone before handing the response to the page: once the page has read the
    // body, res.clone() throws and the cache silently stops updating.
    if (res.ok) {
      const copy = res.clone();
      caches.open(SHELL).then((cache) => cache.put(event.request, copy)).catch(() => {});
    }
    return res;
  };

  if (NETWORK_FIRST.has(url.pathname)) {
    event.respondWith(
      fetch(event.request)
        .then(cacheIt)
        .catch(async () => (await caches.match(event.request)) || Response.error())
    );
    return;
  }

  // fonts and icons are immutable for a given filename, so the cache is safe
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request).then(cacheIt).catch(() => Response.error()))
  );
});
