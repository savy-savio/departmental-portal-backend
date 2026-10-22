import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { parseDurationSeconds, shortSessionWarning } from "../src/utils/duration";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Runs one of the browser files (ES module syntax) in a sandbox and returns what it exports. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function load(file: string, globals: Record<string, unknown> = {}): any {
  const src = read(file);
  const names = [...src.matchAll(/export\s+(?:class|const|function)\s+(\w+)/g)].map((m) => m[1]);
  return vm.runInNewContext(`${src.replace(/^export\s+/gm, "")}\n;({ ${names.join(", ")} })`, { console, URL, JSON, Date, Math, Set, Map, Promise, Error, ...globals });
}
const tick = () => new Promise<void>((r) => setImmediate(r));

/* ============================ fake browser for the monitor ============================ */
function fakeEnv() {
  let t = 1_000, nextId = 0, online = true, visible = true, type: string | undefined;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners = new Map<string, Set<() => void>>();
  const fetches: { url: string; opts: Record<string, unknown> }[] = [];
  type Step = (opts: { signal?: { onabort?: () => void } }) => Promise<{ status: number }>;
  let script: Step[] = [];
  const respond = (status: number, rtt = 50): Step => () => { t += rtt; return Promise.resolve({ status }); };
  const fail = (rtt = 20): Step => () => { t += rtt; return Promise.reject(new TypeError("Failed to fetch")); };
  /** A request that never answers until the monitor aborts it (its timeout). */
  const hang: Step = (opts) => new Promise<{ status: number }>((_, rej) => { if (opts.signal) opts.signal.onabort = () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })); });
  const env = {
    now: () => t,
    fetch: (url: string, opts: { signal?: { onabort?: () => void } }) => {
      fetches.push({ url, opts: opts as Record<string, unknown> });
      return (script.shift() ?? respond(204))(opts); // by default the network answers promptly
    },
    setTimeout: (fn: () => void, ms: number) => { timers.set(++nextId, { at: t + ms, fn }); return nextId; },
    clearTimeout: (h: number) => void timers.delete(h),
    createAbortController: () => { const signal: { aborted: boolean; onabort?: () => void } = { aborted: false }; return { signal, abort() { signal.aborted = true; signal.onabort?.(); } }; },
    isOnline: () => online, isVisible: () => visible, effectiveType: () => type,
    listen: (e: string, fn: () => void) => { const s = listeners.get(e) ?? new Set(); s.add(fn); listeners.set(e, s); return () => void s.delete(fn); },
  };
  return {
    env, fetches, timers, respond, fail, hang,
    queue: (...s: Step[]) => { script = s; },
    fire: (e: string) => listeners.get(e)?.forEach((fn) => fn()),
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    set: (o: { online?: boolean; visible?: boolean; type?: string }) => { if (o.online !== undefined) online = o.online; if (o.visible !== undefined) visible = o.visible; if ("type" in o) type = o.type; },
    /** Moves the clock forward, firing due timers (and letting their promises settle) in order. */
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = Math.max(t, due[1].at); due[1].fn(); await tick(); await tick();
      }
      t = Math.max(t, end); await tick();
    },
  };
}
const { NetworkMonitor, computeStatus, MESSAGES, DEFAULTS } = load("frontend-session/network-monitor.js");
function monitorWorld(config?: object) {
  const f = fakeEnv();
  const m = new NetworkMonitor({ pingUrl: "https://api.example.edu/api/v1/ping", env: f.env, config });
  const seen: { status: string; reason: string; message: string; recovered: boolean }[] = [];
  m.subscribe((s: (typeof seen)[number]) => seen.push({ status: s.status, reason: s.reason, message: s.message, recovered: s.recovered }));
  return { f, m, seen, last: () => seen[seen.length - 1] };
}

