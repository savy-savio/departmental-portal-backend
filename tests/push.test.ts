import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { PushService } from "../src/services/push/push.service";
import { buildPushPayload, categoryOf, deviceLabelFrom, isAllowedPushEndpoint, safePortalPath, type PushableNotification } from "../src/services/push/rules";
import { isInReminderWindow, reminderKey, reminderText, studentsToRemind } from "../src/services/push/reminder-rules";
import type { PushOwner } from "../src/services/push/store";
import { FakeSender, PushMemoryStore } from "./helpers/push-memory-store";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const NOW = new Date("2026-10-14T10:00:00Z");
const KEYS = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
const ep = (n: string) => `https://fcm.googleapis.com/fcm/send/${n}`;
const stu = (id: string, dept = "d-csc"): PushOwner => ({ userId: id, userType: "STUDENT", departmentId: dept });
const lec = (id: string, dept = "d-csc"): PushOwner => ({ userId: id, userType: "LECTURER", departmentId: dept });
const hod = (id: string, dept = "d-csc"): PushOwner => ({ userId: id, userType: "HOD", departmentId: dept });

function world(over: { enabled?: boolean; max?: number } = {}) {
  const store = new PushMemoryStore(), sender = new FakeSender(), warnings: unknown[][] = [];
  const svc = new PushService({
    store, sender, now: () => NOW, log: { warn: (...a) => void warnings.push(a) },
    config: { enabled: over.enabled ?? true, publicKey: "P".repeat(87), extraEndpointHosts: [], maxDevicesPerUser: over.max ?? 10 },
  });
  const note = (o: Partial<PushableNotification> = {}): PushableNotification => ({
    id: "n".repeat(23) + Math.floor(Math.random() * 9), recipientId: "ada", recipientType: "STUDENT", departmentId: "d-csc", kind: "MATERIAL",
    title: "CSC201: new course material", body: "Week 4 slides", link: "/student/materials", complaintId: null, ...o,
  });
  const sub = (o: PushOwner, n: string) => svc.register(o, { endpoint: ep(n), keys: KEYS }, "Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36");
  return { store, sender, svc, warnings, note, sub };
}

/* ============================ classification + payload + validation ============================ */
test("1. Only the portal's academic and complaint events are pushed; everything else stays in-app", () => {
  const c = (kind: string, link?: string, complaintId?: string) => categoryOf({ kind, link, complaintId });
  assert.equal(c("ANNOUNCEMENT"), "announcements");
  assert.equal(c("MATERIAL"), "timetablesAndMaterials");
  assert.equal(c("TIMETABLE"), "timetablesAndMaterials");
  assert.equal(c("ASSIGNMENT"), "assignments");
  for (const k of ["SUBMITTED", "STATUS_CHANGED", "ASSIGNED", "RESOLVED", "INFO_REQUESTED", "RESPONSE"]) assert.equal(c(k), "complaints");
  assert.equal(c("SYSTEM", "/lecturer/complaints"), "complaints"); // "forwarded to you" is a SYSTEM-kind notification linking to complaints
  assert.equal(c("SYSTEM", "/student/complaints?id=1"), "complaints");
  assert.equal(c("SYSTEM", "/student/elections"), null); // elections: not in scope
  assert.equal(c("ATTENDANCE"), null);
  assert.equal(c("SYSTEM"), null);
});
test("2. Click destinations are safe in-app paths only", () => {
  for (const ok of ["/student/materials", "/lecturer/complaints", "/hod/complaints?status=ASSIGNED", "/student/courses/123#top"]) assert.equal(safePortalPath(ok), ok);
  for (const bad of ["https://evil.example", "//evil.example", "javascript:alert(1)", "/\\evil.example", "student/materials", "/a b", "/x\nSet-Cookie:1", "/redirect?to=https://evil.example", "/" + "a".repeat(250), "", null, undefined]) assert.equal(safePortalPath(bad as never), null, String(bad));
});
test("3. Only real browser push services are accepted as endpoints (no server-side request forgery)", () => {
  for (const ok of [ep("abc"), "https://updates.push.services.mozilla.com/wpush/v2/xyz", "https://web.push.apple.com/QAbc", "https://wns2-par02p.notify.windows.com/w/?token=x"]) assert.equal(isAllowedPushEndpoint(ok), true, ok);
  for (const bad of ["http://fcm.googleapis.com/fcm/send/a", "https://localhost/x", "https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data", "https://10.0.0.5/x", "https://fcm.googleapis.com.evil.example/x", "https://evilfcm.googleapis.com/x", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "ftp://fcm.googleapis.com/x", "not a url", "https://example.com/push"]) assert.equal(isAllowedPushEndpoint(bad), false, bad);
  assert.equal(isAllowedPushEndpoint("https://push.example.edu/x", ["push.example.edu"]), true); // configurable extension
  assert.equal(deviceLabelFrom("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537"), "Chrome on Windows");
  assert.equal(deviceLabelFrom("whatever", "  My phone "), "My phone");
});

