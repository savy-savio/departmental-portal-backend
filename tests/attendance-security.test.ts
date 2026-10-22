import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "../src/utils/crypto";
import { CSC, FAR, MLS, NEAR, actor, config, makeWorld, meta, rejection } from "./helpers/world";

const OTHER_STUDENT_MSG = "Attendance cannot be marked from this device because it is registered to another student.";

/** Alice + Bob are enrolled in CSC201, each with her/his own registered phone. */
async function classroom() {
  const w = makeWorld();
  w.enroll("alice", CSC, ["CSC201"]);
  w.enroll("bob", CSC, ["CSC201"]);
  const session = w.makeSession();
  const alicePhone = (await w.registerDevice("alice")).deviceToken;
  const bobPhone = (await w.registerDevice("bob")).deviceToken;
  return { ...w, session, alicePhone, bobPhone };
}

/* 1 */
test("1. Student A marks attendance normally -> SUCCESS (and device token is never stored raw)", async () => {
  const w = await classroom();
  const res = await w.attend("alice", w.session.id, w.alicePhone);
  assert.equal(res.status, "PRESENT");
  assert.equal(res.locationVerified, true);
  assert.equal(w.store.records.length, 1);
  // The raw token is not in the database; only its SHA-256 hash is.
  assert.ok(w.store.devices.every((d) => d.tokenHash !== w.alicePhone));
  assert.ok(w.store.devices.some((d) => d.tokenHash === sha256(w.alicePhone)));
});

/* 2 */
test("2. Student A marks twice -> REJECTED (also at the database-level uniqueness)", async () => {
  const w = await classroom();
  await w.attend("alice", w.session.id, w.alicePhone);
  const again = await rejection(w.attend("alice", w.session.id, w.alicePhone));
  assert.equal(again.code, "ALREADY_MARKED");
  assert.equal(again.status, 409);
  assert.equal(w.store.records.length, 1);

  // Even if the engine's pre-check were bypassed (a race), the store's unique index refuses the 2nd row.
  const ch = { sessionId: w.session.id, studentId: "alice" };
  await assert.rejects(() =>
    w.store.createRecord({ ...ch, departmentId: CSC, courseCode: "CSC201", markedAt: new Date(), status: "PRESENT", deviceId: "x", ip: "1.1.1.1" }),
  );
});

/* 3 */
test("3a. Student B logged into A's account on B's OWN phone -> REJECTED (B's phone is bound to B)", async () => {
  const w = await classroom();
  // B knows A's password and signs in as A, but is holding B's phone (with B's device token).
  const r = await rejection(w.attend("alice", w.session.id, w.bobPhone));
  assert.equal(r.code, "DEVICE_BOUND_TO_OTHER_STUDENT");
  assert.equal(r.message, OTHER_STUDENT_MSG);
  assert.equal(w.store.records.length, 0);
});
test("3b. Without A's password, B can't even start device setup for A (normal authentication still applies)", async () => {
  const w = makeWorld();
  w.enroll("alice", CSC, ["CSC201"]);
  const r = await rejection(w.svc.requestDeviceVerification(actor("alice"), meta(), "guessed-password"));
  assert.equal(r.code, "PASSWORD_INCORRECT");
  assert.equal(w.sentCodes.length, 0); // no code is even emailed
});
test("3c. Knowing A's password is not enough to bind a new device to A: the emailed code is also needed", async () => {
  const w = makeWorld();
  await w.svc.requestDeviceVerification(actor("alice"), meta(), "pw-alice");
  const r = await rejection(w.svc.completeDeviceRegistration(actor("alice"), meta(), { code: "000000" }));
  assert.equal(r.code, "VERIFICATION_CODE_INCORRECT");
  assert.equal(w.store.devices.length, 0);
});

/* 4 */
test("4. A logs out, B logs in on A's phone -> REJECTED: device is bound to A", async () => {
  const w = await classroom();
  await w.attend("alice", w.session.id, w.alicePhone);
  // New login for B, but the phone still carries A's device token.
  const r = await rejection(w.attend("bob", w.session.id, w.alicePhone));
  assert.equal(r.status, 403);
  assert.equal(r.code, "DEVICE_BOUND_TO_OTHER_STUDENT");
  assert.equal(r.message, OTHER_STUDENT_MSG);
  assert.equal(w.store.records.filter((x) => x.studentId === "bob").length, 0);
  // ...and the attempt is flagged for investigators.
  const log = w.store.logs.find((l) => l.reason === "DEVICE_BOUND_TO_OTHER_STUDENT")!;
  assert.equal(log.flagged, true);
  assert.ok(log.flags.includes("DEVICE_SHARING_ATTEMPT"));
});
test("4b. B also cannot REGISTER A's phone as his own attendance device", async () => {
  const w = await classroom();
  const r = await rejection(w.svc.requestDeviceVerification(actor("mia"), meta(), "pw-mia", w.alicePhone));
  assert.equal(r.code, "DEVICE_BOUND_TO_OTHER_STUDENT");
});