/* ============================ pure decision ============================ */
test("1. computeStatus: offline, unstable and online from the evidence", () => {
  const base = { cfg: DEFAULTS, browserOnline: true, recovering: false, results: [], consecutiveFailures: 0, consecutiveSuccesses: 0, socketConnected: null, effectiveType: "4g" };
  const ok = { ok: true, rtt: 80 }, bad = { ok: false, rtt: 0 }, slow = { ok: true, rtt: 4000 };
  const s = (o: object) => computeStatus({ ...base, ...o }).status;
  assert.equal(s({}), "online");
  assert.equal(s({ results: [ok, ok] }), "online");
  assert.equal(s({ browserOnline: false }), "offline");
  assert.equal(s({ consecutiveFailures: 2, results: [bad, bad] }), "offline");
  assert.equal(s({ consecutiveFailures: 1, results: [ok, bad] }), "unstable");
  assert.equal(s({ results: [bad, ok, ok], consecutiveSuccesses: 2 }), "online"); // a failure followed by 2 good probes has recovered
  assert.equal(s({ results: [ok, slow] }), "online"); // one slow probe is not an alarm
  assert.equal(s({ results: [slow, ok, slow] }), "unstable");
  assert.equal(s({ effectiveType: "2g" }), "unstable");
  assert.equal(s({ socketConnected: false }), "unstable");
  assert.equal(s({ recovering: true, consecutiveSuccesses: 1, results: [ok] }), "unstable"); // not "online" until it has proved itself
  assert.equal(s({ recovering: true, consecutiveSuccesses: 2, results: [ok, ok] }), "online");
});

/* ============================ monitor behaviour ============================ */
test("2. A healthy network stays quiet: no banner events, a tiny probe every 15 s, no cached or credentialed requests", async () => {
  const { f, m, seen } = monitorWorld();
  m.start(); await tick();
  assert.equal(f.fetches.length, 1);
  await f.advance(15_000); await f.advance(15_000);
  assert.equal(f.fetches.length, 3);
  assert.equal(seen.length, 1); // only the initial state
  assert.deepEqual([f.fetches[0].opts.method, f.fetches[0].opts.cache, f.fetches[0].opts.credentials], ["GET", "no-store", "omit"]);
  assert.match(f.fetches[0].url, /^https:\/\/api\.example\.edu\/api\/v1\/ping\?_=\d+$/);
  assert.notEqual(f.fetches[0].url, f.fetches[1].url); // cache-busting
});
test("3. The browser going offline shows 'no network' at once; coming back shows 'reconnecting', then 'You're back online'", async () => {
  const { f, m, last, seen } = monitorWorld();
  m.start(); await tick();
  f.set({ online: false }); f.fire("offline");
  assert.deepEqual([last().status, last().reason, last().message], ["offline", "browser-offline", MESSAGES.offline]);
  assert.match(last().message, /No network connection/);
  const before = f.fetches.length;
  await f.advance(30_000);
  assert.equal(f.fetches.length, before); // no pointless requests while the browser says it is offline
  f.queue(f.respond(204), f.respond(204));
  f.set({ online: true }); f.fire("online"); await tick(); await tick();
  assert.deepEqual([last().status, last().reason], ["unstable", "reconnecting"]);
  await f.advance(5_000);
  assert.deepEqual([last().status, last().recovered, last().message], ["online", true, "You're back online."]);
  assert.deepEqual(seen.map((x) => x.status), ["online", "offline", "unstable", "online"]);
});
test("4. A connection that looks up but can't reach the server: one failure = unstable, two = offline, then it recovers in two good probes", async () => {
  const { f, m, last } = monitorWorld();
  f.queue(f.fail());
  m.start(); await tick(); await tick();
  assert.deepEqual([last().status, last().message], ["unstable", MESSAGES.unstable]);
  assert.match(last().message, /unstable/);
  f.queue(f.fail());
  await f.advance(5_000); // probes speed up while things are bad
  assert.deepEqual([last().status, last().reason], ["offline", "unreachable"]);
  f.queue(f.respond(204), f.respond(204));
  await f.advance(5_000);
  assert.equal(last().status, "unstable");
  await f.advance(5_000);
  assert.deepEqual([last().status, last().recovered], ["online", true]);
});
test("5. A probe that never answers is cut off after the timeout and counts as a failure", async () => {
  const { f, m, last } = monitorWorld();
  f.queue(f.hang, f.hang);
  m.start(); await tick(); // the network never answers
  await f.advance(5_000);
  assert.equal(last().status, "unstable");
  await f.advance(10_000);
  assert.equal(last().status, "offline");
});
test("6. Slow connections are called unstable, but one slow probe is not; gateway errors count as failures, other answers as success", async () => {
  const one = monitorWorld();
  one.f.queue(one.f.respond(204, 4000), one.f.respond(204, 60));
  one.m.start(); await tick(); await tick(); await one.f.advance(15_000);
  assert.equal(one.last().status, "online");
  const slow = monitorWorld();
  slow.f.queue(slow.f.respond(204, 4000), slow.f.respond(204, 4000));
  slow.m.start(); await tick(); await tick(); await slow.f.advance(15_000);
  assert.deepEqual([slow.last().status, slow.last().reason], ["unstable", "slow"]);
  const gw = monitorWorld();
  gw.f.queue(gw.f.respond(502));
  gw.m.start(); await tick(); await tick();
  assert.equal(gw.last().status, "unstable");
  const notFound = monitorWorld();
  notFound.f.queue(notFound.f.respond(404), notFound.f.respond(401));
  notFound.m.start(); await tick(); await tick(); await notFound.f.advance(15_000);
  assert.equal(notFound.last().status, "online"); // the server answered: the network is fine
});
test("7. Nothing is probed while the tab is hidden; waking the screen checks immediately", async () => {
  const { f, m } = monitorWorld();
  m.start(); await tick();
  f.set({ visible: false }); f.fire("visibilitychange");
  const n = f.fetches.length;
  await f.advance(120_000);
  assert.equal(f.fetches.length, n);
  f.set({ visible: true }); f.fire("visibilitychange"); await tick();
  assert.equal(f.fetches.length, n + 1);
});
test("8. A dropped real-time socket or a 2g connection makes it unstable; real request failures are noticed without waiting for a probe", async () => {
  const { f, m, last } = monitorWorld();
  m.start(); await tick();
  m.setSocketConnected(false);
  assert.deepEqual([last().status, last().reason], ["unstable", "realtime-disconnected"]);
  m.setSocketConnected(true);
  assert.equal(last().status, "online");
  f.set({ type: "2g" }); f.fire("change");
  assert.equal(last().reason, "slow-connection");
  f.set({ type: "4g" }); f.fire("change");
  assert.equal(last().status, "online");
  f.queue(f.respond(204));
  const n = f.fetches.length;
  m.reportRequestResult({ ok: false });
  assert.equal(last().status, "unstable"); // noticed at once, before any probe
  await tick(); await tick();
  assert.equal(f.fetches.length, n + 1); // a failed API call triggers an immediate probe
  assert.equal(last().status, "unstable"); // one good probe after a failure is not yet "recovered"
  f.queue(f.fail());
  m.reportRequestResult({ ok: false }); await tick(); await tick();
  assert.equal(last().status, "offline"); // a failed request AND a failed probe in a row: no network
});
test("9. subscribe / stop clean up: no listeners or timers remain", async () => {
  const { f, m } = monitorWorld();
  let calls = 0; const off = m.subscribe(() => calls++);
  m.start(); await tick();
  assert.ok(f.listenerCount() >= 4 && f.timers.size >= 1);
  off(); const c = calls; m.setSocketConnected(false); assert.equal(calls, c);
  m.stop();
  assert.deepEqual([f.listenerCount(), f.timers.size], [0, 0]);
  assert.throws(() => new NetworkMonitor({}), /pingUrl/);
});

