/*
 * Keeps the login across closed tabs, locked phones and restarted browsers.
 *
 * Use localStorage (this file) and NEVER sessionStorage or memory-only state for the token: sessionStorage is wiped when a tab is closed or
 * discarded by the browser (which is exactly what happens when a phone is locked for a while), so people would be asked to sign in again.
 * The login only ends on an explicit logout, or when the API says the session really ended (api-client.js: TOKEN_EXPIRED / TOKEN_INVALID /
 * PASSWORD_CHANGED). Logging out in one tab signs out the others.
 */
const KEY = "portal.session";

function safeStorage() {
  try { const s = globalThis.localStorage; s.setItem("__t", "1"); s.removeItem("__t"); return s; } catch { return null; } // Safari private mode, blocked storage
}

/** When the token expires (seconds since epoch), read from its payload without verifying it: only used to avoid pointless requests. */
export function tokenExpiry(token) {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(globalThis.atob(p + "=".repeat((4 - (p.length % 4)) % 4)));
    return typeof json.exp === "number" ? json.exp : null;
  } catch { return null; }
}

export function createSessionStore({ storage = safeStorage(), key = KEY, win = globalThis.window } = {}) {
  let memory = null; // fallback when storage is unavailable: lasts until the page is closed, nothing better is possible
  const listeners = new Set();
  const read = () => {
    try { const raw = storage && storage.getItem(key); if (raw) return JSON.parse(raw); } catch { /* fall through */ }
    return memory;
  };
  const emit = () => listeners.forEach((fn) => fn(read()));
  win?.addEventListener?.("storage", (e) => { if (e.key === key) emit(); }); // another tab logged in / out

  return {
    /** { token, role } or null. */
    get: () => read(),
    token: () => read()?.token ?? null,
    save({ token, role }) {
      const v = { token, role, savedAt: Date.now() };
      memory = v;
      try { storage && storage.setItem(key, JSON.stringify(v)); } catch { /* quota / blocked: memory still works for this page */ }
      emit();
    },
    clear() { memory = null; try { storage && storage.removeItem(key); } catch { /* ignore */ } emit(); },
    /** True only when the token is KNOWN to be past its expiry (an unreadable token is left for the server to judge). */
    isExpired(nowSeconds = Math.floor(Date.now() / 1000)) { const t = read()?.token; const exp = t ? tokenExpiry(t) : null; return exp !== null && exp <= nowSeconds; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