/* ============================ registration ============================ */
test("4. Registering a device stores it for the authenticated user; views never expose keys or endpoints", async () => {
  const w = world();
  const v = await w.sub(stu("ada"), "d1");
  assert.deepEqual(Object.keys(v).sort(), ["active", "createdAt", "deviceLabel", "id", "lastUsedAt"]);
  assert.equal(v.deviceLabel, "Chrome on Windows");
  const json = JSON.stringify(await w.svc.listDevices(stu("ada")));
  assert.ok(!json.includes(KEYS.auth) && !json.includes("fcm.googleapis.com"));
  assert.deepEqual(w.svc.publicConfig(), { supported: true, publicKey: "P".repeat(87) });
});
test("5. One user, several devices; registering the same device again doesn't duplicate it", async () => {
  const w = world();
  await w.sub(stu("ada"), "phone"); await w.sub(stu("ada"), "laptop"); await w.sub(stu("ada"), "phone");
  assert.equal(w.store.rows.length, 2);
  assert.equal((await w.svc.listDevices(stu("ada"))).length, 2);
});
test("6. A browser now signed in as someone else is re-attached to them: the previous user stops receiving on it", async () => {
  const w = world();
  await w.sub(stu("ada"), "shared");
  await w.sub(stu("ben"), "shared");
  assert.equal(w.store.rows.length, 1);
  assert.equal(w.store.rows[0].userId, "ben");
  await w.svc.dispatch([w.note({ recipientId: "ada" })]);
  assert.equal(w.sender.sent.length, 0);
});
test("7. Removing a device: only the owner can, it's idempotent, and other devices keep working", async () => {
  const w = world();
  await w.sub(stu("ada"), "phone"); await w.sub(stu("ada"), "laptop");
  assert.deepEqual(await w.svc.unregister(stu("ben"), ep("phone")), { removed: false }); // someone else's device: untouched
  assert.equal(w.store.rows.length, 2);
  assert.deepEqual(await w.svc.unregister(stu("ada"), ep("phone")), { removed: true });
  assert.deepEqual(await w.svc.unregister(stu("ada"), ep("phone")), { removed: false }); // already gone: same harmless answer
  assert.equal(w.store.rows.length, 1);
  const id = w.store.rows[0].id;
  assert.equal((await rejection(w.svc.unregisterById(stu("ben"), id))).status, 404);
  await w.svc.unregisterById(stu("ada"), id);
  assert.equal(w.store.rows.length, 0);
  // a student id can't remove a lecturer's device with the same id
  await w.sub(lec("x1"), "lecdev");
  assert.deepEqual(await w.svc.unregister(stu("x1"), ep("lecdev")), { removed: false });
});
test("8. Unsupported endpoints and an unconfigured server are refused; the device cap drops the oldest", async () => {
  const w = world();
  assert.equal((await rejection(w.svc.register(stu("ada"), { endpoint: "https://169.254.169.254/x", keys: KEYS }))).code, "UNSUPPORTED_PUSH_ENDPOINT");
  const off = world({ enabled: false });
  assert.deepEqual([(await rejection(off.sub(stu("ada"), "a"))).status, off.svc.publicConfig()], [503, { supported: false, publicKey: null }]);
  assert.deepEqual(await off.svc.dispatch([off.note()]), { attempted: 0, sent: 0, removed: 0, failed: 0, skippedByPreference: 0, notPushable: 0 });
  const capped = world({ max: 2 });
  let t = 0; (capped.svc as unknown as { d: { now: () => Date } }).d.now = () => new Date(NOW.getTime() + ++t * 1000);
  await capped.sub(stu("ada"), "d1"); await capped.sub(stu("ada"), "d2"); await capped.sub(stu("ada"), "d3");
  assert.deepEqual(capped.store.rows.map((r) => r.endpoint).sort(), [ep("d2"), ep("d3")]);
});

