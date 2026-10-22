/*
 * Tells the user when they have no network or an unstable one.
 *
 *   const monitor = new NetworkMonitor({ pingUrl: "https://api.your-university.edu/api/v1/ping" });
 *   monitor.start();
 *   monitor.subscribe((s) => show(s));   // s = { status: "online" | "unstable" | "offline", message, reason, recovered, rtt, since }
 *
 * How it decides:
 *   offline  - the browser says it is offline, or 2 probes in a row failed / timed out
 *   unstable - a recent probe failed, or 2 of the last 3 were slow, or the real-time socket dropped, or the connection reports 2g
 *   online   - otherwise (and "recovered: true" the moment it comes back, so the UI can say "You're back online")
 * Probes are tiny GET /ping calls (no login needed, nothing to download), paused while the tab is hidden, and faster while things look bad.
 */
export const NetworkStatus = Object.freeze({ ONLINE: "online", UNSTABLE: "unstable", OFFLINE: "offline" });
export const MESSAGES = Object.freeze({
  offline: "No network connection. Check your internet connection. Changes can't be saved until you're back online.",
  unstable: "Your network is unstable. Some actions may be slow or fail.",
  recovered: "You're back online.",
  online: "",
});
export const DEFAULTS = Object.freeze({ intervalMs: 15000, unstableIntervalMs: 5000, timeoutMs: 5000, slowMs: 2500, offlineAfterFailures: 2, recoverAfterSuccesses: 2 });

/** Pure: the status for the current evidence (exported so it can be tested without a browser). */
export function computeStatus(i) {
  const c = i.cfg;
  if (i.browserOnline === false) return { status: NetworkStatus.OFFLINE, reason: "browser-offline" };
  if (i.consecutiveFailures >= c.offlineAfterFailures) return { status: NetworkStatus.OFFLINE, reason: "unreachable" };
  // Coming back from offline: not "online" until the connection has proved itself with a few good probes in a row.
  if (i.recovering && i.consecutiveSuccesses < c.recoverAfterSuccesses) return { status: NetworkStatus.UNSTABLE, reason: "reconnecting" };
  const tail = i.results.slice(-c.recoverAfterSuccesses);
  if (tail.some((r) => !r.ok)) return { status: NetworkStatus.UNSTABLE, reason: "failed-requests" };
  if (i.results.slice(-3).filter((r) => r.rtt > c.slowMs).length >= 2) return { status: NetworkStatus.UNSTABLE, reason: "slow" };
  if (i.effectiveType === "slow-2g" || i.effectiveType === "2g") return { status: NetworkStatus.UNSTABLE, reason: "slow-connection" };
  if (i.socketConnected === false) return { status: NetworkStatus.UNSTABLE, reason: "realtime-disconnected" };
  return { status: NetworkStatus.ONLINE, reason: "ok" };
}

/** The real browser, behind a tiny interface so tests can supply a fake one. */
export function browserEnv() {
  const w = globalThis.window, nav = globalThis.navigator, doc = globalThis.document;
  const listen = (t, e, fn) => { t?.addEventListener?.(e, fn); return () => t?.removeEventListener?.(e, fn); };
  return {
    fetch: (...a) => globalThis.fetch(...a),
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h),
    createAbortController: () => (typeof AbortController !== "undefined" ? new AbortController() : null),
    isOnline: () => nav?.onLine !== false,
    isVisible: () => doc?.visibilityState !== "hidden",
    effectiveType: () => nav?.connection?.effectiveType,
    listen: (event, fn) => (event === "online" || event === "offline" ? listen(w, event, fn) : event === "visibilitychange" ? listen(doc, event, fn) : listen(nav?.connection, event, fn)),
  };
}

export class NetworkMonitor {
  constructor({ pingUrl, config, env } = {}) {
    if (!pingUrl) throw new Error("NetworkMonitor needs a pingUrl (e.g. https://api.example.edu/api/v1/ping)");
    this.pingUrl = pingUrl;
    this.cfg = { ...DEFAULTS, ...(config || {}) };
    this.env = env || browserEnv();
    this.listeners = new Set();
    this.results = [];
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.socketConnected = null;
    this.recovering = false; // true from the moment we were offline until the connection has proved itself again
    this.browserOnline = this.env.isOnline();
    this.timer = null;
    this.probing = false;
    this.running = false;
    this.cleanups = [];
    this.state = { status: NetworkStatus.ONLINE, reason: "ok", message: MESSAGES.online, recovered: false, rtt: null, since: this.env.now() };
  }