/* 5 */
test("5. Student B on B's own registered device -> SUCCESS", async () => {
  const w = await classroom();
  await w.attend("alice", w.session.id, w.alicePhone);
  const res = await w.attend("bob", w.session.id, w.bobPhone);
  assert.equal(res.status, "PRESENT");
});

/* 6 */
test("6. Two students on the same Wi-Fi / public IP can both attend (IP is not identity)", async () => {
  const w = await classroom();
  const sameWifi = "102.89.1.1";
  assert.equal((await w.attend("alice", w.session.id, w.alicePhone, NEAR, sameWifi)).status, "PRESENT");
  assert.equal((await w.attend("bob", w.session.id, w.bobPhone, NEAR, sameWifi)).status, "PRESENT");
  assert.deepEqual(w.store.records.map((r) => r.ip), [sameWifi, sameWifi]); // IP recorded for audit only
});

/* 7 */
test("7. Outside the radius -> REJECTED; the distance is computed by the server", async () => {
  const w = await classroom();
  const r = await rejection(w.attend("alice", w.session.id, w.alicePhone, FAR));
  assert.equal(r.code, "LOCATION_OUTSIDE_RADIUS");
  assert.equal(w.store.records.length, 0);
  const log = w.store.logs.find((l) => l.reason === "LOCATION_OUTSIDE_RADIUS")!;
  assert.equal(log.location?.withinRadius, false);
  assert.ok((log.location?.distanceMeters ?? 0) > 2000);
});
test("7a. A session with no GPS location configured is refused (fail closed), for challenge and mark", async () => {
  const w = await classroom();
  const noLoc = w.makeSession({ location: undefined });
  assert.equal((await rejection(w.attend("alice", noLoc.id, w.alicePhone))).code, "SESSION_LOCATION_NOT_CONFIGURED");
  assert.equal(w.store.records.length, 0);
});
test("7a2. The outside-radius message is the agreed one, and the radius is per session (not a global constant)", async () => {
  const w = await classroom();
  const tight = w.makeSession({ location: { latitude: NEAR.latitude, longitude: NEAR.longitude, allowedRadiusInMeters: 5 } });
  const wide = w.makeSession({ location: { latitude: FAR.latitude, longitude: FAR.longitude, allowedRadiusInMeters: 5000 } });
  const far = { latitude: NEAR.latitude + 0.0003, longitude: NEAR.longitude };
  const told = await rejection(w.attend("alice", tight.id, w.alicePhone, far)); // by default the student is told how far away they appeared to be
  assert.match(told.message, /You appear to be about \d+ m from the attendance location \(allowed: 5 m\)/);
  (w.svc as unknown as { d: { config: object } }).d.config = { ...config, showDistance: false }; // ATTENDANCE_SHOW_DISTANCE=false keeps the old generic wording
  assert.equal((await rejection(w.attend("alice", tight.id, w.alicePhone, far))).message, "You are outside the allowed attendance location.");
  assert.equal((await w.attend("alice", wide.id, w.alicePhone, NEAR)).status, "PRESENT"); // ~2.2 km away is inside a 5 km radius
});
test("7b. Missing coordinates, or a very inaccurate GPS fix, are rejected too", async () => {
  const w = await classroom();
  const ch = await w.svc.createChallenge(actor("alice"), meta(), w.session.id, w.alicePhone);
  const none = await rejection(w.svc.markAttendance(actor("alice"), meta(), w.session.id, w.alicePhone, { attendanceToken: ch.attendanceToken }));
  assert.equal(none.code, "LOCATION_REQUIRED");
  const weak = await rejection(w.svc.markAttendance(actor("alice"), meta(), w.session.id, w.alicePhone, { attendanceToken: ch.attendanceToken, ...NEAR, accuracyMeters: 900 }));
  assert.equal(weak.code, "LOCATION_ACCURACY_LOW");
  // The failed tries did not burn the token, so an honest retry still works.
  const ok = await w.svc.markAttendance(actor("alice"), meta(), w.session.id, w.alicePhone, { attendanceToken: ch.attendanceToken, ...NEAR, accuracyMeters: 12 });
  assert.equal(ok.status, "PRESENT");
});