/* ============================ targeting + isolation ============================ */
test("9. A notification goes only to its recipient's devices (all of them), of the right user type and department", async () => {
  const w = world();
  await w.sub(stu("ada"), "a-phone"); await w.sub(stu("ada"), "a-laptop"); await w.sub(stu("ben"), "b-phone");
  await w.sub(lec("ada"), "lec-same-id"); // same raw id, different account type
  await w.sub(stu("ada", "d-mls"), "a-other-dept"); // registered under another department
  const s = await w.svc.dispatch([w.note({ recipientId: "ada" })]);
  assert.deepEqual(w.sender.sent.map((x) => x.endpoint).sort(), [ep("a-laptop"), ep("a-phone")]);
  assert.equal(s.sent, 2);
});
test("10. Complaint notifications reach only the participant they were stored for (HOD / assigned lecturer / student)", async () => {
  const w = world();
  await w.sub(hod("h1"), "hod"); await w.sub(lec("lecA"), "lecA"); await w.sub(lec("lecB"), "lecB"); await w.sub(stu("john"), "john");
  await w.svc.dispatch([w.note({ recipientId: "lecA", recipientType: "LECTURER", kind: "SYSTEM", link: "/lecturer/complaints", title: "Complaint forwarded" })]);
  assert.deepEqual(w.sender.sent.map((x) => x.endpoint), [ep("lecA")]);
  w.sender.sent.length = 0;
  await w.svc.dispatch([w.note({ recipientId: "h1", recipientType: "HOD", kind: "RESPONSE", link: "/hod/complaints" }), w.note({ recipientId: "john", kind: "STATUS_CHANGED", link: "/student/complaints" })]);
  assert.deepEqual(w.sender.sent.map((x) => x.endpoint).sort(), [ep("hod"), ep("john")]);
});
test("11. Large announcements are delivered in bounded rounds to every subscribed recipient", async () => {
  const w = world();
  for (let i = 0; i < 450; i++) await w.sub(stu(`s${i}`), `d${i}`);
  const items = Array.from({ length: 450 }, (_, i) => w.note({ id: String(i).padStart(24, "0"), recipientId: `s${i}`, kind: "ANNOUNCEMENT", title: "Departmental announcement", body: "Exam timetable out", link: "/student/announcements" }));
  const s = await w.svc.dispatch(items);
  assert.deepEqual([s.attempted, s.sent, w.sender.sent.length], [450, 450, 450]);
  assert.equal(new Set(w.sender.sent.map((x) => x.topic)).size, 450); // topic = notification id: the push service collapses a retried duplicate
});

