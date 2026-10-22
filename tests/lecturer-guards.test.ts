import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { authorizeLecturerAdmin, checkLecturerAssignmentRules, isLecturerAssignmentCurrent } from "../src/services/lecturer/policy";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const routes = (file: string) => [...read(file).matchAll(/router\.(get|post|patch|delete|put)\(\s*"([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`).sort();

test("an assignment counts only while ACTIVE, for this lecturer, in this department, in the current term", () => {
  const a = { lecturerId: "l", departmentId: "d", academicSession: "2026/2027", semester: "FIRST" as const, status: "ACTIVE" as const };
  const actor = { lecturerId: "l", departmentId: "d" };
  const term = { academicSession: "2026/2027", semester: "FIRST" as const };
  assert.equal(isLecturerAssignmentCurrent(a, actor, term), true);
  for (const bad of [{ ...a, status: "REVOKED" as const }, { ...a, status: "INACTIVE" as const }]) assert.equal(isLecturerAssignmentCurrent(bad, actor, term), false);
  assert.equal(isLecturerAssignmentCurrent(a, { ...actor, lecturerId: "x" }, term), false);
  assert.equal(isLecturerAssignmentCurrent(a, { ...actor, departmentId: "x" }, term), false);
  assert.equal(isLecturerAssignmentCurrent(a, actor, { ...term, semester: "SECOND" }), false);
  assert.equal(isLecturerAssignmentCurrent(a, actor, null), false);
});
test("only the department's own HOD can create lecturers / assign them; lecturers and reps never can", () => {
  assert.equal(authorizeLecturerAdmin({ name: "H", role: "HOD", departmentId: "csc" }, "csc").ok, true);
  assert.equal(authorizeLecturerAdmin({ name: "H", role: "HOD", departmentId: "csc" }, "mls").ok, false);
  for (const role of ["LECTURER", "COURSE_REP", "ASSISTANT_COURSE_REP", "SUPER_ADMIN"] as const) assert.equal(authorizeLecturerAdmin({ name: "x", role, departmentId: "csc" }, "csc").ok, false, role);
});
test("assignment rules: same department, not suspended, current term, no duplicates", () => {
  const ok = { lecturerDepartmentId: "csc", courseDepartmentId: "csc", lecturerStatus: "ACTIVE", courseIsCurrentTerm: true, alreadyActiveOnCourse: false };
  assert.equal(checkLecturerAssignmentRules(ok), null);
  assert.ok(checkLecturerAssignmentRules({ ...ok, lecturerDepartmentId: "mls" }));
  assert.ok(checkLecturerAssignmentRules({ ...ok, lecturerStatus: "SUSPENDED" }));
  assert.ok(checkLecturerAssignmentRules({ ...ok, courseIsCurrentTerm: false }));
  assert.ok(checkLecturerAssignmentRules({ ...ok, alreadyActiveOnCourse: true }));
  assert.equal(checkLecturerAssignmentRules({ ...ok, lecturerStatus: "INVITED" }), null); // can be pre-assigned before activating
});

test("lecturer routes are exactly the intended surface (nothing to create/assign courses, write students, write the timetable, or grade)", () => {
  assert.deepEqual(routes("src/routes/lecturer.routes.ts"), [
    "DELETE /push/subscriptions", "DELETE /push/subscriptions/:id", "GET /push/config", "GET /push/preferences", "GET /push/subscriptions", "POST /push/subscriptions", "POST /push/test", "PUT /push/preferences",
    "DELETE /announcements/:announcementId", "DELETE /assignments/:assignmentId", "DELETE /materials/:materialId",
    "GET /announcements", "GET /assignments", "GET /assignments/:assignmentId/submissions", "GET /attendance/:sessionId", "GET /courses", "GET /courses/:courseId",
    "GET /courses/:courseId/attendance", "GET /courses/:courseId/attendance/statistics", "GET /courses/:courseId/materials", "GET /courses/:courseId/students",
    "GET /complaints", "GET /complaints/:complaintId", "GET /complaints/:complaintId/history",
    "GET /dashboard", "GET /notifications", "GET /profile", "GET /timetable",
    "PATCH /announcements/:announcementId", "PATCH /assignments/:assignmentId", "PATCH /attendance/:sessionId/close", "PATCH /attendance/:sessionId/open",
    "PATCH /change-password", "PATCH /complaints/:complaintId/status", "PATCH /materials/:materialId", "PATCH /notifications/:notificationId/read", "PATCH /notifications/read-all", "PATCH /profile",
    "POST /announcements", "POST /auth/activate", "POST /auth/forgot-password", "POST /auth/login", "POST /auth/logout", "POST /auth/reset-password", "POST /complaints/:complaintId/respond",
    "POST /courses/:courseId/assignments", "POST /courses/:courseId/attendance", "POST /courses/:courseId/materials", "POST /profile/picture",
  ].sort());
  const src = read("src/routes/lecturer.routes.ts").toLowerCase();
  for (const bad of ['"/students', '"/grade', '"/result', '"/mark', '"/enrol', '"/catalog', 'timetable", ...lec, lecturerwritelimiter', "assign-lecturer"]) assert.ok(!src.includes(bad), bad);
  assert.equal(routes("src/routes/lecturer.routes.ts").filter((r) => r.includes("/timetable")).join(), "GET /timetable"); // lecturers VIEW only
});
test("every protected lecturer route goes through authenticateLecturer + requireLecturer; course routes also check the assignment", () => {
  const src = read("src/routes/lecturer.routes.ts");
  assert.match(src, /const lec = \[authenticateLecturer, requireLecturer\]/);
  const chunks = src.split(/\nrouter\./).slice(1);
  assert.equal(chunks.length, 49);
  const publicPaths = ["/auth/login", "/auth/activate", "/auth/forgot-password", "/auth/reset-password"];
  for (const c of chunks) {
    const isPublic = publicPaths.some((p) => c.includes(`("${p}"`));
    if (!isPublic) assert.ok(c.includes("...lec"), `unguarded: ${c.slice(0, 50)}`);
    if (/\("\/courses\/:courseId/.test(c)) assert.ok(c.includes("course("), `course route without assignment check: ${c.slice(0, 60)}`);
  }
  assert.match(src, /authenticateLecturer/);
});
test("lecturer tokens use their own audience; the lecturer code never reads Student, and student code never reads Lecturer authority", () => {
  assert.match(read("src/services/token.service.ts"), /AUDIENCE_LECTURER = "lecturer-access"/);
  for (const f of ["src/services/lecturer/lecturer.service.ts", "src/services/lecturer/auth.service.ts", "src/middleware/lecturer.ts", "src/routes/lecturer.routes.ts"]) {
    assert.ok(!/models\/Student"/.test(read(f)), `${f} must not import the Student model`);
  }
  assert.ok(!/lecturer/i.test(read("src/middleware/auth.ts")), "student authentication is untouched");
  assert.ok(!read("src/routes/student.routes.ts").toLowerCase().includes("lecturer"));
});
test("request schemas are strict and carry no identity / authority fields; the profile accepts only the phone", () => {
  const v = read("src/validators/lecturer.validators.ts");
  assert.ok((v.match(/\.strict\(\)/g) ?? []).length >= 20);
  for (const key of ["lecturerId", "departmentId", "department", "role", "staffId", "studentId", "createdBy", "lecturer"]) assert.ok(!new RegExp(`^\\s+${key}:`, "m").test(v), `validators must not accept ${key}`);
  assert.match(v, /lecturerProfileSchema = z\s*\.object\(\{ phone:/);
  // GPS fields are numbers (JSON strings are refused) and mandatory
  assert.match(v, /latitude: z\.number\(\{ required_error/);
  assert.match(v, /allowedRadiusInMeters: z\.number\(\{ required_error/);
});
test("no grading, results or marks anywhere in the lecturer code", () => {
  for (const f of ["src/services/lecturer/lecturer.service.ts", "src/services/lecturer/store.ts", "src/routes/lecturer.routes.ts", "src/validators/lecturer.validators.ts", "src/controllers/lecturer.controller.ts"]) {
    assert.ok(!/\b(grade|gradebook|marks?|score|result)\b/i.test(read(f).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/no (marks|grading)[^"'`]*/gi, "")), `${f} mentions grading`);
  }
});
test("the student attendance endpoints still carry every security layer and the DB uniqueness rules are in place", () => {
  const st = read("src/routes/student.routes.ts");
  for (const p of ["/attendance/device/register", "/attendance/:sessionId/challenge", '"/attendance/:sessionId"']) assert.ok(st.includes(p), p);
  assert.match(st, /authenticateStudent, attendanceIpBackstop, attendanceActionLimiter/);
  assert.match(read("src/models/AttendanceRecord.ts"), /recordSchema\.index\(\{ session: 1, student: 1 \}, \{ unique: true \}\)/);
  const v = read("src/validators/student-attendance.validators.ts");
  assert.match(v, /latitude: z\.number\(\{ required_error/);
  assert.match(v, /longitude: z\.number\(\{ required_error/);
  assert.match(read("src/services/attendance/attendance-security.service.ts"), /distanceMeters\(/); // the server computes the distance
  assert.ok(!/withinRadius\s*[:=]\s*(input|req|body)/.test(read("src/services/attendance/attendance-security.service.ts"))); // never trusts a client "I'm inside"
});