/* 8 */
test("8. After the session closes -> REJECTED (both challenge and mark)", async () => {
  const w = await classroom();
  const ch = await w.svc.createChallenge(actor("alice"), meta(), w.session.id, w.alicePhone);
  w.clock.now = new Date("2026-10-10T12:00:01Z");
  const mark = await rejection(w.svc.markAttendance(actor("alice"), meta(), w.session.id, w.alicePhone, { attendanceToken: ch.attendanceToken, ...NEAR }));
  assert.equal(mark.code, "SESSION_CLOSED");
  const chal = await rejection(w.svc.createChallenge(actor("alice"), meta(), w.session.id, w.alicePhone));
  assert.equal(chal.code, "SESSION_CLOSED");
});
test("8b. Before it opens, and when closed early by the lecturer -> REJECTED", async () => {
  const w = await classroom();
  const early = w.makeSession({ opensAt: new Date("2026-10-10T11:00:00Z") });
  assert.equal((await rejection(w.attend("alice", early.id, w.alicePhone))).code, "SESSION_NOT_OPEN");
  const closed = w.makeSession({ status: "CLOSED" });
  assert.equal((await rejection(w.attend("alice", closed.id, w.alicePhone))).code, "SESSION_CLOSED");
});

/* 9 */
test("9. Student not enrolled in the course -> REJECTED", async () => {
  const w = await classroom();
  w.enroll("carl", CSC, ["MTH201"]); // registered for something else
  w.passwords.set("carl", "pw-carl");
  const phone = (await w.registerDevice("carl")).deviceToken;
  const r = await rejection(w.attend("carl", w.session.id, phone));
  assert.equal(r.code, "NOT_ENROLLED");
});

/* 10 */
test("10a. Another department's session id is simply 'not found' (department scope)", async () => {
  const w = await classroom();
  w.enroll("mia", MLS, ["MLS201"]);
  const phone = (await w.registerDevice("mia", MLS)).deviceToken;
  const r = await rejection(w.attend("mia", w.session.id, phone, NEAR, "41.58.0.10", MLS)); // CSC session, MLS student
  assert.equal(r.code, "SESSION_NOT_FOUND");
  assert.equal(r.status, 404);
});
test("10b. Unknown, malformed or other people's device ids can't be used (the client never names a student or device)", async () => {
  const w = await classroom();
  assert.equal((await rejection(w.attend("alice", w.session.id, "f".repeat(64)))).code, "DEVICE_UNRECOGNISED");
  assert.equal((await rejection(w.attend("alice", w.session.id, "not-a-token"))).code, "DEVICE_UNRECOGNISED");
  assert.equal((await rejection(w.attend("alice", w.session.id, undefined))).code, "DEVICE_NOT_REGISTERED");
  // A device's database id (or its hash) is not a credential.
  const aliceDevice = w.store.devices.find((d) => d.studentId === "alice")!;
  assert.equal((await rejection(w.attend("bob", w.session.id, aliceDevice.id))).code, "DEVICE_UNRECOGNISED");
  assert.equal((await rejection(w.attend("bob", w.session.id, aliceDevice.tokenHash))).code, "DEVICE_UNRECOGNISED");
});
test("10c. Someone else's attendance token can't be used (bound to student + device + session)", async () => {
  const w = await classroom();
  const aliceToken = (await w.svc.createChallenge(actor("alice"), meta(), w.session.id, w.alicePhone)).attendanceToken;
  // Bob tries to redeem Alice's token from his own (legitimate) phone.
  const r = await rejection(w.svc.markAttendance(actor("bob"), meta(), w.session.id, w.bobPhone, { attendanceToken: aliceToken, ...NEAR }));
  assert.equal(r.code, "ATTENDANCE_TOKEN_INVALID");
  // And a token for session 1 can't be used on session 2.
  const s2 = w.makeSession();
  const r2 = await rejection(w.svc.markAttendance(actor("alice"), meta(), s2.id, w.alicePhone, { attendanceToken: aliceToken, ...NEAR }));
  assert.equal(r2.code, "ATTENDANCE_TOKEN_INVALID");
});

