/*
 * fetch wrapper for the portal API that gets "when do I sign the user out?" right.
 *
 * The user is signed out ONLY when the API answers 401 with a code that means the session really ended:
 *   TOKEN_EXPIRED | TOKEN_INVALID | PASSWORD_CHANGED.
 * It never signs out on: no network / timeout (NetworkError), 429 (rate limit), 5xx, 403, validation errors, or any other 401.
 * A phone that wakes up for a moment without internet therefore keeps its login.
 *
 *   const api = createApiClient({ baseUrl: "https://api.your-university.edu/api/v1/student", session, monitor, onSessionEnded: (code) => goToLogin(code) });
 *   const courses = await api("/courses");
 *   await api("/announcements", { method: "POST", body: formData });   // FormData is sent as multipart
 */
export const SESSION_ENDED_CODES = new Set(["TOKEN_EXPIRED", "TOKEN_INVALID", "PASSWORD_CHANGED"]);

export class NetworkError extends Error {
  constructor(message = "Network problem. Check your connection and try again.") { super(message); this.name = "NetworkError"; this.isNetworkError = true; }
}
export class ApiError extends Error {
  constructor(status, message, code, details) { super(message); this.name = "ApiError"; this.status = status; this.code = code; this.details = details; }
}

export function createApiClient({ baseUrl, session, monitor, onSessionEnded, fetchImpl }) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  return async function request(path, { method = "GET", body, headers = {}, auth = true, signal } = {}) {
    const token = auth ? session?.token() : null;
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const t0 = Date.now();
    let res;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method, signal,
        headers: { ...(isForm || body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      });
    } catch (err) {
      if (err && err.name === "AbortError" && signal && signal.aborted) throw err; // the caller cancelled it: not a network problem
      monitor?.reportRequestResult({ ok: false });
      throw new NetworkError(); // deliberately NOT a reason to sign out
    }
    monitor?.reportRequestResult({ ok: ![502, 503, 504].includes(res.status), rtt: Date.now() - t0 });

    const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (res.ok && json.success !== false) return json.data !== undefined ? json.data : json;

    if (res.status === 401 && SESSION_ENDED_CODES.has(json.code)) { session?.clear(); onSessionEnded?.(json.code); }
    throw new ApiError(res.status, json.message || "Something went wrong. Please try again.", json.code, json.errors); // the API puts details under "errors"
  };
}