/* ============================ session store ============================ */
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwtWithExp = (exp: number) => `${b64({ alg: "HS256" })}.${b64({ sub: "1", exp })}.sig`;
function fakeStorage() { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; }
const sessionLib = () => load("frontend-session/session-store.js", { atob: (s: string) => Buffer.from(s, "base64").toString("binary") });

test("10. The login survives closing the tab, a locked phone and a browser restart (persistent storage, not sessionStorage)", () => {
  const { createSessionStore } = sessionLib();
  const storage = fakeStorage();
  const first = createSessionStore({ storage, win: null });
  first.save({ token: "tok-1", role: "student" });
  const afterRestart = createSessionStore({ storage, win: null }); // a brand-new page load
  assert.deepEqual([afterRestart.token(), afterRestart.get().role], ["tok-1", "student"]);
  afterRestart.clear();
  assert.equal(createSessionStore({ storage, win: null }).token(), null);
  const src = strip(read("frontend-session/session-store.js"));
  assert.ok(!/sessionStorage/.test(src));
  assert.match(src, /localStorage/);
});
test("11. If storage is unavailable the session still works for the page; other tabs hear about logins and logouts", () => {
  const { createSessionStore } = sessionLib();
  const blocked = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  const s = createSessionStore({ storage: blocked, win: null });
  s.save({ token: "tok", role: "lecturer" });
  assert.equal(s.token(), "tok");
  s.clear(); assert.equal(s.token(), null);
  const handlers: Record<string, (e: { key: string }) => void> = {};
  const storage = fakeStorage();
  const tabB = createSessionStore({ storage, win: { addEventListener: (e: string, fn: (e: { key: string }) => void) => { handlers[e] = fn; } } });
  const seen: unknown[] = []; tabB.subscribe((v: unknown) => seen.push(v));
  storage.removeItem("portal.session"); handlers.storage({ key: "portal.session" }); // tab A logged out
  assert.deepEqual(seen, [null]);
  handlers.storage({ key: "something-else" }); assert.equal(seen.length, 1);
});
test("12. isExpired is true only for a token that is KNOWN to be past its expiry", () => {
  const { createSessionStore, tokenExpiry } = sessionLib();
  const s = createSessionStore({ storage: fakeStorage(), win: null });
  s.save({ token: jwtWithExp(2_000), role: "student" });
  assert.deepEqual([s.isExpired(1_999), s.isExpired(2_000), tokenExpiry(jwtWithExp(2_000))], [false, true, 2_000]);
  s.save({ token: "not-a-jwt", role: "student" });
  assert.deepEqual([s.isExpired(9_999_999_999), tokenExpiry("not-a-jwt")], [false, null]); // unreadable: leave it to the server
  s.clear(); assert.equal(s.isExpired(), false);
});

