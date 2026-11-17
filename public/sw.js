// Service worker: keeps the app usable with weak or no signal.
// - App shell (HTML/CSS/JS/diagrams): cache-first, refreshed whenever the server's build version changes.
// - API reads: network-first with a short timeout, falling back to the last good copy.
// - Photos and signatures: cache-first (they never change).
// Writes (POST/PATCH) always go to the network; the page's outbox handles retries.

const VERSION = "__BUILD_VERSION__";
const SHELL = `gc-shell-${VERSION}`;
const RUNTIME = "gc-runtime";

const SHELL_FILES = [
  "/",
  "/css/app.css",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/js/app.js",
  "/js/api.js",
  "/js/brand.js",
  "/js/drafts.js",
  "/js/idb.js",
  "/js/sig.js",
  "/js/svc.js",
  "/js/ui.js",
  "/js/util.js",
  "/js/zip.js",
  "/js/views/admin.js",
  "/js/views/common.js",
  "/js/views/csv.js",
  "/js/views/detail.js",
  "/js/views/export.js",
  "/js/views/form.js",
  "/js/views/home.js",
  "/js/views/registration.js",
  "/js/views/repairs.js",
  "/js/views/service-detail.js",
  "/js/views/service-form.js",
  "/js/views/signin.js",
  "/js/views/tickets.js",
  "/js/views/truck.js",
  // Every bundled diagram, so a truck's form works offline even if it was never opened before.
  "/diagrams/pickup.jpg",
  "/diagrams/dump-truck.jpg",
  "/diagrams/trailer.jpg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("gc-shell-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

async function networkFirst(req, ms) {
  const cache = await caches.open(RUNTIME);
  const net = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  try {
    return await Promise.race([net, timeout(ms)]);
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    return net; // nothing cached: wait for the network after all (or fail)
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;

  if (p.startsWith("/api/")) {
    if (/\/pdf$/.test(p) || p === "/api/auth/logout") return;
    if (/^\/api\/photos\/|^\/api\/inspections\/[^/]+\/signature\/|^\/api\/diagrams\/\d+\/image$/.test(p)
      || (p === "/api/branding/logo" && url.searchParams.has("v"))) {
      event.respondWith(cacheFirst(req, RUNTIME));
      return;
    }
    event.respondWith(networkFirst(req, 6000));
    return;
  }
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(async () => (await caches.match("/", { cacheName: SHELL })) || Response.error()),
    );
    return;
  }
  if (p === "/sw.js") return;
  event.respondWith(
    caches.match(req, { cacheName: SHELL }).then((hit) => hit || cacheFirst(req, RUNTIME)),
  );
});
