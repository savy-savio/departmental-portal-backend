import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateProximity } from "../src/services/attendance/geo";
import { CAMPUS, CSC, config, makeWorld, rejection } from "./helpers/world";
import { makeLecturerWorld, actor as lecturer } from "./helpers/lecturer-world";

/** A point `m` metres north of the venue (1 degree of latitude is about 111,195 m). */
const north = (m: number, accuracyMeters?: number) => ({ latitude: CAMPUS.latitude + m / 111_195, longitude: CAMPUS.longitude, ...(accuracyMeters !== undefined ? { accuracyMeters } : {}) });

async function classroom(opts: { radius?: number; venueAccuracy?: number; allowance?: number; showDistance?: boolean } = {}) {
  const w = makeWorld();
  (w.svc as unknown as { d: { config: object } }).d.config = { ...config, accuracyAllowanceMaxMeters: opts.allowance ?? 50, showDistance: opts.showDistance };
  w.enroll("alice", CSC, ["CSC201"]);
  const session = w.makeSession({ location: { ...CAMPUS, allowedRadiusInMeters: opts.radius ?? 30, ...(opts.venueAccuracy !== undefined ? { accuracyMeters: opts.venueAccuracy } : {}) } });
  const phone = (await w.registerDevice("alice")).deviceToken;
  return { ...w, session, phone };
}

/* ============================ the pure rule ============================ */
test("1. The radius is widened by the combined GPS uncertainty, never beyond the cap", () => {
  const e = (o: object) => evaluateProximity({ distanceMeters: 60, allowedRadiusInMeters: 30, maxAllowanceMeters: 50, ...o });
  assert.deepEqual(e({ distanceMeters: 50, studentAccuracyMeters: 15, venueAccuracyMeters: 10 }), { within: true, allowanceMeters: 25, effectiveRadiusMeters: 55 });
  assert.deepEqual(e({ distanceMeters: 56, studentAccuracyMeters: 15, venueAccuracyMeters: 10 }), { within: false, allowanceMeters: 25, effectiveRadiusMeters: 55 });
  assert.deepEqual(e({ studentAccuracyMeters: 100, venueAccuracyMeters: 100 }), { within: true, allowanceMeters: 50, effectiveRadiusMeters: 80 }); // capped at 50
  assert.equal(e({ distanceMeters: 81, studentAccuracyMeters: 100, venueAccuracyMeters: 100 }).within, false); // a claim of terrible accuracy can't stretch the area further
  assert.deepEqual(e({}), { within: false, allowanceMeters: 0, effectiveRadiusMeters: 30 }); // unknown accuracy = no allowance
  assert.equal(e({ studentAccuracyMeters: 40, venueAccuracyMeters: 40, maxAllowanceMeters: 0 }).effectiveRadiusMeters, 30); // 0 = the strict old rule
  for (const bad of [-5, Number.NaN, Infinity, undefined]) assert.equal(e({ studentAccuracyMeters: bad as number }).allowanceMeters, bad === Infinity ? 0 : 0);
  assert.equal(e({ distanceMeters: 30 }).within, true); // exactly on the edge is inside
});

/* ============================ two devices next to each other ============================ */
test("2. Two devices side by side that report positions ~55 m apart are accepted once GPS accuracy is taken into account", async () => {
  const w = await classroom({ radius: 30, venueAccuracy: 30 });
  // the lecturer's phone said "here" (30 m accuracy); the student's phone, a few steps away, says 55 m with 25 m accuracy
  const r = await w.attend("alice", w.session.id, w.phone, north(55, 25));
  assert.equal(r.status, "PRESENT");
  assert.equal(w.store.records[0].location?.distanceMeters, 55);
});
test("3. The same readings are rejected under the strict rule (the old behaviour) which is why it felt broken", async () => {
  const w = await classroom({ radius: 30, venueAccuracy: 30, allowance: 0 });
  assert.equal((await rejection(w.attend("alice", w.session.id, w.phone, north(55, 25)))).code, "LOCATION_OUTSIDE_RADIUS");
});
test("4. Someone genuinely far away is still rejected, however good the excuse", async () => {
  const w = await classroom({ radius: 30, venueAccuracy: 30 });
  for (const where of [north(300, 20), north(120, 100), north(81, 100)]) assert.equal((await rejection(w.attend("alice", w.session.id, w.phone, where))).code, "LOCATION_OUTSIDE_RADIUS");
  assert.equal(w.store.records.length, 0);
  assert.equal((await w.attend("alice", w.session.id, w.phone, north(79, 100))).status, "PRESENT"); // just inside the capped allowance (30 + 50)
});
test("5. No reported accuracy means no allowance; a hopeless accuracy is still refused outright", async () => {
  const w = await classroom({ radius: 30, venueAccuracy: 30 });
  assert.equal((await rejection(w.attend("alice", w.session.id, w.phone, north(65)))).code, "LOCATION_OUTSIDE_RADIUS"); // unknown student accuracy: only the venue's 30 m counts (30 + 30 = 60)
  assert.equal((await rejection(w.attend("alice", w.session.id, w.phone, north(10, 900)))).code, "LOCATION_ACCURACY_LOW");
  const old = await classroom({ radius: 30 }); // an older session without a venue accuracy: only the student's counts
  assert.equal((await old.attend("alice", old.session.id, old.phone, north(55, 30))).status, "PRESENT");
});

/* ============================ telling the student what happened ============================ */
test("6. A rejected student is told how far away they appeared and what was allowed; the exact distance stays in the audit log", async () => {
  const w = await classroom({ radius: 30, venueAccuracy: 20 });
  const r = await rejection(w.attend("alice", w.session.id, w.phone, north(147, 10)));
  assert.equal(r.code, "LOCATION_OUTSIDE_RADIUS");
  assert.match(r.message, /about 150 m from the attendance location \(allowed: 60 m\)/);
  assert.match(r.message, /near a window or outside/);
  assert.deepEqual(r.details, { distanceMeters: 150, allowedRadiusInMeters: 30, accuracyAllowanceMeters: 30, effectiveRadiusMeters: 60, yourAccuracyMeters: 10 });
  const log = w.store.logs.find((l) => l.reason === "LOCATION_OUTSIDE_RADIUS")!;
  assert.deepEqual([log.location?.distanceMeters, log.location?.withinRadius], [147, false]);
});
test("7. ATTENDANCE_SHOW_DISTANCE=false gives the generic message and no numbers", async () => {
  const w = await classroom({ radius: 30, showDistance: false, allowance: 0 });
  const r = await rejection(w.attend("alice", w.session.id, w.phone, north(200)));
  assert.equal(r.message, "You are outside the allowed attendance location.");
  assert.equal(r.details, undefined);
});

/* ============================ the lecturer's side ============================ */
test("8. The venue's accuracy is saved with the session and shown to the lecturer", async () => {
  const w = makeLecturerWorld();
  const created = await w.svc.createAttendanceSession(lecturer("lecA"), w.csc201.id, { latitude: 6.5, longitude: 3.4, allowedRadiusInMeters: 40, accuracyMeters: 18, durationMinutes: 60 });
  assert.equal((created as unknown as { venueAccuracyMeters: number }).venueAccuracyMeters, 18);
  assert.equal(w.store.sessions[0].location?.accuracyMeters, 18);
});
