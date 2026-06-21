// MoneyManage service worker – offline shell cache
const CACHE = "mm-cache-v15";
const SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/config.js",
  "./js/data.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  // friss fájlok a precache-be (a böngésző HTTP-cache megkerülésével)
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(
    SHELL.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {}))
  )));
  self.skipWaiting();
});

// kézi frissítés-kérés (ha a kliens üzen)
self.addEventListener("message", (e) => { if (e.data === "skip") self.skipWaiting(); });

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Supabase és árfolyam-API hívásokat soha ne cache-eljük (mindig friss adat)
  if (url.hostname.endsWith(".supabase.co") || url.hostname.endsWith("frankfurter.dev") || url.hostname.endsWith("er-api.com")) return;
  if (e.request.method !== "GET") return;

  // Saját fájlok: network-first (friss kód), offline esetén cache
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  // CDN (Chart.js, Supabase JS, betűtípusok): cache-first
  e.respondWith(
    caches.match(e.request).then(
      (cached) =>
        cached ||
        fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
    )
  );
});