/* ============================ api client: when to sign out ============================ */
function apiWorld(respond: (url: string, init: Record<string, unknown>) => Promise<unknown>) {
  const { createApiClient, NetworkError, ApiError } = load("frontend-session/api-client.js", { FormData: class FormData {} });
  const cleared: number[] = []; const ended: string[] = []; const reports: { ok: boolean }[] = [];
  const session = { token: () => "tok-123", clear: () => void cleared.push(1) };
  const monitor = { reportRequestResult: (r: { ok: boolean }) => void reports.push(r) };
  const calls: { url: string; init: Record<string, unknown> }[] = [];
  const api = createApiClient({ baseUrl: "https://api.example.edu/api/v1/student", session, monitor, onSessionEnded: (c: string) => void ended.push(c), fetchImpl: (url: string, init: Record<string, unknown>) => { calls.push({ url, init }); return respond(url, init); } });
  return { api, cleared, ended, reports, calls, NetworkError, ApiError };
}
const reply = (status: number, body: object) => Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body });

test("13. A session that really ended (TOKEN_EXPIRED / TOKEN_INVALID / PASSWORD_CHANGED) signs the user out", async () => {
  for (const code of ["TOKEN_EXPIRED", "TOKEN_INVALID", "PASSWORD_CHANGED"]) {
    const w = apiWorld(() => reply(401, { success: false, message: "Your session has expired.", code }));
    await assert.rejects(w.api("/courses"), (e: { status: number; code: string }) => e.status === 401 && e.code === code);
    assert.deepEqual([w.cleared.length, w.ended], [1, [code]]);
  }
});
test("14. Network failures, 429, 5xx, 403 and ordinary 401s NEVER sign the user out", async () => {
  const net = apiWorld(() => Promise.reject(new TypeError("Failed to fetch")));
  await assert.rejects(net.api("/courses"), (e: { isNetworkError?: boolean; name: string }) => e.isNetworkError === true && e.name === "NetworkError");
  assert.deepEqual([net.cleared.length, net.ended.length, JSON.stringify(net.reports)], [0, 0, JSON.stringify([{ ok: false }])]); // the monitor is told, the login is kept
  for (const [status, body] of [[429, { success: false, message: "Too many requests." }], [500, { success: false, message: "Oops" }], [503, { success: false, message: "Down" }], [403, { success: false, message: "No", code: "ACCOUNT_INACTIVE" }], [401, { success: false, message: "Wrong email or password", code: "INVALID_CREDENTIALS" }], [401, { success: false, message: "nope" }], [422, { success: false, message: "Validation failed", errors: [{ field: "x", message: "bad" }] }]] as [number, object][]) {
    const w = apiWorld(() => reply(status, body));
    await assert.rejects(w.api("/x"), (e: { status: number }) => e.status === status);
    assert.deepEqual([w.cleared.length, w.ended.length], [0, 0], String(status));
  }
});
test("15. Requests carry the token and JSON; success unwraps data; 204 works; caller cancellations are not network errors; details come from `errors`", async () => {
  const w = apiWorld(() => reply(200, { success: true, data: { hello: "world" } }));
  assert.deepEqual(await w.api("/me"), { hello: "world" });
  await w.api("/things", { method: "POST", body: { a: 1 } });
  const h = w.calls[1].init.headers as Record<string, string>;
  assert.deepEqual([h.Authorization, h["Content-Type"], w.calls[1].init.body, w.calls[1].url], ["Bearer tok-123", "application/json", '{"a":1}', "https://api.example.edu/api/v1/student/things"]);
  const noAuth = apiWorld(() => reply(200, { success: true, data: 1 }));
  await noAuth.api("/auth/login", { method: "POST", body: {}, auth: false });
  assert.equal((noAuth.calls[0].init.headers as Record<string, string>).Authorization, undefined);
  const empty = apiWorld(() => Promise.resolve({ status: 204, ok: true, json: async () => { throw new Error("no body"); } }));
  assert.equal(JSON.stringify(await empty.api("/ping", { auth: false })), "{}");
  const ctl = { aborted: true };
  const aborted = apiWorld(() => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  await assert.rejects(aborted.api("/slow", { signal: ctl }), (e: { name: string }) => e.name === "AbortError");
  assert.equal(aborted.reports.length, 0);
  const val = apiWorld(() => reply(422, { success: false, message: "Validation failed", errors: [{ field: "title", message: "too short" }] }));
  await assert.rejects(val.api("/x", { method: "POST", body: {} }), (e: { details: unknown }) => JSON.stringify(e.details).includes("too short"));
});

/* ============================ backend pieces ============================ */
test("16. Token lifetime helpers: durations are read correctly and a too-short setting is flagged at startup", () => {
  assert.deepEqual(["15m", "1h", "7d", "2 weeks", "3600", "90s", "1 day"].map(parseDurationSeconds), [900, 3600, 604_800, 1_209_600, 3600, 90, 86_400]);
  assert.ok(Number.isNaN(parseDurationSeconds("soon")));
  assert.match(shortSessionWarning("15m")!, /JWT_EXPIRES_IN is "15m".*sign in again/);
  assert.match(shortSessionWarning("23h")!, /23h/);
  assert.equal(shortSessionWarning("1d"), null);
  assert.equal(shortSessionWarning("7d"), null);
  assert.match(shortSessionWarning("banana")!, /isn't a recognised duration/);
  assert.match(strip(read("src/server.ts")), /shortSessionWarning\(env\.JWT_EXPIRES_IN\)/);
});
test("17. Session-ending responses carry machine-readable codes for all three roles", () => {
  const t = read("src/services/token.service.ts");
  assert.match(t, /TokenExpiredError\) throw new AppError\(401, expiredMessage, undefined, "TOKEN_EXPIRED"\)/);
  assert.match(t, /throw new AppError\(401, invalidMessage, undefined, "TOKEN_INVALID"\)/); // students, lecturers and HODs all verify through this helper
  const a = read("src/middleware/auth.ts");
  for (const code of ["TOKEN_INVALID", "PASSWORD_CHANGED", "ONBOARDING_REQUIRED", "ACCOUNT_INACTIVE", "DEPARTMENT_INACTIVE"]) assert.ok(a.includes(`"${code}"`), code);
  const l = read("src/services/lecturer/auth.service.ts");
  assert.ok(l.includes('"PASSWORD_CHANGED"') && l.includes('"TOKEN_INVALID"'));
  assert.match(read("src/middleware/errorHandler.ts"), /\.\.\.\(code \? \{ code \} : \{\}\)/); // the code reaches the client
});
test("18. /api/v1/ping: GET/HEAD only, no auth, no database, not cached, outside the global limiter (campus NAT)", () => {
  const app = strip(read("src/app.ts"));
  const ping = app.indexOf('app.all("/api/v1/ping"');
  assert.ok(ping > 0 && ping < app.indexOf("app.use(globalLimiter)") && ping < app.indexOf('app.use("/api/v1", v1Routes)'));
  const block = app.slice(ping, app.indexOf("app.use(globalLimiter)"));
  assert.match(block, /pingLimiter/);
  assert.match(block, /Cache-Control", "no-store"/);
  assert.match(block, /status\(204\)/);
  assert.match(block, /405/);
  assert.ok(!/isDatabaseConnected|authenticate|find\(|findOne/.test(block), "no database or auth work");
  assert.match(read("src/middleware/rateLimiters.ts"), /export const pingLimiter = make\(MIN, 6000/);
});
test("19. The banner shows offline (alert), unstable and a 3-second 'back online'; no Campus features anywhere", () => {
  const b = read("frontend-session/NetworkBanner.jsx");
  assert.match(b, /role=\{kind === "offline" \? "alert" : "status"\}/);
  assert.match(b, /setTimeout\(\(\) => setShowRecovered\(false\), 3000\)/);
  for (const f of fs.readdirSync(path.resolve(__dirname, "../frontend-session"))) assert.ok(!/campus\s*(hub|market)/i.test(read(`frontend-session/${f}`)), f);
});
