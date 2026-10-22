/*
 * Service worker for portal push notifications.
 * Host this file at the ROOT of the portal's frontend origin (e.g. https://portal.university.edu/sw.js): a service worker can only control pages
 * under its own path, and push requires HTTPS (localhost is allowed for development). The backend never serves it.
 */
const FALLBACK_URL = "/";

/** Same-origin portal paths only: anything else opens the portal home instead. */
function safeUrl(raw) {
  try {
    if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return FALLBACK_URL;
    const u = new URL(raw, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : FALLBACK_URL;
  } catch {
    return FALLBACK_URL;
  }
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 100) : "Departmental Portal";
  const body = typeof data.body === "string" ? data.body.slice(0, 200) : "You have a new notification.";
  // Browsers require every push to show a notification (userVisibleOnly), so a malformed payload still shows the generic text above.
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: typeof data.tag === "string" ? data.tag.slice(0, 64) : undefined, // same tag = the device collapses duplicates
    data: { url: safeUrl(data.url) },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin !== self.location.origin) continue;
      try { await w.focus(); if ("navigate" in w) await w.navigate(target); return; } catch (_) { /* fall through to a new window */ }
    }
    await self.clients.openWindow(target);
  })());
});

/** The browser rotated / expired the subscription: ask any open portal tab to re-register (the worker has no login token of its own). */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) w.postMessage({ type: "PUSH_SUBSCRIPTION_CHANGED" });
  })());
});