/* 11 */
test("11a. Expired attendance token -> REJECTED", async () => {
  const w = await classroom();
  const ch = await w.svc.createChallenge(actor("alice"), meta(), w.session.id, w.alicePhone);
  w.clock.now = new Date(w.clock.now.getTime() + 91_000);
  const r = await rejection(w.svc.markAttendance(actor("alice"), meta(), w.session.id, w.alicePhone, { attendanceToken: ch.attendanceToken, ...NEAR }));
  assert.equal(r.code, "ATTENDANCE_TOKEN_INVALID");
});
test("11b. Replayed token -> REJECTED (single use)", async () => {
  const w = await classroom();
  const ch = await w.svc.createChallenge(actor("alice"), meta(), w.session.id, w.alicePhone);
  const first = await w.svc.markAttendance(actor("alice"), meta(), w.session.id, w.alicePhone, { attendanceToken: ch.attendanceToken, ...NEAR });
  assert.equal(first.status, "PRESENT");
  const replay = await rejection(w.svc.markAttendance(actor("alice"), meta(), w.session.id, w.alicePhone, { attendanceToken: ch.attendanceToken, ...NEAR }));
  assert.equal(replay.code, "ALREADY_MARKED");
  // Token reuse can't create a second record either, nor mark a different session.
  assert.equal(w.store.records.length, 1);
  const s2 = w.makeSession();
  const other = await rejection(w.svc.markAttendance(actor("alice"), meta(), s2.id, w.alicePhone, { attendanceToken: ch.attendanceToken, ...NEAR }));
  assert.equal(other.code, "ATTENDANCE_TOKEN_INVALID");
});
test("11c. A made-up token is rejected", async () => {
  const w = await classroom();
  const r = await rejection(w.svc.markAttendance(actor("alice"), meta(), w.session.id, w.alicePhone, { attendanceToken: "a".repeat(64), ...NEAR }));
  assert.equal(r.code, "ATTENDANCE_TOKEN_INVALID");
});

/* 12 */
test("12. New phone: verified replacement revokes the old device and enables the new one", async () => {
  const w = await classroom();
  const oldPhone = w.alicePhone;

  // Requesting verification from the new phone (no token yet) does not by itself change anything.
  await w.svc.requestDeviceVerification(actor("alice"), meta(), "pw-alice", undefined);
  assert.equal(w.sentCodes[w.sentCodes.length - 1].purpose, "REPLACE");
  assert.equal(w.store.devices.filter((d) => d.studentId === "alice" && d.status === "ACTIVE").length, 1);

  // Wrong code first, then the right one.
  assert.equal((await rejection(w.svc.completeDeviceRegistration(actor("alice"), meta(), { code: "123456" }))).code, "VERIFICATION_CODE_INCORRECT");
  const code = w.sentCodes[w.sentCodes.length - 1].code;
  const res = await w.svc.completeDeviceRegistration(actor("alice"), meta(), { code, label: "New phone" });
  assert.equal(res.replaced, true);

  // Old phone is now useless for attendance; the new one works.
  assert.equal((await rejection(w.attend("alice", w.session.id, oldPhone))).code, "DEVICE_REVOKED");
  assert.equal((await w.attend("alice", w.session.id, res.deviceToken)).status, "PRESENT");
  assert.equal(w.store.devices.filter((d) => d.studentId === "alice" && d.status === "ACTIVE").length, 1);
});
test("12b. The old phone, once released, can be claimed by someone else; an ACTIVE one cannot", async () => {
  const w = await classroom();
  const oldPhone = w.alicePhone;
  await w.registerDevice("alice"); // Alice replaces her device -> old phone revoked
  w.passwords.set("mia", "pw-mia");
  await w.svc.requestDeviceVerification(actor("mia"), meta(), "pw-mia", oldPhone); // allowed: that phone is no longer anyone's
  assert.equal(w.sentCodes[w.sentCodes.length - 1].purpose, "REGISTER");
});
test("12c. Codes expire, lock after too many wrong tries, and work only once", async () => {
  const w = makeWorld();
  await w.svc.requestDeviceVerification(actor("alice"), meta(), "pw-alice");
  const code = w.sentCodes[0].code;
  w.clock.now = new Date(w.clock.now.getTime() + 11 * 60_000);
  assert.equal((await rejection(w.svc.completeDeviceRegistration(actor("alice"), meta(), { code }))).code, "VERIFICATION_EXPIRED");

  w.clock.now = new Date("2026-10-10T10:00:00Z");
  await w.svc.requestDeviceVerification(actor("alice"), meta(), "pw-alice");
  const good = w.sentCodes[1].code;
  for (let i = 0; i < 5; i++) await rejection(w.svc.completeDeviceRegistration(actor("alice"), meta(), { code: "999999" === good ? "999998" : "999999" }));
  assert.equal((await rejection(w.svc.completeDeviceRegistration(actor("alice"), meta(), { code: good }))).code, "VERIFICATION_LOCKED");

  await w.svc.requestDeviceVerification(actor("alice"), meta(), "pw-alice");
  const fresh = w.sentCodes[2].code;
  await w.svc.completeDeviceRegistration(actor("alice"), meta(), { code: fresh });
  assert.equal((await rejection(w.svc.completeDeviceRegistration(actor("alice"), meta(), { code: fresh }))).code, "VERIFICATION_NOT_FOUND");
});
test("12d. Phones can't be swapped endlessly: capped at 2 replacements per 30 days", async () => {
  const w = makeWorld();
  await w.registerDevice("alice");
  await w.registerDevice("alice"); // replacement 1
  await w.registerDevice("alice"); // replacement 2
  const r = await rejection(w.svc.requestDeviceVerification(actor("alice"), meta(), "pw-alice"));
  assert.equal(r.code, "DEVICE_CHANGE_LIMIT_REACHED");
  w.clock.now = new Date(w.clock.now.getTime() + 31 * 86_400_000);
  await w.svc.requestDeviceVerification(actor("alice"), meta(), "pw-alice"); // window passed
});
test("12e. Re-verifying the device you already use is refused (no pointless churn)", async () => {
  const w = await classroom();
  const r = await rejection(w.svc.requestDeviceVerification(actor("alice"), meta(), "pw-alice", w.alicePhone));
  assert.equal(r.code, "ALREADY_REGISTERED_DEVICE");
});

