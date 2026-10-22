import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHandshakeAuth, FailedAuthLimiter, HandshakeError, type Authenticators } from "../src/realtime/handshake";
import { RealtimeHub, type SocketLike } from "../src/realtime/hub";
import { MAX_SOCKETS_PER_USER, userRoom, type RealtimeIdentity } from "../src/realtime/rooms";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/* ---------- fakes ---------- */
class FakeSocket implements SocketLike {
  rooms: string[] = []; emitted: { event: string; payload: unknown }[] = []; closed = false; private onDisc: (() => void)[] = [];
  constructor(public id: string) {}
  join(r: string) { this.rooms.push(r); }
  emit(event: string, payload?: unknown) { this.emitted.push({ event, payload }); }
  disconnect() { if (this.closed) return; this.closed = true; this.onDisc.forEach((f) => f()); }
  on(_e: "disconnect", fn: () => void) { this.onDisc.push(fn); }
}
class FakeIo {
  sent: { room: string; event: string; payload: unknown }[] = []; boom = false;
  to(room: string) { return { emit: (event: string, payload?: unknown) => { if (this.boom) throw new Error("io down"); this.sent.push({ room, event, payload }); } }; }
}
const ada: RealtimeIdentity = { userId: "ada", userType: "STUDENT", departmentId: "d-csc" };
const note = (o: object = {}) => ({ id: "n1", recipientId: "ada", recipientType: "STUDENT" as const, kind: "ANNOUNCEMENT", title: "T", body: "B", link: "/student/announcements", complaintId: null, ...o });

/* ============================ rooms ============================ */
test("1. Every account has its own room, and a student id can never collide with a lecturer or HOD id", () => {
  assert.equal(userRoom({ userType: "STUDENT", userId: "42" }), "user:STUDENT:42");
  assert.equal(new Set(["STUDENT", "LECTURER", "HOD"].map((t) => userRoom({ userType: t as never, userId: "42" }))).size, 3);
});

/* ============================ handshake authentication ============================ */
function auths(over: Partial<Authenticators> = {}): Authenticators {
  const ok = (type: RealtimeIdentity["userType"], valid: string): ((t: string) => Promise<RealtimeIdentity>) => async (t) => { if (t !== valid) throw new Error("bad token"); return { userId: `${type}-1`, userType: type, departmentId: "d-csc" }; };
  return { STUDENT: ok("STUDENT", "stu-token"), LECTURER: ok("LECTURER", "lec-token"), HOD: ok("HOD", "hod-token"), ...over };
}
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as HandshakeError; } throw new Error("expected a rejection"); };

test("2. A valid token for the named role connects; the identity comes from the verifier, never from the client", async () => {
  const a = createHandshakeAuth(auths());
  assert.deepEqual(await a({ auth: { token: "stu-token", role: "student" } }), { userId: "STUDENT-1", userType: "STUDENT", departmentId: "d-csc" });
  assert.equal((await a({ auth: { token: "lec-token", role: "Lecturer" } })).userType, "LECTURER");
  assert.equal((await a({ auth: { token: "hod-token", role: "hod" } })).userType, "HOD");
  // extra fields a client might send (userId, department, room) are ignored
  assert.equal((await a({ auth: { token: "stu-token", role: "student", userId: "someone-else", departmentId: "d-mls", room: "user:HOD:1" } })).userId, "STUDENT-1");
});
test("3. Missing / malformed / wrong-audience tokens are refused with one generic message", async () => {
  const a = createHandshakeAuth(auths());
  const cases: Record<string, unknown>[] = [{}, { token: "" }, { token: "stu-token" }, { token: "stu-token", role: "admin" }, { token: 123, role: "student" }, { token: "x".repeat(5000), role: "student" }];
  for (const auth of cases) assert.equal((await fail(a({ auth }))).code, "AUTH_REQUIRED");
  // a lecturer's token presented as a student (or the reverse) does not verify for that audience
  assert.deepEqual([await fail(a({ auth: { token: "lec-token", role: "student" } })), await fail(a({ auth: { token: "stu-token", role: "hod" } }))].map((e) => [e.code, e.message]), [["AUTH_FAILED", "Authentication failed."], ["AUTH_FAILED", "Authentication failed."]]);
  // whatever the verifier throws (suspended, deleted, expired...), the client learns nothing more
  const leaky = createHandshakeAuth(auths({ STUDENT: async () => { throw new Error("Your account is suspended: matric 25/208CSC/987"); } }));
  assert.equal((await fail(leaky({ auth: { token: "x", role: "student" } }))).message, "Authentication failed.");
});
test("4. The token is only ever read from the handshake auth, never from the URL query string", async () => {
  const a = createHandshakeAuth(auths());
  assert.equal((await fail(a({ query: { token: "stu-token", role: "student" } }))).code, "AUTH_REQUIRED");
  assert.equal((await fail(a({ auth: { role: "student" }, query: { token: "stu-token" } }))).code, "AUTH_REQUIRED");
});
test("5. A verifier that returns the wrong audience is rejected (defence in depth)", async () => {
  const a = createHandshakeAuth(auths({ STUDENT: async () => ({ userId: "x", userType: "HOD", departmentId: "d" }) }));
  assert.equal((await fail(a({ auth: { token: "t", role: "student" } }))).code, "AUTH_FAILED");
});
test("6. Failed handshakes per IP are limited in a sliding window", () => {
  let t = 0; const l = new FailedAuthLimiter(3, 1000, () => t);
  for (let i = 0; i < 3; i++) { assert.equal(l.blocked("1.1.1.1"), false); l.recordFailure("1.1.1.1"); }
  assert.deepEqual([l.blocked("1.1.1.1"), l.blocked("2.2.2.2")], [true, false]); // only the offender
  t = 1500; assert.equal(l.blocked("1.1.1.1"), false); // the window passed
});

