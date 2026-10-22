import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  authorizeProvisioner, checkComplaintAssignee, checkComplaintTransition, checkCourseSession, checkCourseStructureChange, checkLevelChange,
  checkStudentStatusChange, checkTermTransition, hasAttendanceIssue, isValidSession,
} from "../src/services/hod/policy";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const routes = (file: string) => [...read(file).matchAll(/router\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`).sort();

test("only system administration provisions HOD accounts; a HOD (or anyone else) never can", () => {
  assert.equal(authorizeProvisioner({ name: "ops", role: "SYSTEM_SETUP" }).ok, true);
  assert.equal(authorizeProvisioner({ name: "future", role: "SUPER_ADMIN" }).ok, true);
  for (const role of ["HOD", "LECTURER", "COURSE_REP", "ASSISTANT_COURSE_REP", "STUDENT"] as const) assert.equal(authorizeProvisioner({ name: "x", role }).ok, false, role);
});
test("sessions and term transitions", () => {
  assert.equal(isValidSession("2026/2027"), true);
  for (const bad of ["2026/2028", "2026-2027", "26/27", ""]) assert.equal(isValidSession(bad), false, bad);
  assert.equal(checkCourseSession("2026/2027", "2026/2027"), null);
  assert.equal(checkCourseSession("2027/2028", "2026/2027"), null);
  assert.ok(checkCourseSession("2025/2026", "2026/2027"));
  assert.ok(checkCourseSession("2028/2029", "2026/2027"));
  const cur = { academicSession: "2026/2027", semester: "FIRST" as const };
  assert.equal(checkTermTransition(cur, { academicSession: "2026/2027", semester: "SECOND" }), null);
  assert.equal(checkTermTransition(cur, { academicSession: "2027/2028", semester: "FIRST" }), null);
  assert.ok(checkTermTransition(cur, cur));
  assert.ok(checkTermTransition({ ...cur, semester: "SECOND" }, cur));
  assert.ok(checkTermTransition(cur, { academicSession: "2027/2028", semester: "SECOND" }));
  assert.ok(checkTermTransition(cur, { academicSession: "2028/2029", semester: "FIRST" }));
  assert.equal(checkTermTransition(null, cur), null);
});
test("student status, course structure and level rules", () => {
  assert.equal(checkStudentStatusChange({ current: "ACTIVE", next: "SUSPENDED", onboardingCompleted: true }), null);
  assert.ok(checkStudentStatusChange({ current: "PENDING_ONBOARDING", next: "ACTIVE", onboardingCompleted: false }));
  assert.ok(checkStudentStatusChange({ current: "ACTIVE", next: "ACTIVE", onboardingCompleted: true }));
  assert.ok(checkStudentStatusChange({ current: "ACTIVE", next: "PENDING_ONBOARDING", onboardingCompleted: true }));
  assert.equal(checkCourseStructureChange(0, { level: true }), null);
  assert.ok(checkCourseStructureChange(3, { semester: true }));
  assert.equal(checkCourseStructureChange(3, {}), null);
  const usage = [{ level: "100", students: 5, courses: 2 }, { level: "400", students: 0, courses: 0 }];
  assert.ok(checkLevelChange(["100", "400"], ["400"], usage));
  assert.equal(checkLevelChange(["100", "400"], ["100"], usage), null);
  assert.ok(checkLevelChange(["100"], [], usage));
  assert.ok(checkLevelChange(["100"], ["100", "100"], usage));
  assert.ok(checkLevelChange(["100"], ["abc"], usage));
});
test("complaint transitions and assignee rules", () => {
  assert.equal(checkComplaintTransition("SUBMITTED", "UNDER_REVIEW", "status"), null);
  assert.equal(checkComplaintTransition("UNDER_REVIEW", "ASSIGNED", "assign"), null);
  assert.ok(checkComplaintTransition("SUBMITTED", "ASSIGNED", "status")); // forwarding goes through /assign
  assert.equal(checkComplaintTransition("RESOLVED", "CLOSED", "status"), null);
  for (const t of ["UNDER_REVIEW", "RESOLVED", "CLOSED", "IN_PROGRESS"] as const) { assert.ok(checkComplaintTransition("REJECTED", t, "status")); assert.ok(checkComplaintTransition("CLOSED", t, "status")); }
  assert.equal(checkComplaintAssignee({ lecturerFound: true, lecturerStatus: "ACTIVE", hasCourse: true, lecturerOnCourse: true }), null);
  assert.ok(checkComplaintAssignee({ lecturerFound: false, hasCourse: false, lecturerOnCourse: false }));
  assert.ok(checkComplaintAssignee({ lecturerFound: true, lecturerStatus: "SUSPENDED", hasCourse: false, lecturerOnCourse: false }));
  assert.ok(checkComplaintAssignee({ lecturerFound: true, lecturerStatus: "ACTIVE", hasCourse: true, lecturerOnCourse: false }));
  assert.equal(checkComplaintAssignee({ lecturerFound: true, lecturerStatus: "ACTIVE", hasCourse: false, lecturerOnCourse: false }), null);
  assert.equal(hasAttendanceIssue(40, 3), true);
  assert.equal(hasAttendanceIssue(40, 1), false); // too few sessions to judge
  assert.equal(hasAttendanceIssue(80, 5), false);
});

test("HOD routes are exactly the intended surface: no HOD signup, no role / department change, no attendance write, no timetable write, elections limited to department management, no campus-hub", () => {
  const got = routes("src/routes/hod.routes.ts");
  const expected = [
    "DELETE /push/subscriptions", "DELETE /push/subscriptions/:id", "GET /push/config", "GET /push/preferences", "GET /push/subscriptions", "POST /push/subscriptions", "POST /push/test", "PUT /push/preferences",
    "POST /auth/login", "POST /auth/activate", "POST /auth/forgot-password", "POST /auth/reset-password", "POST /auth/logout", "PATCH /change-password",
    "GET /profile", "PATCH /profile", "POST /profile/picture", "GET /dashboard", "GET /department", "PATCH /department/settings", "PUT /department/academic-term", "PATCH /department/registration",
    "GET /students", "POST /students/academic-record/bulk", "GET /students/:studentId", "PATCH /students/:studentId/status", "PATCH /students/:studentId/academic-record", "GET /students/:studentId/courses", "GET /students/:studentId/attendance",
    "GET /lecturers", "POST /lecturers", "GET /lecturers/:lecturerId", "PATCH /lecturers/:lecturerId", "PATCH /lecturers/:lecturerId/status", "POST /lecturers/:lecturerId/invitation",
    "GET /lecturers/:lecturerId/courses", "POST /lecturers/:lecturerId/courses", "DELETE /lecturers/:lecturerId/courses/:courseId",
    "GET /courses", "POST /courses", "GET /courses/:courseId", "PATCH /courses/:courseId", "PATCH /courses/:courseId/status",
    "GET /representatives", "POST /representatives", "PATCH /representatives/:assignmentId/status", "DELETE /representatives/:assignmentId",
    "GET /timetable", "GET /timetable/conflicts",
    "GET /announcements", "POST /announcements", "PATCH /announcements/:announcementId", "DELETE /announcements/:announcementId",
    "GET /documents", "POST /documents", "PATCH /documents/:documentId", "DELETE /documents/:documentId", "GET /materials",
    "GET /attendance", "GET /attendance/statistics", "GET /attendance/:sessionId",
    "GET /complaints", "GET /complaints/:complaintId", "PATCH /complaints/:complaintId/status", "POST /complaints/:complaintId/assign", "POST /complaints/:complaintId/respond",
    "GET /elections", "POST /elections", "GET /elections/student-search", "GET /elections/:electionId", "PATCH /elections/:electionId", "DELETE /elections/:electionId", "GET /elections/:electionId/readiness",
    "POST /elections/:electionId/publish", "POST /elections/:electionId/open", "POST /elections/:electionId/close", "POST /elections/:electionId/cancel",
    "GET /elections/:electionId/turnout", "GET /elections/:electionId/results", "PUT /elections/:electionId/results-release", "GET /elections/:electionId/group-members",
    "GET /elections/:electionId/positions", "POST /elections/:electionId/positions", "PUT /elections/:electionId/positions/order", "PATCH /elections/:electionId/positions/:positionId", "DELETE /elections/:electionId/positions/:positionId",
    "GET /elections/:electionId/candidates", "POST /elections/:electionId/candidates", "PATCH /elections/:electionId/candidates/:candidateId", "PATCH /elections/:electionId/candidates/:candidateId/decision",
    "PUT /elections/:electionId/candidates/:candidateId/photo", "DELETE /elections/:electionId/candidates/:candidateId/photo", "DELETE /elections/:electionId/candidates/:candidateId",
    "GET /notifications", "PATCH /notifications/read-all", "PATCH /notifications/:notificationId/read",
  ].sort();
  assert.deepEqual(got, expected);
  assert.ok(!got.some((r) => /(register|signup|sign-up)/i.test(r)));
  assert.deepEqual(got.filter((r) => r.includes("/attendance") && !r.startsWith("GET")), []); // attendance: read-only
  assert.deepEqual(got.filter((r) => r.includes("/timetable") && !r.startsWith("GET")), []); // timetable: read-only
  assert.deepEqual(got.filter((r) => /campus|poll|trivia|leaderboard|grade|super/i.test(r)), []);
  // Elections: no route casts, edits or reads individual votes / voters; results are one read-only GET plus the release switch.
  assert.deepEqual(got.filter((r) => /\/(votes?|ballots?|voters)\b/i.test(r)), []);
  assert.deepEqual(got.filter((r) => r.includes("/results") && !r.startsWith("GET") && !r.startsWith("PUT /elections/:electionId/results-release")), []);
  assert.ok(!got.some((r) => r.startsWith("POST /attendance") || r.startsWith("PATCH /attendance")));
});
test("every protected HOD route is behind authenticateHod + requireHod + requireDepartmentScope", () => {
  const src = read("src/routes/hod.routes.ts");
  assert.match(src, /const hod = \[authenticateHod, requireHod, requireDepartmentScope\]/);
  const publicPaths = ["/auth/login", "/auth/activate", "/auth/forgot-password", "/auth/reset-password"];
  const chunks = src.split(/\nrouter\./).slice(1);
  assert.equal(chunks.length, 96);
  for (const c of chunks) if (!publicPaths.some((p) => c.includes(`("${p}"`))) assert.ok(c.includes("...hod"), `unguarded: ${c.slice(0, 50)}`);
});
test("request schemas are strict and accept no authority / identity fields (department, role, staff id, matric code...)", () => {
  const v = read("src/validators/hod.validators.ts");
  assert.ok((v.match(/\.strict\(\)/g) ?? []).length >= 30);
  for (const key of ["departmentId", "department", "role", "staffId_", "matricCode", "matricNumber", "permissions", "hodId", "isActive", "code"]) assert.ok(!new RegExp(`^\\s+${key}:`, "m").test(v.replace(/staffId:/g, "staffId_:")), `validators must not accept ${key}`);
  assert.match(v, /hodProfileSchema = z\s*\.object\(\{ phone:/);
});
test("HOD tokens have their own audience and the HOD code never imports the Student model or reads student authority", () => {
  assert.match(read("src/services/token.service.ts"), /AUDIENCE_HOD = "hod-access"/);
  for (const f of ["src/services/hod/hod.service.ts", "src/services/hod/policy.ts", "src/middleware/hod.ts", "src/routes/hod.routes.ts"]) assert.ok(!/models\/Student"/.test(read(f)), f);
  assert.ok(!/hod/i.test(read("src/middleware/auth.ts")), "student authentication untouched");
  assert.ok(!/hod\.routes|\/hod/i.test(read("src/routes/student.routes.ts").replace(/HOD complaint[^\n]*/gi, "")));
});
test("no public HOD signup anywhere, and HOD provisioning is not reachable over HTTP", () => {
  const all = ["src/routes/hod.routes.ts", "src/routes/lecturer.routes.ts", "src/routes/student.routes.ts", "src/routes/representative.routes.ts", "src/routes/index.ts"].map(read).join("\n");
  assert.ok(!/createHodAccount/.test(all));
  assert.match(read("src/services/hod/account.service.ts"), /authorizeProvisioner/);
});
test("existing protections are still in place (attendance security, student auth, uniqueness) after adding the HOD role", () => {
  assert.match(read("src/models/AttendanceRecord.ts"), /recordSchema\.index\(\{ session: 1, student: 1 \}, \{ unique: true \}\)/);
  assert.match(read("src/services/attendance/attendance-security.service.ts"), /distanceMeters\(/);
  assert.match(read("src/routes/student.routes.ts"), /authenticateStudent, attendanceIpBackstop, attendanceActionLimiter/);
  assert.match(read("src/middleware/auth.ts"), /student\.status !== "ACTIVE"/); // a suspended student is refused on the next request
  assert.match(read("src/models/Hod.ts"), /partialFilterExpression: \{ isCurrent: true \}/); // one sitting HOD per department
});
test("student-side hooks for the HOD flow exist and don't weaken student behaviour", () => {
  const c = read("src/services/student-complaints.service.ts");
  assert.match(c, /notifyDepartmentHod\(/);       // a new complaint tells the department's HOD (best-effort)
  assert.match(c, /recipient: \{ role: "HOD" \}/); // the HOD reviews every complaint first
  assert.match(c, /logger\.warn\("Could not notify the HOD/); // a notification failure never fails the student's submission
  assert.match(read("src/services/student-documents.service.ts"), /department: department\._id/); // students only see their own department's documents
  assert.match(read("src/services/hod/notify.ts"), /isCurrent: true, status: "ACTIVE"/);
});