/* ============================ lock-screen privacy ============================ */
test("12. Complaint pushes are generic: no reference, title, names or message text on the lock screen", async () => {
  const w = world();
  await w.sub(stu("john"), "john");
  await w.svc.dispatch([w.note({ recipientId: "john", kind: "RESPONSE", title: "Complaint CMP-CSC-2026-1: response from the HOD", body: "Your marks were wrongly keyed against matric 25/208CSC/987", link: "/student/complaints", complaintId: "c1" })]);
  const p = w.sender.sent[0].payload;
  assert.deepEqual([p.title, p.category, p.url], ["Complaint update", "complaints", "/student/complaints"]);
  const raw = JSON.stringify(p);
  for (const leak of ["CMP-CSC", "marks", "matric", "25/208", "HOD"]) assert.ok(!raw.includes(leak), leak);
});
test("13. Other pushes show the (public) title and a short body, a safe destination and a de-duplicating tag", () => {
  const n = { id: "a".repeat(24), recipientId: "ada", recipientType: "STUDENT" as const, departmentId: "d", kind: "ANNOUNCEMENT", title: "T".repeat(200), body: "B".repeat(400), link: "https://evil.example/phish" };
  const p = buildPushPayload(n, "announcements");
  assert.ok(p.title.length <= 80 && p.body.length <= 120);
  assert.deepEqual([p.url, p.tag], ["/student", "a".repeat(24)]); // unsafe link -> the user's own portal home
  assert.equal(buildPushPayload({ ...n, link: "/student/announcements" }, "announcements").url, "/student/announcements");
  assert.equal(buildPushPayload({ ...n, recipientType: "HOD", link: null }, "announcements").url, "/hod");
});