/* ============================ hub: rooms and delivery ============================ */
test("7. A connecting socket joins ONLY its owner's room and is told its unread count", async () => {
  const hub = new RealtimeHub(new FakeIo(), { countUnread: async () => 4 });
  const s = new FakeSocket("s1");
  await hub.onConnect(s, ada);
  assert.deepEqual(s.rooms, ["user:STUDENT:ada"]);
  assert.deepEqual(s.emitted, [{ event: "ready", payload: { role: "student", unreadCount: 4 } }]);
  const noCount = new FakeSocket("s2");
  await new RealtimeHub(new FakeIo(), { countUnread: async () => { throw new Error("db"); } }).onConnect(noCount, ada);
  assert.deepEqual(noCount.emitted[0].payload, { role: "student", unreadCount: null }); // a failing count never blocks the connection
});
test("8. New notifications are delivered to the recipient's room only, in the REST list's shape", () => {
  const io = new FakeIo(); const hub = new RealtimeHub(io);
  hub.emitNotifications([note(), note({ id: "n2", recipientId: "lec1", recipientType: "LECTURER", complaintId: "c9", link: "/lecturer/complaints" }), note({ id: "n3", recipientId: "h1", recipientType: "HOD" })]);
  assert.deepEqual(io.sent.map((x) => [x.room, x.event]), [["user:STUDENT:ada", "notification:new"], ["user:LECTURER:lec1", "notification:new"], ["user:HOD:h1", "notification:new"]]);
  const p = io.sent[1].payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(p).sort(), ["body", "complaintId", "createdAt", "id", "kind", "link", "read", "title"]);
  assert.deepEqual([p.complaintId, p.read, p.link], ["c9", false, "/lecturer/complaints"]);
  assert.ok(!JSON.stringify(io.sent).includes("recipient"), "no recipient ids in the payload");
});
test("9. Read-state changes reach only that user's own devices", () => {
  const io = new FakeIo(); const hub = new RealtimeHub(io);
  hub.emitToUser({ userType: "STUDENT", userId: "ada" }, "notification:read", { id: "n1" });
  hub.emitToUser({ userType: "LECTURER", userId: "ada" }, "notification:read", { all: true }); // same raw id, different account type
  assert.deepEqual(io.sent.map((x) => x.room), ["user:STUDENT:ada", "user:LECTURER:ada"]);
});
test("10. An inactive hub (no server attached) and a failing server are silent no-ops: they can never break the caller", () => {
  const idle = new RealtimeHub(null);
  assert.equal(idle.active, false);
  assert.doesNotThrow(() => { idle.emitNotifications([note()]); idle.emitToUser({ userType: "STUDENT", userId: "a" }, "x"); });
  const io = new FakeIo(); io.boom = true; const warns: unknown[][] = [];
  const hub = new RealtimeHub(io, { log: { warn: (...a) => void warns.push(a) } });
  assert.doesNotThrow(() => hub.emitNotifications([note(), note({ id: "n2" })]));
  assert.equal(warns.length, 2);
  hub.attach(new FakeIo()); assert.equal(hub.active, true);
});

