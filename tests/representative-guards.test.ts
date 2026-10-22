import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_ASSISTANTS_PER_COURSE, PERMISSIONS, ROLE_CONSTRAINTS, ROLE_PERMISSIONS, authorizeAssigner, can, checkAssignmentRules, isAssignmentCurrent, priorityAllowed,
} from "../src/services/representative/policy";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const routes = (file: string) => [...read(file).matchAll(/router\.(get|post|patch|delete|put)\(\s*"([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`).sort();

/* ---- permission matrix ---- */
test("Course Rep manages the class timetable; Assistant only views it", () => {
  for (const p of ["timetable:view", "timetable:create", "timetable:update", "timetable:delete"] as const) assert.equal(can("COURSE_REP", p), true, p);
  assert.equal(can("ASSISTANT_COURSE_REP", "timetable:view"), true);
  for (const p of ["timetable:create", "timetable:update", "timetable:delete"] as const) assert.equal(can("ASSISTANT_COURSE_REP", p), false, p);
});
test("20-24. no representative role can hold profile / catalogue / enrollment / attendance / official-material / assignment powers", () => {
  const forbidden = [
    "student:update_profile", "student:change_level", "student:change_department", "student:change_role",
    "course:create", "course:update", "course:delete", "course:modify",
    "enrollment:create", "enrollment:update", "enrollment:delete", "enrollment:modify",
    "attendance:create_session", "attendance:mark", "attendance:edit", "attendance:delete", "attendance:bypass",
    "material:modify_official", "material:official:update", "material:official:delete",
    "timetable:modify_official", "representative:assign", "representative:revoke", "representative:change_role",
  ];
  for (const role of ["COURSE_REP", "ASSISTANT_COURSE_REP"] as const) {
    for (const f of forbidden) assert.equal(can(role, f as never), false, `${role} must not hold ${f}`);
    // the closed list of everything a rep CAN hold contains none of them
    assert.ok(PERMISSIONS.every((p) => !forbidden.includes(p)));
  }
});
test("Assistant is a strict subset of Course Rep, with a lower announcement priority ceiling and no hard delete", () => {
  for (const p of ROLE_PERMISSIONS.ASSISTANT_COURSE_REP) assert.ok(ROLE_PERMISSIONS.COURSE_REP.includes(p), p);
  assert.ok(ROLE_PERMISSIONS.COURSE_REP.length > ROLE_PERMISSIONS.ASSISTANT_COURSE_REP.length);
  assert.equal(can("ASSISTANT_COURSE_REP", "announcement:delete:own"), false);
  assert.equal(priorityAllowed("COURSE_REP", "URGENT"), true);
  assert.equal(priorityAllowed("ASSISTANT_COURSE_REP", "URGENT"), false);
  assert.equal(ROLE_CONSTRAINTS.ASSISTANT_COURSE_REP.maxAnnouncementPriority, "IMPORTANT");
  // the table can't be mutated at runtime (e.g. by a bug) to hand out powers
  assert.ok(Object.isFrozen(ROLE_PERMISSIONS) && Object.isFrozen(ROLE_PERMISSIONS.COURSE_REP) && Object.isFrozen(ROLE_PERMISSIONS.ASSISTANT_COURSE_REP));
});
test("an assignment counts only while ACTIVE, for this student, in this department, in the current term", () => {
  const a = { studentId: "s", departmentId: "d", courseId: "c", academicSession: "2026/2027", semester: "FIRST" as const, status: "ACTIVE" as const };
  const actor = { studentId: "s", departmentId: "d" };
  const term = { academicSession: "2026/2027", semester: "FIRST" as const };
  assert.equal(isAssignmentCurrent(a, actor, term), true);
  assert.equal(isAssignmentCurrent({ ...a, status: "REVOKED" }, actor, term), false);
  assert.equal(isAssignmentCurrent({ ...a, status: "INACTIVE" }, actor, term), false);
  assert.equal(isAssignmentCurrent(a, { ...actor, studentId: "other" }, term), false);
  assert.equal(isAssignmentCurrent(a, { ...actor, departmentId: "x" }, term), false);
  assert.equal(isAssignmentCurrent(a, actor, { ...term, semester: "SECOND" }), false);
  assert.equal(isAssignmentCurrent(a, actor, null), false);
});

/* ---- who may create / revoke assignments ---- */
test("only the department's own HOD can assign or revoke; reps (any kind) never can", () => {
  assert.equal(authorizeAssigner({ name: "H", role: "HOD", departmentId: "csc" }, "csc").ok, true);
  assert.equal(authorizeAssigner({ name: "H", role: "HOD", departmentId: "csc" }, "mls").ok, false);
  for (const role of ["COURSE_REP", "ASSISTANT_COURSE_REP", "LECTURER", "SUPER_ADMIN"] as const) {
    assert.equal(authorizeAssigner({ name: "x", role, departmentId: "csc" }, "csc").ok, false, role);
  }
});
test("assignment rules: same department, active student, current term, one rep per course, limited assistants", () => {
  const base = { role: "COURSE_REP" as const, studentId: "s1", studentDepartmentId: "csc", courseDepartmentId: "csc", studentStatus: "ACTIVE", courseIsCurrentTerm: true, activeOnCourse: [] };
  assert.equal(checkAssignmentRules(base), null);
  assert.ok(checkAssignmentRules({ ...base, studentDepartmentId: "mls" }));
  assert.ok(checkAssignmentRules({ ...base, studentStatus: "PENDING_ONBOARDING" }));
  assert.ok(checkAssignmentRules({ ...base, courseIsCurrentTerm: false }));
  assert.ok(checkAssignmentRules({ ...base, activeOnCourse: [{ studentId: "s1", role: "ASSISTANT_COURSE_REP" }] }));
  assert.ok(checkAssignmentRules({ ...base, activeOnCourse: [{ studentId: "s2", role: "COURSE_REP" }] }));
  const asst = { ...base, role: "ASSISTANT_COURSE_REP" as const };
  assert.equal(checkAssignmentRules({ ...asst, activeOnCourse: [{ studentId: "s2", role: "COURSE_REP" }] }), null);
  const full = Array.from({ length: MAX_ASSISTANTS_PER_COURSE }, (_, i) => ({ studentId: `a${i}`, role: "ASSISTANT_COURSE_REP" as const }));
  assert.ok(checkAssignmentRules({ ...asst, activeOnCourse: full }));
});

/* ---- route-table guards (the HTTP surface is exactly what the spec allows) ---- */
test("representative routes are exactly the intended surface: nothing for profiles, enrollment, catalogue, attendance, assignments", () => {
  assert.deepEqual(routes("src/routes/representative.routes.ts"), [
    "DELETE /announcements/:announcementId", "DELETE /resources/:resourceId", "DELETE /timetable/:id",
    "GET /announcements", "GET /assignments", "GET /courses", "GET /courses/:courseId", "GET /courses/:courseId/members",
    "GET /notifications", "GET /overview", "GET /profile", "GET /resources", "GET /timetable",
    "PATCH /announcements/:announcementId", "PATCH /resources/:resourceId", "PATCH /timetable/:id",
    "POST /announcements", "POST /resources", "POST /timetable",
    // live quizzes
    "DELETE /quiz-games/:gameId/players/:playerId", "DELETE /quizzes/:id", "GET /quiz-games", "GET /quiz-games/:gameId", "GET /quizzes", "GET /quizzes/:id",
    "POST /quiz-games/:gameId/cancel", "POST /quiz-games/:gameId/end-question", "POST /quiz-games/:gameId/next", "POST /quiz-games/:gameId/start", "POST /quizzes", "POST /quizzes/:id/games", "PUT /quizzes/:id",
  ].sort());
  const src = read("src/routes/representative.routes.ts");
  for (const bad of ["enrol", "attendance", "catalog", "student/"]) {
    assert.ok(!src.toLowerCase().includes(`"/${bad}`), `unexpected route containing ${bad}`);
  }
});
test("every representative route starts with authenticateStudent + requireRepresentative", () => {
  const chunks = read("src/routes/representative.routes.ts").split(/\nrouter\./).slice(1);
  assert.equal(chunks.length, 32);
  for (const c of chunks) {
    assert.ok(c.includes("...rep"), `route chunk missing the shared guard: ${c.slice(0, 50)}`);
  }
  assert.match(read("src/routes/representative.routes.ts"), /const rep = \[authenticateStudent, requireRepresentative\]/);
  // write routes also check the specific permission
  for (const c of chunks.filter((x) => /^(post|patch|delete)/.test(x))) assert.ok(c.includes("requireRepresentativePermission("), c.slice(0, 40));
});
test("8. Students keep GET-only timetable access in the Student backend (no student timetable writes exist)", () => {
  const studentRoutes = routes("src/routes/student.routes.ts").filter((r) => r.includes("/timetable"));
  assert.deepEqual(studentRoutes, ["GET /timetable"]);
  assert.match(read("src/services/student-timetable.service.ts"), /\$ne: "DRAFT"/); // drafts never reach students
});
test("27. Reps stay ordinary students: the Student API is untouched and representative code never reads Student.role", () => {
  assert.ok(!read("src/routes/student.routes.ts").toLowerCase().includes("representative"));
  for (const f of ["src/middleware/representative.ts", "src/controllers/representative.controller.ts", "src/services/representative/representative.service.ts", "src/services/representative/index.ts", "src/services/representative/policy.ts"]) {
    const src = read(f);
    assert.ok(!/student\.role/.test(src), `${f} must not read student.role`);
    assert.ok(!/req\.student\??\.role/.test(src), `${f} must not read req.student.role`);
  }
  // the representative router re-uses the normal student authentication
  assert.match(read("src/routes/representative.routes.ts"), /import \{ authenticateStudent \} from "..\/middleware\/auth"/);
  // announcements/materials reuse the same models, so the existing student views keep working
  assert.match(read("src/services/student-announcements.service.ts"), /status: "PUBLISHED"/);
});
test("the request body can't carry authority: every write schema is strict and none accepts identity fields", () => {
  const v = read("src/validators/representative.validators.ts");
  assert.ok((v.match(/\.strict\(\)/g) ?? []).length >= 10);
  for (const key of ["studentId", "departmentId", "representativeId", "role", "level", "academicSession", "audience", "source", "createdBy"]) {
    assert.ok(!new RegExp(`^\\s+${key}:`, "m").test(v), `validators must not accept ${key}`);
  }
});
