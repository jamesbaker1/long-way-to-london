// Service worker for The Long Way to London.
// Strategy:
//   - Navigations / HTML (the app shell): NETWORK-FIRST so a new deploy reaches users on
//     the next load; fall back to the cached shell when offline.
//   - Static same-origin assets: stale-while-revalidate (fast, self-healing).
//   - /api/state: network-first, falling back to cache when offline; a true offline miss
//     returns a distinguishable {"__offline":true} signal (not a bare {}), so the client
//     can keep its current state instead of treating it as authoritative-empty.
//
// CACHE_VERSION is bumped on every deploy (or replaced with a build hash) so activate()
// purges the previous shell cache and stale editor HTML never lingers across releases.

const CACHE_VERSION = "ltl-v2";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

const APP_SHELL = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Cache each shell URL independently so one 404 (e.g. /index.html on a platform that
      // only serves "/") doesn't void the whole pre-cache the way an atomic addAll would.
      .then((cache) =>
        Promise.all(
          APP_SHELL.map((url) =>
            fetch(url, { cache: "no-cache" })
              .then((res) => (res && res.ok ? cache.put(url, res) : null))
              .catch(() => {})
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle GET; let the network deal with PUT/POST/OPTIONS etc.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Only manage same-origin requests.
  if (url.origin !== self.location.origin) return;

  // API state -> network-first, fall back to cache.
  if (url.pathname === "/api/state") {
    event.respondWith(apiNetworkFirst(request));
    return;
  }

  // Navigations / HTML documents -> network-first so new deploys land immediately.
  if (request.mode === "navigate") {
    event.respondWith(navigationNetworkFirst(request));
    return;
  }

  // Other same-origin assets -> stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(request));
});

async function apiNetworkFirst(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Distinguishable offline signal: the client treats __offline as "keep current state",
    // rather than mistaking a bare {} for an authoritative empty overlay.
    return new Response(JSON.stringify({ __offline: true }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

async function navigationNetworkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached =
      (await cache.match(request)) ||
      (await caches.match("/index.html")) ||
      (await caches.match("/"));
    if (cached) return cached;
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
}