/* ============================ preferences ============================ */
test("14. Preferences: defaults on; a category off or the master switch off stops push but keeps devices", async () => {
  const w = world();
  await w.sub(stu("ada"), "d1");
  assert.deepEqual(await w.svc.getPreferences(stu("ada")), { pushEnabled: true, categories: { announcements: true, timetablesAndMaterials: true, assignments: true, complaints: true } });
  await w.svc.setPreferences(stu("ada"), { categories: { assignments: false } });
  let s = await w.svc.dispatch([w.note({ kind: "ASSIGNMENT", title: "CSC201: new assignment", link: "/student/assignments" }), w.note({ kind: "MATERIAL" })]);
  assert.deepEqual([s.skippedByPreference, s.sent, w.sender.sent[0].payload.category], [1, 1, "timetablesAndMaterials"]);
  await w.svc.setPreferences(stu("ada"), { pushEnabled: false });
  s = await w.svc.dispatch([w.note({ kind: "MATERIAL" })]);
  assert.deepEqual([s.skippedByPreference, s.sent], [1, 0]);
  assert.equal(w.store.rows.length, 1); // the device registration survives
  await w.svc.setPreferences(stu("ada"), { pushEnabled: true });
  assert.equal((await w.svc.dispatch([w.note({ kind: "MATERIAL" })])).sent, 1);
  assert.equal((await w.svc.getPreferences(stu("ada"))).categories.assignments, false); // earlier choice kept
  assert.equal((await w.svc.getPreferences(stu("ben"))).pushEnabled, true); // per-user
});
test("15. Preference changes can't touch in-app history: push preferences have no notification storage at all", () => {
  const src = strip(read("src/services/push/mongo-store.ts")) + strip(read("src/services/push/push.service.ts"));
  assert.ok(!/models\/Notification"|Notification\.(delete|update|find)/.test(src.replace(/NotificationPreference/g, "")), "push code never reads or deletes in-app notifications");
});

/* ============================ failures + expiry ============================ */
test("16. Expired subscriptions (404 / 410) are removed; other devices of the same user still get the message", async () => {
  const w = world();
  await w.sub(stu("ada"), "gone"); await w.sub(stu("ada"), "ok"); await w.sub(stu("ada"), "missing");
  w.sender.failWith.set(ep("gone"), 410); w.sender.failWith.set(ep("missing"), 404);
  const s = await w.svc.dispatch([w.note()]);
  assert.deepEqual([s.sent, s.removed, s.failed], [1, 2, 0]);
  assert.deepEqual(w.store.rows.map((r) => r.endpoint), [ep("ok")]);
});
test("17. Provider errors never throw; they are counted, and a device is deactivated after repeated failures (re-registering reactivates it)", async () => {
  const w = world();
  await w.sub(stu("ada"), "flaky");
  w.sender.failWith.set(ep("flaky"), 503);
  for (let i = 0; i < 5; i++) assert.equal((await w.svc.dispatch([w.note()])).failed, 1);
  assert.equal(w.store.rows[0].active, false);
  assert.equal((await w.svc.dispatch([w.note()])).attempted, 0); // no more attempts while inactive
  assert.equal(w.store.rows.length, 1); // kept, not deleted
  w.sender.failWith.clear();
  await w.sub(stu("ada"), "flaky");
  assert.deepEqual([w.store.rows[0].active, w.store.rows[0].failureCount, (await w.svc.dispatch([w.note()])).sent], [true, 0, 1]);
  assert.ok(w.warnings.length >= 5 && !JSON.stringify(w.warnings).includes("fcm.googleapis")); // logs never contain endpoints or keys
});
test("18. A success resets the failure count; plain network errors (no status) count as failures too", async () => {
  const w = world();
  await w.sub(stu("ada"), "d");
  w.sender.failWith.set(ep("d"), 0);
  await w.svc.dispatch([w.note()]); await w.svc.dispatch([w.note()]);
  assert.equal(w.store.rows[0].failureCount, 2);
  w.sender.failWith.clear();
  await w.svc.dispatch([w.note()]);
  assert.equal(w.store.rows[0].failureCount, 0);
});
test("19. dispatchSafely never rejects, even if the transport or the store blows up: the original action can't be affected", async () => {
  const w = world();
  await w.sub(stu("ada"), "d");
  w.sender.throwAll = true;
  assert.equal((await w.svc.dispatchSafely([w.note()])).failed, 1);
  w.store.deliverableFor = async () => { throw new Error("db down"); };
  const s = await w.svc.dispatchSafely([w.note()]);
  assert.equal(s.sent, 0);
  assert.ok(w.warnings.some((a) => String(a[0]).includes("Push dispatch failed")));
});
test("20. 'Send me a test' reaches the caller's own devices only", async () => {
  const w = world();
  await w.sub(stu("ada"), "a1"); await w.sub(stu("ada"), "a2"); await w.sub(stu("ben"), "b1");
  const r = await w.svc.sendTest(stu("ada"));
  assert.deepEqual([r.devices, r.sent], [2, 2]);
  assert.deepEqual(w.sender.sent.map((x) => x.endpoint).sort(), [ep("a1"), ep("a2")]);
});

/* ============================ deadline reminders ============================ */
test("21. Deadline reminders: only the window, only students who haven't submitted, one key per assignment and window", () => {
  const due = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
  assert.deepEqual([isInReminderWindow(due(5), NOW), isInReminderWindow(due(24), NOW), isInReminderWindow(due(25), NOW), isInReminderWindow(due(-1), NOW)], [true, true, false, false]);
  assert.deepEqual(studentsToRemind(["a", "b", "c", "a"], ["b"]), ["a", "c"]);
  assert.equal(reminderKey("A1"), reminderKey("A1"));
  assert.notEqual(reminderKey("A1"), reminderKey("A2"));
  assert.notEqual(reminderKey("A1", 24), reminderKey("A1", 2));
  assert.deepEqual(reminderText("CSC201", "Lab 3", due(5), NOW), { title: "CSC201: assignment due soon", body: "Lab 3 is due in about 5 hours." });
  assert.equal(reminderText("CSC201", "Lab 3", new Date(NOW.getTime() + 60_000), NOW).body, "Lab 3 is due in about 1 hour.");
});

/* ============================ service worker ============================ */
function loadSw() {
  const listeners: Record<string, (e: unknown) => void> = {}, shown: { title: string; options: Record<string, unknown> }[] = [], opened: string[] = [], messages: unknown[] = [];
  const windows: { url: string; focus: () => Promise<void>; navigate?: (u: string) => Promise<void>; postMessage: (m: unknown) => void; navigated?: string; focused?: boolean }[] = [];
  const self = {
    location: { origin: "https://portal.example.edu" },
    skipWaiting: () => undefined,
    addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; },
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
    clients: { claim: async () => undefined, matchAll: async () => windows, openWindow: async (u: string) => void opened.push(u) },
  };
  vm.runInNewContext(read("frontend-push/sw.js"), { self, URL, console });
  const fire = async (type: string, event: Record<string, unknown>) => { const waits: Promise<unknown>[] = []; listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) }); await Promise.all(waits); };
  return { fire, shown, opened, windows, messages, listeners };
}
test("22. Service worker: shows the pushed notification and always shows something (even for a broken payload)", async () => {
  const sw = loadSw();
  await sw.fire("push", { data: { json: () => ({ title: "CSC201: new course material", body: "Week 4 slides", url: "/student/materials", tag: "n1" }) } });
  assert.deepEqual([sw.shown[0].title, sw.shown[0].options.body, sw.shown[0].options.tag, (sw.shown[0].options.data as { url: string }).url], ["CSC201: new course material", "Week 4 slides", "n1", "/student/materials"]);
  await sw.fire("push", { data: { json: () => { throw new Error("not json"); } } });
  await sw.fire("push", {});
  assert.deepEqual(sw.shown.slice(1).map((s) => s.title), ["Departmental Portal", "Departmental Portal"]);
  await sw.fire("push", { data: { json: () => ({ title: "x", url: "https://evil.example/phish" }) } });
  assert.equal((sw.shown[3].options.data as { url: string }).url, "/"); // an external destination is neutralised at display time too
});
test("23. Notification click: focuses and navigates an open portal tab, otherwise opens the destination; external URLs never open", async () => {
  const sw = loadSw();
  let closed = 0;
  const click = (url: string) => sw.fire("notificationclick", { notification: { close: () => closed++, data: { url } } });
  await click("/student/materials");
  assert.deepEqual(sw.opened, ["/student/materials"]);
  const tab = { url: "https://portal.example.edu/student", focused: false, navigated: "", focus: async () => { tab.focused = true; }, navigate: async (u: string) => { tab.navigated = u; }, postMessage: () => undefined };
  sw.windows.push(tab);
  await click("/lecturer/complaints");
  assert.deepEqual([tab.focused, tab.navigated, sw.opened.length], [true, "/lecturer/complaints", 1]);
  await click("https://evil.example/x"); await click("//evil.example");
  assert.deepEqual([tab.navigated, closed], ["/", 4]);
  sw.windows.length = 0; sw.windows.push({ ...tab, url: "https://evil.example/", focus: async () => { throw new Error("must not touch foreign windows"); }, postMessage: () => undefined });
  await click("/hod/complaints");
  assert.equal(sw.opened.at(-1), "/hod/complaints");
});
test("24. A rotated / expired subscription asks open portal tabs to re-register", async () => {
  const sw = loadSw();
  const got: unknown[] = [];
  sw.windows.push({ url: "https://portal.example.edu/", focus: async () => undefined, postMessage: (m) => void got.push(m) });
  await sw.fire("pushsubscriptionchange", {});
  assert.equal(JSON.stringify(got), JSON.stringify([{ type: "PUSH_SUBSCRIPTION_CHANGED" }])); // (objects from the vm sandbox have another prototype)
});

