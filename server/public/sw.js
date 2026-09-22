// Caches the shell so Sotto opens instantly and survives a cold relay.
// Never caches API responses — /say, /poll, /pair and /presence must always
// hit the network.

// Bump this whenever the shell changes. The activate handler deletes every
// other cache, so a bump is what pushes a fixed index.html to phones that
// already installed the app — without it they keep running the old page.
const SHELL = "sotto-shell-v6";

// The manifest is deliberately absent: it is generated per pairing so its
// start_url carries the room code, and a cached copy would hand the installed
// app a stale room.
const ASSETS = ["/", "/index.html", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
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

  if (event.request.method !== "GET") return;
  if (/^\/(say|poll|pair|presence|health|stats)$/.test(url.pathname)) return;
  // Always from the network: it encodes the current pairing, so a stale one
  // would install an icon pointing at the wrong room.
  if (url.pathname === "/manifest.webmanifest") return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(SHELL).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match("/index.html")))
  );
});
