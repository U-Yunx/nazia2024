/* ANA24 service worker.
 *
 * Purpose: make ana24.app installable as a PWA and packageable by Android APK
 * wrapper builders (aiapkstudio.com and friends), while staying conservative:
 *
 *  - navigations  -> network-first (the trading app must never show a stale
 *                    shell), falling back to the cached shell when offline
 *  - /assets/*    -> cache-first (Vite emits content-hashed, immutable files)
 *  - cross-origin -> never touched (Supabase REST/Realtime, market data)
 *
 * Bump CACHE_VERSION when the caching strategy changes; old caches are purged
 * on activate.
 */
const CACHE_VERSION = "ana24-v1";

// Precache is best-effort: a single missing asset must never abort the install
// (a failed install means the app is not installable at all).
const PRECACHE = ["/", "/manifest.json", "/ana24.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {}),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Cache a successful, cacheable same-origin response. */
async function putInCache(request, response) {
  if (!response || !response.ok || response.status !== 200) return;
  try {
    const cache = await caches.open(CACHE_VERSION);
    await cache.put(request, response.clone());
  } catch {
    /* Quota or opaque response — the request still succeeded, so ignore. */
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  // Never proxy cross-origin traffic (Supabase, market data, fonts).
  if (!sameOrigin) return;
  // Never interfere with Vite's dev/preview endpoints.
  if (url.pathname.startsWith("/@") || url.pathname.includes("__vite")) return;

  // Immutable, content-hashed build output: cache-first.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        await putInCache(request, response);
        return response;
      })(),
    );
    return;
  }

  // Page navigations: always prefer the network so the shell stays current.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          await putInCache(new Request("/"), response.clone());
          return response;
        } catch {
          return (
            (await caches.match("/")) ||
            (await caches.match("/index.html")) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  // Everything else same-origin: network-first with a cache fallback.
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        await putInCache(request, response);
        return response;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw new Error("offline and not cached");
      }
    })(),
  );
});