  getState() { return this.state; }
  /** Calls fn now and on every change. Returns an unsubscribe function. */
  subscribe(fn) { this.listeners.add(fn); fn(this.state); return () => this.listeners.delete(fn); }

  start() {
    if (this.running) return;
    this.running = true;
    this.cleanups = [
      this.env.listen("offline", () => { this.browserOnline = false; this.recompute(); }),   // instant: no probe needed to know
      this.env.listen("online", () => { this.browserOnline = true; this.recompute(); this.checkNow(); }),
      this.env.listen("visibilitychange", () => { if (this.env.isVisible()) this.checkNow(); else this.clearTimer(); }), // waking a locked phone re-checks at once
      this.env.listen("change", () => this.recompute()),
    ];
    this.recompute();
    if (this.env.isVisible()) this.checkNow();
  }
  stop() { this.running = false; this.clearTimer(); this.cleanups.forEach((f) => f && f()); this.cleanups = []; }

  /** Feed in the real-time socket state (`onConnectionChange` of realtime-client.js). */
  setSocketConnected(connected) { this.socketConnected = connected; this.recompute(); }
  /** Feed in the outcome of a real API request (api-client.js does this), so a failure is noticed before the next probe. */
  reportRequestResult({ ok, rtt }) {
    this.push({ ok, rtt: rtt ?? 0 });
    this.recompute();
    if (!ok) this.checkNow();
  }

  async checkNow() {
    if (!this.running || this.probing) return;
    this.browserOnline = this.env.isOnline();
    if (!this.browserOnline) { this.recompute(); this.scheduleNext(); return; }
    this.probing = true;
    const ctl = this.env.createAbortController();
    const timer = this.env.setTimeout(() => ctl && ctl.abort(), this.cfg.timeoutMs);
    const t0 = this.env.now();
    let ok = false;
    try {
      const res = await this.env.fetch(`${this.pingUrl}${this.pingUrl.includes("?") ? "&" : "?"}_=${t0}`, { method: "GET", cache: "no-store", credentials: "omit", signal: ctl ? ctl.signal : undefined });
      ok = ![502, 503, 504].includes(res.status); // a gateway error means we can't really reach the app; any other answer means the network works
    } catch { ok = false; } // offline, DNS, reset, or timed out (aborted)
    this.env.clearTimeout(timer);
    this.probing = false;
    this.push({ ok, rtt: this.env.now() - t0 });
    this.recompute();
    this.scheduleNext();
  }

  push(r) {
    this.results.push(r); if (this.results.length > 6) this.results.shift();
    if (r.ok) { this.consecutiveSuccesses++; this.consecutiveFailures = 0; } else { this.consecutiveFailures++; this.consecutiveSuccesses = 0; }
  }
  recompute() {
    const d = computeStatus({
      browserOnline: this.browserOnline, recovering: this.recovering, results: this.results, consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses, socketConnected: this.socketConnected, effectiveType: this.env.effectiveType(), cfg: this.cfg,
    });
    if (d.status === NetworkStatus.OFFLINE) { this.recovering = true; this.consecutiveSuccesses = 0; } // good probes from BEFORE the outage prove nothing about now
    else if (d.status === NetworkStatus.ONLINE) this.recovering = false;
    const last = this.results[this.results.length - 1];
    if (d.status === this.state.status && d.reason === this.state.reason) { if (last) this.state = { ...this.state, rtt: last.rtt }; return; }
    const recovered = d.status === NetworkStatus.ONLINE && this.state.status !== NetworkStatus.ONLINE;
    this.state = { status: d.status, reason: d.reason, message: recovered ? MESSAGES.recovered : MESSAGES[d.status], recovered, rtt: last ? last.rtt : null, since: this.env.now() };
    this.listeners.forEach((fn) => fn(this.state));
  }
  clearTimer() { if (this.timer !== null) { this.env.clearTimeout(this.timer); this.timer = null; } }
  scheduleNext() {
    this.clearTimer();
    if (!this.running || !this.env.isVisible()) return; // no probing in a hidden tab: saves battery and data
    const ms = this.state.status === NetworkStatus.ONLINE ? this.cfg.intervalMs : this.cfg.unstableIntervalMs; // look harder while things are bad
    this.timer = this.env.setTimeout(() => { this.timer = null; this.checkNow(); }, ms);
  }
}