/* ============================ connection limits and lifetime ============================ */
test("11. At most N sockets per user: the oldest is dropped; other users are unaffected", async () => {
  const hub = new RealtimeHub(new FakeIo(), { maxSocketsPerUser: 3 });
  const socks = Array.from({ length: 5 }, (_, i) => new FakeSocket(`s${i}`));
  for (const s of socks) await hub.onConnect(s, ada);
  assert.deepEqual(socks.map((s) => s.closed), [true, true, false, false, false]);
  assert.equal(hub.connectionCount(ada), 3);
  const other = new FakeSocket("o1"); await hub.onConnect(other, { ...ada, userId: "ben" });
  assert.deepEqual([other.closed, hub.connectionCount({ userType: "STUDENT", userId: "ben" })], [false, 1]);
  assert.equal(MAX_SOCKETS_PER_USER, 5);
});
test("12. A session ends after the maximum lifetime (forcing a fresh token and account check); disconnects clean up", async () => {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const scheduler = { setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; }, clearTimeout: (h: unknown) => { (h as { cleared: boolean }).cleared = true; } };
  const hub = new RealtimeHub(new FakeIo(), { maxSessionMs: 3_600_000, scheduler });
  const a = new FakeSocket("a"), b = new FakeSocket("b");
  await hub.onConnect(a, ada); await hub.onConnect(b, ada);
  assert.deepEqual(timers.map((t) => t.ms), [3_600_000, 3_600_000]);
  timers[0].fn();
  assert.deepEqual([a.closed, b.closed, timers[0].cleared], [true, false, true]); // closing clears its own timer
  assert.equal(hub.connectionCount(ada), 1);
  b.disconnect();
  assert.deepEqual([hub.connectionCount(ada), timers[1].cleared], [0, true]);
});

/* ============================ wiring ============================ */
test("13. The server attaches Socket.IO with the API's CORS allow-list, tiny payloads, no client events and no URL tokens", () => {
  const s = strip(read("src/realtime/server.ts"));
  assert.match(s, /env\.clientOrigins\.includes\(origin\)/);
  assert.match(s, /maxHttpBufferSize: 10_000/);
  assert.ok(!/socket\.on\(\s*"(?!disconnect)/.test(s) && !/\.onAny\(/.test(s), "the server registers no client-event handlers");
  assert.ok(!/\.join\(/.test(s), "rooms are joined only by the hub, from the verified identity");
  assert.ok(!/handshake\.query|handshake\.headers/.test(s), "tokens are never read from the query string");
  assert.match(s, /handshake\.auth/);
  // the same verification as the REST API, for all three audiences
  assert.match(s, /loadActiveStudent/); assert.match(s, /lecturerAuth\.authenticate/); assert.match(s, /hodAuth\.authenticate/);
  assert.match(s, /lecturer\.role !== "LECTURER"/); assert.match(s, /lecturer\.role !== "HOD"/);
  assert.match(read("src/middleware/auth.ts"), /const \{ student, department \} = await loadActiveStudent\(bearerToken\(req\)\)/); // HTTP and sockets share the SAME student checks
});
test("14. notify() saves, then pushes live without awaiting; mark-read events are emitted by all three notification controllers", () => {
  const n = strip(read("src/services/notification.service.ts"));
  const body = n.slice(n.indexOf("export async function notify"), n.indexOf("const dto"));
  assert.ok(body.indexOf("insertMany") < body.indexOf("realtime.emitNotifications"), "saved before it is emitted");
  assert.ok(!/await\s+realtime/.test(body));
  for (const f of ["src/controllers/student-services.controller.ts", "src/controllers/lecturer.controller.ts", "src/controllers/hod.controller.ts"]) {
    const c = strip(read(f));
    assert.equal((c.match(/"notification:read"/g) ?? []).length, 2 + (f.includes("student") ? 0 : 0), f);
    assert.match(c, /realtime\.emitToUser\(/);
  }
  // no import cycle: the singleton imports nothing from the auth services
  assert.ok(!/from "\.\.\/services|from "\.\.\/middleware/.test(strip(read("src/realtime/instance.ts")) + strip(read("src/realtime/hub.ts"))));
});
test("15. Startup / shutdown and config: attached after listen, closed on shutdown, switchable, bounded session length", () => {
  const sv = strip(read("src/server.ts"));
  assert.ok(sv.indexOf("app.listen") < sv.indexOf("attachRealtime(server)"));
  assert.match(sv, /realtime\.close\(\)/);
  const env = read("src/config/env.ts");
  assert.match(env, /SOCKET_ENABLED: z\.enum\(\["true", "false"\]\)\.default\("true"\)/);
  assert.match(env, /SOCKET_MAX_SESSION_MINUTES: z\.coerce\.number\(\)\.int\(\)\.min\(5\)\.max\(1440\)\.default\(60\)/);
  assert.match(read("package.json"), /"socket\.io": "\^4/);
  const client = read("frontend-realtime/realtime-client.js");
  assert.match(client, /auth: \(cb\) => cb\(\{ token: getToken\(\), role \}\)/); // fresh token on every reconnect, in the handshake not the URL
  assert.ok(!/localStorage|sessionStorage|password/i.test(client.replace(/\/\*[\s\S]*?\*\//g, "")));
});
