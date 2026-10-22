import { test } from "node:test";
import assert from "node:assert/strict";
import { distanceMeters, isValidLatitude, isValidLongitude } from "../src/services/attendance/geo";
import { detectSuspicion } from "../src/services/attendance/suspicion";
import type { SecurityLogRec } from "../src/services/attendance/types";

test("haversine distance is about right", () => {
  const d = distanceMeters({ latitude: 6.5244, longitude: 3.3792 }, { latitude: 6.5334, longitude: 3.3792 });
  assert.ok(d > 990 && d < 1010, `got ${d}`); // 0.009 deg lat ~ 1 km
  assert.equal(Math.round(distanceMeters({ latitude: 1, longitude: 1 }, { latitude: 1, longitude: 1 })), 0);
});
test("coordinate validation rejects NaN, strings and out-of-range values", () => {
  assert.equal(isValidLatitude(91), false);
  assert.equal(isValidLatitude(Number.NaN), false);
  assert.equal(isValidLatitude("6.5" as unknown), false);
  assert.equal(isValidLongitude(-181), false);
  assert.equal(isValidLatitude(6.5) && isValidLongitude(3.4), true);
});

const T = new Date("2026-10-10T10:00:00Z");
const log = (over: Partial<SecurityLogRec>): SecurityLogRec => ({
  action: "MARK", outcome: "REJECTED", studentId: "a", departmentId: "d", ip: "1.1.1.1", flagged: false, flags: [], at: T, ...over,
});
test("suspicion: same IP alone is never a flag", () => {
  const recent = Array.from({ length: 50 }, (_, i) => log({ studentId: `s${i}`, ip: "9.9.9.9", outcome: "SUCCESS" }));
  assert.deepEqual(detectSuspicion(log({ studentId: "z", ip: "9.9.9.9", reason: "NOT_ENROLLED" }), recent, T), []);
});
test("suspicion: burst failures", () => {
  const recent = Array.from({ length: 4 }, () => log({ reason: "NOT_ENROLLED" }));
  assert.deepEqual(detectSuspicion(log({ reason: "NOT_ENROLLED" }), recent, T), ["REPEATED_FAILURES"]);
});