/* audit + suspicion */
test("every attempt (success and failure) leaves an audit record with IP, device, location and reason", async () => {
  const w = await classroom();
  await w.attend("alice", w.session.id, w.alicePhone, NEAR, "10.0.0.5");
  await rejection(w.attend("bob", w.session.id, w.alicePhone, NEAR, "10.0.0.6"));
  const ok = w.store.logs.find((l) => l.action === "MARK" && l.outcome === "SUCCESS")!;
  assert.equal(ok.ip, "10.0.0.5");
  assert.equal(ok.studentId, "alice");
  assert.equal(ok.courseCode, "CSC201");
  assert.ok(ok.deviceId && ok.deviceFingerprint);
  assert.equal(ok.location?.withinRadius, true);
  const bad = w.store.logs.find((l) => l.reason === "DEVICE_BOUND_TO_OTHER_STUDENT")!;
  assert.equal(bad.studentId, "bob");
  assert.equal(bad.ip, "10.0.0.6");
  assert.ok(bad.at instanceof Date);
});
test("one device used by two accounts, or repeated out-of-range tries, get flagged (but IP alone never does)", async () => {
  const w = await classroom();
  for (let i = 0; i < 3; i++) await rejection(w.attend("alice", w.session.id, w.alicePhone, FAR));
  const last = w.store.logs.filter((l) => l.reason === "LOCATION_OUTSIDE_RADIUS").pop()!;
  assert.ok(last.flags.includes("REPEATED_OUT_OF_RANGE"));

  await rejection(w.attend("bob", w.session.id, w.alicePhone));
  const shared = w.store.logs.filter((l) => l.reason === "DEVICE_BOUND_TO_OTHER_STUDENT").pop()!;
  assert.ok(shared.flags.includes("DEVICE_USED_BY_MULTIPLE_ACCOUNTS"));

  // 40 students behind one Wi-Fi never produce an IP-based flag.
  const w2 = makeWorld();
  const s = w2.makeSession();
  for (let i = 0; i < 40; i++) {
    const id = `s${i}`;
    w2.passwords.set(id, "pw");
    w2.enroll(id, CSC, ["CSC201"]);
    const phone = (await w2.registerDevice(id, CSC, undefined, "197.210.0.1")).deviceToken;
    assert.equal((await w2.attend(id, s.id, phone, NEAR, "197.210.0.1")).status, "PRESENT");
  }
  assert.equal(w2.store.logs.filter((l) => l.flagged).length, 0);
});
test("lateness is recorded relative to the session start", async () => {
  const w = await classroom();
  w.clock.now = new Date("2026-10-10T10:30:00Z"); // 35 min after opening, grace is 15
  assert.equal((await w.attend("alice", w.session.id, w.alicePhone)).status, "LATE");
});
test("multi-department: an MLS student with an MLS session works the same way", async () => {
  const w = makeWorld();
  w.passwords.set("zed", "pw-zed");
  w.enroll("zed", MLS, ["MLS201"]);
  const s = w.makeSession({ departmentId: MLS, courseCode: "MLS201", level: "200" });
  const phone = (await w.registerDevice("zed", MLS)).deviceToken;
  assert.equal((await w.attend("zed", s.id, phone, NEAR, "41.58.0.10", MLS)).status, "PRESENT");
});
