// Service worker for offline app-shell support.
//
// IMPORTANT: this app already fought a "not seeing my changes" PWA caching
// problem (see the no-cache meta tags in index.html). To avoid regressing
// that, same-origin requests (including the HTML document itself) use a
// network-first strategy: always try the network first so online users get
// the latest version, and only fall back to the cache when a fetch
// genuinely fails (offline). Cross-origin CDN/font resources are pinned by
// version in their URLs, so those use stale-while-revalidate instead.
//
// Bump CACHE_VERSION whenever the precache list or this file's logic
// changes meaningfully - there's no build step, so this is a manual
// convention.
var CACHE_VERSION = "v5";
var CACHE_NAME = "family-table-shell-" + CACHE_VERSION;

var SAME_ORIGIN_PRECACHE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/favicon-32.png",
  "./icons/icon-120.png",
  "./icons/icon-152.png",
  "./icons/icon-167.png",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

var CROSS_ORIGIN_PRECACHE = [
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js",
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage-compat.js",
  "https://unpkg.com/react@18/umd/react.production.min.js",
  "https://unpkg.com/react-dom@18/umd/react-dom.production.min.js",
  "https://unpkg.com/@babel/standalone@7.23.5/babel.min.js"
];

self.addEventListener("install", function(event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      // Precache same-origin files as a single batch (fails together, which
      // is fine - these are all small and always available at install time).
      var sameOrigin = cache.addAll(SAME_ORIGIN_PRECACHE);
      // Precache cross-origin CDN scripts individually so one failing
      // (e.g. a transient CDN hiccup) doesn't block the whole install.
      var crossOrigin = Promise.all(
        CROSS_ORIGIN_PRECACHE.map(function(url) {
          return fetch(url, { mode: "cors" })
            .then(function(response) {
              if (response.ok) return cache.put(url, response);
            })
            .catch(function() {
              // Ignore - this resource just won't be available offline yet.
            });
        })
      );
      return Promise.all([sameOrigin, crossOrigin]);
    })
  );
});

self.addEventListener("activate", function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names
          .filter(function(name) { return name.indexOf("family-table-shell-") === 0 && name !== CACHE_NAME; })
          .map(function(name) { return caches.delete(name); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

self.addEventListener("fetch", function(event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url = new URL(request.url);

  if (isSameOrigin(url)) {
    // Network-first: always prefer the live version when online.
    //
    // A plain fetch(request) still reads the browser's HTTP cache, so with
    // GitHub Pages serving Cache-Control: max-age=600 this would happily
    // return a 10-minute-stale document without ever hitting the network -
    // "network-first" in name only, and the exact stale-HTML problem this
    // strategy exists to prevent. Navigations therefore bypass the HTTP
    // cache explicitly. Subresources (icons, manifest) are left alone: they
    // change rarely and benefit from normal caching.
    var isNavigation = request.mode === "navigate" || request.destination === "document";
    var networkRequest = isNavigation ? new Request(request, { cache: "reload" }) : request;

    event.respondWith(
      fetch(networkRequest).then(function(response) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function(cache) { cache.put(request, copy); });
        return response;
      }).catch(function() {
        return caches.match(request).then(function(cached) {
          return cached || caches.match("./index.html");
        });
      })
    );
    return;
  }

  // Only the pinned CDN scripts we precache are handled here. Everything else
  // cross-origin must pass straight through to the browser.
  //
  // This handler forces mode:"cors", which is correct for those scripts but
  // breaks anything that doesn't expect it. Firebase Storage photo URLs are
  // cross-origin: an <img> loads them as a no-cors request and renders fine,
  // but re-issuing that as a cors request fails outright, because Storage
  // buckets carry no CORS configuration by default. The photo silently
  // doesn't render - the document looks migrated, the image is just gone.
  //
  // Returning without calling respondWith hands the request back to the
  // browser's default handling, which is what non-CDN cross-origin traffic
  // (photos, Firestore, the AI worker) wants.
  if (CROSS_ORIGIN_PRECACHE.indexOf(url.href) === -1) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.match(request).then(function(cached) {
        var networkFetch = fetch(request, { mode: "cors" }).then(function(response) {
          if (response.ok) cache.put(request, response.clone());
          return response;
        }).catch(function() { return cached; });
        return cached || networkFetch;
      });
    })
  );
});
