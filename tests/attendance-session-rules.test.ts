import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeSessionCreator, validateSessionInput, type SessionInput } from "../src/services/attendance/session-rules";

const now = new Date("2026-10-10T08:00:00Z");
const input = (over: Partial<SessionInput> = {}): SessionInput => ({
  courseCode: "CSC201", title: "Week 3", opensAt: new Date("2026-10-10T09:00:00Z"), closesAt: new Date("2026-10-10T11:00:00Z"),
  location: { latitude: 6.5244, longitude: 3.3792, allowedRadiusInMeters: 100 }, ...over,
});

test("a sensible session validates", () => assert.deepEqual(validateSessionInput(input(), now), []));
test("bad windows, radius, coordinates and codes are refused", () => {
  assert.ok(validateSessionInput(input({ closesAt: new Date("2026-10-10T08:30:00Z"), opensAt: new Date("2026-10-10T09:00:00Z") }), now).length);
  assert.ok(validateSessionInput(input({ closesAt: new Date("2026-10-10T16:00:00Z") }), now).some((e) => /at most/.test(e)));
  assert.ok(validateSessionInput(input({ location: { latitude: 6.5, longitude: 3.4, allowedRadiusInMeters: 5 } }), now).some((e) => /radius/.test(e)));
  assert.ok(validateSessionInput(input({ location: { latitude: 99, longitude: 3.4, allowedRadiusInMeters: 100 } }), now).some((e) => /coordinates/.test(e)));
  assert.ok(validateSessionInput(input({ code: "no spaces!" }), now).some((e) => /code/.test(e)));
  assert.ok(validateSessionInput(input({ opensAt: new Date("2026-01-01T09:00:00Z"), closesAt: new Date("2026-01-01T10:00:00Z") }), now).some((e) => /already/.test(e)));
});
test("a CSC lecturer cannot open an MLS course; lecturers need assignment; HOD only inside own department", () => {
  const lecturer = { name: "Dr B", role: "LECTURER" as const, departmentId: "csc", assignedCourseCodes: ["CSC201"] };
  assert.equal(authorizeSessionCreator(lecturer, { departmentId: "csc", courseCode: "CSC201" }).ok, true);
  assert.equal(authorizeSessionCreator(lecturer, { departmentId: "csc", courseCode: "CSC203" }).ok, false); // not assigned
  assert.equal(authorizeSessionCreator(lecturer, { departmentId: "mls", courseCode: "MLS201" }).ok, false); // other department
  const hod = { name: "HOD", role: "HOD" as const, departmentId: "csc" };
  assert.equal(authorizeSessionCreator(hod, { departmentId: "csc", courseCode: "CSC203" }).ok, true);
  assert.equal(authorizeSessionCreator(hod, { departmentId: "mls", courseCode: "MLS201" }).ok, false); // no cross-department HOD
  // Representatives never open attendance, even if somehow "assigned" to the course
  for (const role of ["COURSE_REP", "ASSISTANT_COURSE_REP", "SUPER_ADMIN", "STUDENT"]) {
    assert.equal(authorizeSessionCreator({ role, departmentId: "csc", assignedCourseCodes: ["CSC201"] }, { departmentId: "csc", courseCode: "CSC201" }).ok, false, role);
  }
});
