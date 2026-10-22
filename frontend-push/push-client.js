/*
 * Framework-agnostic browser helper for portal push notifications.
 *
 *   import { isPushSupported, enablePush, disablePush, syncPush } from "./push-client.js";
 *   const api = { base: "/api/v1/student" /* or /lecturer, /hod *\/, getToken: () => localStorage.getItem("token") };
 *
 *   button.onclick = () => enablePush(api);   // MUST be called from a click: that is when the browser permission prompt is allowed
 *   after login / app start:   syncPush(api); // re-registers an existing subscription (no prompt)
 *   on logout, BEFORE clearing the token:   await disablePush(api);
 */
const SW_PATH = "/sw.js";

export const isPushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export const permissionState = () => (isPushSupported() ? Notification.permission : "unsupported"); // "default" | "granted" | "denied" | "unsupported"

async function call(api, path, method = "GET", body) {
  const res = await fetch(`${api.base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${api.getToken()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw Object.assign(new Error(json.message || "Request failed"), { status: res.status, code: json.code });
  return json.data;
}
const urlBase64ToUint8Array = (b64) => {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};
const registration = async () => { await navigator.serviceWorker.register(SW_PATH); return navigator.serviceWorker.ready; };

/** Asks permission (only call from a user click), subscribes this device and registers it with the backend. */
export async function enablePush(api) {
  if (!isPushSupported()) return { status: "unsupported" };
  const cfg = await call(api, "/push/config");
  if (!cfg.supported) return { status: "server-disabled" };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { status: permission === "denied" ? "denied" : "dismissed" };
  const reg = await registration();
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(cfg.publicKey) }));
  await call(api, "/push/subscriptions", "POST", { subscription: sub.toJSON() });
  return { status: "enabled" };
}

/** Removes this device on the server and in the browser. In-app notification history is untouched. */
export async function disablePush(api) {
  if (!isPushSupported()) return { status: "unsupported" };
  const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
  const sub = reg && (await reg.pushManager.getSubscription());
  if (!sub) return { status: "disabled" };
  await call(api, "/push/subscriptions", "DELETE", { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
  return { status: "disabled" };
}

/** Silent (never prompts): after sign-in, attaches an existing subscription to the CURRENT user and refreshes it. */
export async function syncPush(api) {
  if (!isPushSupported() || Notification.permission !== "granted") return { status: "idle" };
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return { status: "idle" };
  await call(api, "/push/subscriptions", "POST", { subscription: sub.toJSON() });
  return { status: "synced" };
}

/** Re-register when the service worker reports an expired / rotated subscription. */
export function listenForSubscriptionChanges(api) {
  navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.type === "PUSH_SUBSCRIPTION_CHANGED") syncPush(api).catch(() => undefined); });
}

export const getPreferences = (api) => call(api, "/push/preferences");
export const savePreferences = (api, prefs) => call(api, "/push/preferences", "PUT", prefs); // { pushEnabled?, categories?: { announcements, timetablesAndMaterials, assignments, complaints } }
export const sendTestNotification = (api) => call(api, "/push/test", "POST");