/* ============================ wiring / surface guards ============================ */
test("25. Push endpoints exist for student, lecturer and HOD, each behind that API's own auth; identity never comes from the request", () => {
  const rows = [["src/routes/student.routes.ts", "authenticateStudent"], ["src/routes/lecturer.routes.ts", "...lec"], ["src/routes/hod.routes.ts", "...hod"]] as const;
  for (const [file, auth] of rows) {
    const lines = read(file).split("\n").filter((l) => /router\.\w+\("\/push\//.test(l));
    assert.equal(lines.length, 8, file);
    for (const l of lines) assert.ok(l.includes(auth), `${file}: ${l.slice(0, 70)}`);
    for (const l of lines.filter((x) => /router\.(post|put|delete)\(/.test(x))) assert.ok(/PushLimiter/.test(l), `rate limited: ${l.slice(0, 60)}`);
  }
  const v = strip(read("src/validators/push.validators.ts"));
  assert.ok(!/userId|userType|departmentId|recipient|studentId|lecturerId/.test(v), "no identity fields in push schemas");
  assert.equal((v.match(/\.strict\(\)/g) ?? []).length >= 6, true);
  const ctl = strip(read("src/controllers/push.controller.ts"));
  assert.ok(!/req\.(body|query|params)\.(userId|departmentId|userType)/.test(ctl));
});
test("26. The VAPID private key is read in exactly one place and never returned or logged", () => {
  const users = ["src", "tests"].flatMap((d) => (fs.readdirSync(path.resolve(__dirname, "..", d), { recursive: true }) as string[]).map((f) => `${d}/${f}`))
    .filter((f) => f.endsWith(".ts") && !f.startsWith("tests/")).filter((f) => read(f).includes("VAPID_PRIVATE_KEY") || /privateKey/.test(strip(read(f))));
  assert.deepEqual(users.sort(), ["src/config/env.ts", "src/services/push/index.ts", "src/services/push/sender.ts"].sort());
  assert.deepEqual(Object.keys(world().svc.publicConfig()).sort(), ["publicKey", "supported"]);
  assert.ok(!/privateKey|VAPID_PRIVATE/.test(read("frontend-push/sw.js") + read("frontend-push/push-client.js")));
});
test("27. notify() saves first, then fires push without awaiting it; keyed notifications are idempotent", () => {
  const src = strip(read("src/services/notification.service.ts"));
  const body = src.slice(src.indexOf("export async function notify"), src.indexOf("const dto"));
  assert.ok(body.indexOf("insertMany") < body.indexOf("dispatchPushSafely"), "in-app save happens before push");
  assert.ok(!/await\s+dispatchPushSafely/.test(body), "push is never awaited");
  assert.match(body, /catch \(err\)/); // the whole step is still best-effort
  assert.match(body, /upsert: true/);
  assert.match(strip(read("src/models/Notification.ts")), /dedupeKey: \{ \$type: "string" \}/);
  assert.match(strip(read("src/services/push/index.ts")), /setImmediate/);
  assert.match(strip(read("src/services/push/deadline-reminders.ts")), /dedupeKey: reminderKey/);
});
test("28. Existing workflows still notify through the single notify() path (nothing bypasses it), and Campus features are not referenced", () => {
  const offenders = (fs.readdirSync(path.resolve(__dirname, "../src"), { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"))
    .filter((f) => /Notification\.(insertMany|create)\(/.test(read(`src/${f}`)) && !f.endsWith("notification.service.ts") && !f.includes("seed"));
  assert.deepEqual(offenders, []);
  const pushFiles = ["src/services/push", "frontend-push"].flatMap((d) => (fs.readdirSync(path.resolve(__dirname, "..", d)) as string[]).map((f) => `${d}/${f}`));
  for (const f of pushFiles) assert.ok(!/campus\s*(hub|market)/i.test(read(f)), f);
});

async function rejection(p: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try { await p; } catch (e) { const x = e as { statusCode?: number; code?: string }; return { status: x.statusCode ?? 0, code: x.code }; }
  throw new Error("Expected rejection");
}
