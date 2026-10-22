import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { CSC, MLS, S, T0, hodC, hodM, makeHodWorld, meta, q, rejection } from "./helpers/hod-world";

/* ============================ department isolation ============================ */
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
test("1. Dashboard: each HOD sees only their own department's numbers", async () => {
  const w = makeHodWorld();
  const c = await w.svc.dashboard(hodC);
  const m = await w.svc.dashboard(hodM);
  assert.equal(c.department?.code, "CSC");
  assert.equal(m.department?.code, "MLS");
  assert.deepEqual([c.statistics.totalStudents, c.statistics.activeStudents, c.statistics.studentsPendingOnboarding, c.statistics.suspendedStudents], [6, 4, 1, 1]);
  assert.deepEqual([m.statistics.totalStudents, m.statistics.totalLecturers], [2, 1]);
  assert.deepEqual([c.statistics.totalLecturers, c.statistics.activeLecturers, c.statistics.activeCourses, c.statistics.activeAttendanceSessions, c.statistics.pendingComplaints], [3, 1, 3, 1, 2]);
  assert.deepEqual([m.statistics.activeCourses, m.statistics.activeAttendanceSessions, m.statistics.pendingComplaints, m.statistics.activeAnnouncements], [1, 1, 1, 1]);
  assert.deepEqual(c.currentTerm, { academicSession: S, semester: "FIRST", registrationOpen: true });
  assert.equal(c.statistics.activeAnnouncements, 1); // the CSC lecturer's note only
});
test("2. A CSC HOD cannot read or touch any MLS student / lecturer / course / complaint / representative / attendance / announcement / document", async () => {
  const w = makeHodWorld();
  const rep = await w.svc.appointRepresentative(hodM, { studentId: "mia", level: "200", role: "COURSE_REP" });
  const doc = await w.svc.createDocument(hodM, { title: "MLS handbook", fileUrl: "https://x.example/h" });
  const attempts: Promise<unknown>[] = [
    w.svc.getStudent(hodC, "mia"), w.svc.setStudentStatus(hodC, "mia", "SUSPENDED"), w.svc.studentCourses(hodC, "mia"), w.svc.studentAttendance(hodC, "mia"), w.svc.updateStudentAcademicRecord(hodC, "mia", { level: "300" }),
    w.svc.getLecturer(hodC, "lecM"), w.svc.updateLecturer(hodC, "lecM", { firstName: "X" }), w.svc.setLecturerStatus(hodC, "lecM", "SUSPENDED"), w.svc.lecturerCourses(hodC, "lecM"), w.svc.reinviteLecturer(hodC, "lecM"),
    w.svc.getCourse(hodC, w.mls201.id), w.svc.updateCourse(hodC, w.mls201.id, { title: "x" }), w.svc.setCourseStatus(hodC, w.mls201.id, "ARCHIVED"),
    w.svc.getComplaint(hodC, "m1"), w.svc.setComplaintStatus(hodC, "m1", { status: "UNDER_REVIEW" }), w.svc.respondToComplaint(hodC, "m1", { message: "hello" }), w.svc.assignComplaint(hodC, "m1", { lecturerId: "lecA" }),
    w.svc.setRepresentativeStatus(hodC, rep.id, "INACTIVE"), w.svc.revokeRepresentative(hodC, rep.id),
    w.svc.getAttendanceSession(hodC, "s-mls"),
    w.svc.updateAnnouncement(hodC, "a-mls", { title: "x" }), w.svc.deleteAnnouncement(hodC, "a-mls"),
    w.svc.updateDocument(hodC, doc.id, { title: "x" }), w.svc.deleteDocument(hodC, doc.id),
    w.svc.assignLecturerToCourse(hodC, "lecM", w.mls201.id), w.svc.assignLecturerToCourse(hodC, "lecA", w.mls201.id), w.svc.removeLecturerFromCourse(hodC, "lecM", w.mls201.id),
    w.svc.appointRepresentative(hodC, { studentId: "mia", level: "200", role: "COURSE_REP" }), // an MLS student can't be appointed by the CSC HOD
  ];
  for (const p of attempts) assert.equal((await rejection(p)).status, 404);
  assert.equal(w.store.students.find((s) => s.id === "mia")!.status, "ACTIVE");
  assert.equal(w.store.complaints.find((c) => c.id === "m1")!.status, "SUBMITTED");
  assert.equal(w.store.repAssigns.find((r) => r.id === rep.id)!.status, "ACTIVE");
  assert.ok(w.store.audit.filter((a) => a.action === "ACCESS_DENIED").length >= 25); // every attempt audited
  // ...and the lists never include the other department
  assert.ok((await w.svc.listStudents(hodC, q())).items.every((s) => !["mia", "zed"].includes(s.id)));
  assert.ok((await w.svc.listLecturers(hodC, q())).items.every((l) => l.id !== "lecM"));
  assert.ok((await w.svc.listCourses(hodC, q())).items.every((c) => c.id !== w.mls201.id));
  assert.ok((await w.svc.listComplaints(hodC, q())).items.every((c) => c.id !== "m1"));
  assert.ok((await w.svc.listAttendanceSessions(hodC, q())).items.every((s) => s.id !== "s-mls"));
  assert.ok((await w.svc.listAnnouncements(hodC, q())).items.every((a) => a.id !== "a-mls"));
  assert.equal((await w.svc.listRepresentatives(hodC, q())).total, 0);
  assert.ok((await w.svc.listDocuments(hodC, q())).items.every((d) => d.id !== doc.id));
});
test("3. And the other way round (MLS HOD vs CSC), plus a smuggled department id is refused and audited", async () => {
  const w = makeHodWorld();
  for (const p of [w.svc.getStudent(hodM, "john"), w.svc.getLecturer(hodM, "lecA"), w.svc.getCourse(hodM, w.csc201.id), w.svc.getComplaint(hodM, "1"), w.svc.getAttendanceSession(hodM, "s-open")]) assert.equal((await rejection(p)).status, 404);
  assert.equal((await rejection(w.svc.assertScope(hodC, MLS, meta))).code, "DEPARTMENT_SCOPE_VIOLATION");
  await w.svc.assertScope(hodC, CSC); await w.svc.assertScope(hodC, undefined); // own / absent: fine
  const v = w.store.audit.find((a) => a.action === "SCOPE_VIOLATION")!;
  assert.deepEqual([v.actorId, v.departmentId, v.ip], ["hodC", CSC, "41.58.0.7"]);
});
test("4. IDOR: bad / unknown / foreign ids all behave like 'not found', and never change data", async () => {
  const w = makeHodWorld();
  for (const id of ["nope", "000000000000000000000000", "john"]) {
    assert.equal((await rejection(w.svc.getLecturer(hodC, id))).status, 404);
    assert.equal((await rejection(w.svc.getCourse(hodC, id))).status, 404);
    assert.equal((await rejection(w.svc.getComplaint(hodC, id))).status, 404);
    assert.equal((await rejection(w.svc.revokeRepresentative(hodC, id))).status, 404);
  }
  assert.equal((await rejection(w.svc.bulkUpdateAcademicRecords(hodC, ["john", "mia"], { level: "300" }))).status, 404); // one foreign id: nothing changes
  assert.equal(w.store.students.find((s) => s.id === "john")!.level, "200");
});

/* ============================ students ============================ */
test("5. Students: list, search, filter, sort and paginate (server-side)", async () => {
  const w = makeHodWorld();
  const all = await w.svc.listStudents(hodC, q());
  assert.equal(all.total, 6);
  assert.deepEqual((await w.svc.listStudents(hodC, q({ limit: 2, page: 2 }))).items.length, 2);
  assert.equal((await w.svc.listStudents(hodC, q({ limit: 2 }))).totalPages, 3);
  assert.deepEqual((await w.svc.listStudents(hodC, q({ search: "obi" }))).items.map((s) => s.id), ["ada"]);
  assert.deepEqual((await w.svc.listStudents(hodC, q({ search: "25/208CSC/987" }))).items.map((s) => s.id), ["john"]);
  assert.deepEqual((await w.svc.listStudents(hodC, q({ level: "100" }))).items.map((s) => s.id).sort(), ["pend", "tola"]);
  assert.equal((await w.svc.listStudents(hodC, q({ status: "SUSPENDED" }))).total, 1);
  assert.equal((await w.svc.listStudents(hodC, q({ academicSession: "2020/2021" }))).total, 0);
  assert.deepEqual((await w.svc.listStudents(hodC, q({ sort: "lastName", order: "asc" }))).items.map((s) => s.lastName)[0], "Ade");
  for (const s of all.items) assert.ok(!("passwordHash" in s) && !("role" in s));
});
test("6. Students: view, enrolled courses, attendance summary (read-only)", async () => {
  const w = makeHodWorld();
  const s = await w.svc.getStudent(hodC, "john");
  assert.deepEqual([s.matricNumber, s.level, s.currentCourses], ["25/208CSC/987", "200", ["CSC201"]]);
  const courses = await w.svc.studentCourses(hodC, "sam");
  assert.deepEqual(courses.map((c) => [c.courseCode, c.enrollmentType, c.current]).sort(), [["CSC201", "REGULAR", true], ["CSC202", "CARRYOVER", true]]);
  const att = await w.svc.studentAttendance(hodC, "john");
  assert.deepEqual(att.courses, [{ courseCode: "CSC201", sessionsHeld: 3, attended: 2, late: 0, absent: 1, percentage: 66.7 }]);
});
test("7. Students: suspend / reactivate with rules; identity fields can't be changed", async () => {
  const w = makeHodWorld();
  assert.equal((await w.svc.setStudentStatus(hodC, "john", "SUSPENDED", meta)).status, "SUSPENDED");
  assert.equal((await rejection(w.svc.setStudentStatus(hodC, "john", "SUSPENDED"))).code, "STUDENT_STATUS_REFUSED");
  assert.equal((await w.svc.setStudentStatus(hodC, "john", "ACTIVE")).status, "ACTIVE");
  assert.equal((await rejection(w.svc.setStudentStatus(hodC, "pend", "ACTIVE"))).code, "STUDENT_STATUS_REFUSED"); // never onboarded
  assert.equal((await rejection(w.svc.setStudentStatus(hodC, "john", "PENDING_ONBOARDING"))).code, "STUDENT_STATUS_REFUSED");
  const before = { ...w.store.students.find((s) => s.id === "john")! };
  await w.svc.updateStudentAcademicRecord(hodC, "john", { level: "300", ...({ matricNumber: "99/999XXX/1", departmentId: MLS, role: "COURSE_REP", firstName: "Evil" } as object) });
  const after = w.store.students.find((s) => s.id === "john")!;
  assert.deepEqual([after.matricNumber, after.departmentId, after.firstName, after.level], [before.matricNumber, before.departmentId, before.firstName, "300"]);
  assert.equal((await rejection(w.svc.updateStudentAcademicRecord(hodC, "john", { level: "500" }))).code, "INVALID_LEVEL"); // CSC has no 500 level
  assert.equal((await rejection(w.svc.updateStudentAcademicRecord(hodC, "john", { academicSession: "2026/2028" }))).code, "INVALID_SESSION");
  assert.equal((await w.svc.updateStudentAcademicRecord(hodM, "zed", { level: "500" })).level, "500"); // MLS does have 500
  assert.equal((await w.svc.bulkUpdateAcademicRecords(hodC, ["ada", "sam"], { level: "300", academicSession: "2027/2028" }, meta)).updated, 2);
  assert.ok(w.store.audit.some((a) => a.action === "STUDENT_STATUS_CHANGED" && a.ip === "41.58.0.7"));
});

/* ============================ lecturers ============================ */
test("8. Lecturers: list / search / view / create (department = the HOD's) / duplicate / invitation / reinvite", async () => {
  const w = makeHodWorld();
  assert.equal((await w.svc.listLecturers(hodC, q())).total, 3);
  assert.deepEqual((await w.svc.listLecturers(hodC, q({ search: "invited" }))).items.map((l) => l.id), ["lecI"]);
  assert.deepEqual((await w.svc.listLecturers(hodC, q({ status: "ACTIVE" }))).items.map((l) => l.id), ["lecA"]);
  const v = await w.svc.getLecturer(hodC, "lecA");
  assert.deepEqual(v.assignedCourses.map((c) => c.courseCode), ["CSC201"]);

  const created = await w.svc.createLecturer(hodC, { firstName: "New", lastName: "Staff", email: "new@uni.example", staffId: "csc-010" }, meta);
  assert.deepEqual([created.status, created.staffId, created.invitationSent], ["INVITED", "CSC-010", true]);
  const stored = w.store.lecturers.find((l) => l.id === created.id)!;
  assert.equal(stored.departmentId, CSC); // not an input
  assert.deepEqual(w.invites, [{ to: "new@uni.example", token: "raw-token-1" }]);
  assert.ok(!JSON.stringify(created).includes("raw-token")); // the raw activation token never leaves the server
  assert.notEqual(w.store.invitations.get(created.id)!.hash, "raw-token-1"); // only a hash is stored
  assert.equal((await rejection(w.svc.createLecturer(hodC, { firstName: "A", lastName: "B", email: "new@uni.example", staffId: "CSC-011" }))).code, "LECTURER_DUPLICATE");
  assert.equal((await rejection(w.svc.createLecturer(hodM, { firstName: "A", lastName: "B", email: "a@uni.example", staffId: "MLS-9" }))).code, "LECTURER_DUPLICATE"); // email is global
  w.setFailInvite(true);
  const noMail = await w.svc.createLecturer(hodC, { firstName: "No", lastName: "Mail", email: "nomail@uni.example", staffId: "CSC-012" });
  assert.equal(noMail.invitationSent, false); // account exists; the HOD can reissue
  w.setFailInvite(false);
  assert.equal((await w.svc.reinviteLecturer(hodC, noMail.id)).invitationSent, true);
  assert.equal((await rejection(w.svc.reinviteLecturer(hodC, "lecA"))).code, "ALREADY_ACTIVATED");
});
test("9. Lecturers: update only name / phone; activate / deactivate with rules", async () => {
  const w = makeHodWorld();
  const u = await w.svc.updateLecturer(hodC, "lecA", { firstName: "Aminat", phone: "+2348012345678", ...({ email: "evil@x.example", staffId: "X-1", departmentId: MLS, role: "HOD" } as object) }, meta);
  assert.deepEqual([u.firstName, u.phone], ["Aminat", "+2348012345678"]);
  const l = w.store.lecturers.find((x) => x.id === "lecA")!;
  assert.deepEqual([l.email, l.staffId, l.departmentId], ["a@uni.example", "CSC-001", CSC]);
  assert.equal((await w.svc.setLecturerStatus(hodC, "lecA", "SUSPENDED", meta)).status, "SUSPENDED");
  assert.equal((await rejection(w.svc.setLecturerStatus(hodC, "lecA", "SUSPENDED"))).code, "LECTURER_STATUS_REFUSED");
  assert.equal((await w.svc.setLecturerStatus(hodC, "lecA", "ACTIVE")).status, "ACTIVE");
  assert.equal((await rejection(w.svc.setLecturerStatus(hodC, "lecI", "ACTIVE"))).code, "NOT_ACTIVATED");
});
test("10. Lecturer course assignment: rules, duplicates, removal; reuses LecturerCourseAssignment", async () => {
  const w = makeHodWorld();
  const a = await w.svc.assignLecturerToCourse(hodC, "lecA", w.csc202.id, meta);
  assert.deepEqual([a.courseCode, a.academicSession, a.semester, a.status], ["CSC202", S, "FIRST", "ACTIVE"]);
  const rec = w.store.lecturerAssigns.find((x) => x.id === a.assignmentId)!;
  assert.deepEqual([rec.departmentId, rec.assignedBy.role, rec.level], [CSC, "HOD", "200"]);
  assert.equal((await rejection(w.svc.assignLecturerToCourse(hodC, "lecA", w.csc202.id))).code, "ASSIGNMENT_RULE"); // duplicate
  assert.equal((await rejection(w.svc.assignLecturerToCourse(hodC, "lecS", w.csc202.id))).code, "ASSIGNMENT_RULE"); // suspended
  assert.equal((await w.svc.assignLecturerToCourse(hodC, "lecI", w.csc202.id)).status, "ACTIVE"); // may be pre-assigned before activating
  // a course outside the current term can't be assigned
  const future = await w.svc.createCourse(hodC, { courseCode: "CSC399", title: "Future", units: 3, level: "300", semester: "SECOND" });
  assert.equal((await rejection(w.svc.assignLecturerToCourse(hodC, "lecA", future.id))).code, "ASSIGNMENT_RULE");
  const courses = await w.svc.lecturerCourses(hodC, "lecA");
  assert.deepEqual(courses.filter((c) => c.current).map((c) => c.courseCode).sort(), ["CSC201", "CSC202"]);
  await w.svc.removeLecturerFromCourse(hodC, "lecA", w.csc202.id, meta);
  assert.equal(rec.status, "REVOKED");
  assert.equal((await rejection(w.svc.removeLecturerFromCourse(hodC, "lecA", w.csc202.id))).status, 404);
  assert.equal((await w.svc.assignLecturerToCourse(hodC, "lecA", w.csc202.id)).status, "ACTIVE"); // can be assigned again after removal
  assert.ok(w.notes.some((n) => n.who === "lecA" && n.title.includes("CSC202")));
});

/* ============================ courses + levels + term ============================ */
test("11. Courses: create in the HOD's department, level / session / duplicate rules, normalisation", async () => {
  const w = makeHodWorld();
  const c = await w.svc.createCourse(hodC, { courseCode: "csc 301", title: "Algorithms", description: "Intro", units: 3, level: "300", semester: "FIRST" }, meta);
  assert.deepEqual([c.courseCode, c.academicSession, c.status, c.enrolledCount], ["CSC301", S, "ACTIVE", 0]);
  assert.equal(w.store.courses.find((x) => x.id === c.id)!.departmentId, CSC);
  assert.equal((await rejection(w.svc.createCourse(hodC, { courseCode: "CSC301", title: "Dup", units: 3, level: "300", semester: "FIRST" }))).code, "COURSE_DUPLICATE");
  await w.svc.createCourse(hodC, { courseCode: "CSC301", title: "Second sem", units: 3, level: "300", semester: "SECOND" }); // same code, other semester: allowed
  await w.svc.createCourse(hodM, { courseCode: "CSC301", title: "Other dept same code", units: 3, level: "300", semester: "FIRST" }); // other department: its own scope
  assert.equal((await rejection(w.svc.createCourse(hodC, { courseCode: "CSC501", title: "x", units: 3, level: "500", semester: "FIRST" }))).code, "INVALID_LEVEL"); // CSC has no 500
  assert.equal((await w.svc.createCourse(hodM, { courseCode: "MLS501", title: "x", units: 3, level: "500", semester: "FIRST" })).level, "500");
  assert.equal((await rejection(w.svc.createCourse(hodC, { courseCode: "BAD", title: "x", units: 3, level: "200", semester: "FIRST" }))).code, "INVALID_COURSE_CODE");
  assert.equal((await rejection(w.svc.createCourse(hodC, { courseCode: "CSC310", title: "x", units: 3, level: "300", semester: "FIRST", academicSession: "2024/2025" }))).code, "INVALID_SESSION");
  assert.equal((await rejection(w.svc.createCourse(hodC, { courseCode: "CSC310", title: "x", units: 3, level: "300", semester: "FIRST", academicSession: "2029/2030" }))).code, "INVALID_SESSION");
  assert.equal((await w.svc.createCourse(hodC, { courseCode: "CSC310", title: "Next year", units: 3, level: "300", semester: "FIRST", academicSession: "2027/2028" })).academicSession, "2027/2028");
});
test("12. Courses: list / filter / view with counts, update rules, archive / reactivate", async () => {
  const w = makeHodWorld();
  assert.deepEqual((await w.svc.listCourses(hodC, q({ level: "200" }))).items.map((c) => [c.courseCode, c.enrolledCount]).sort(), [["CSC201", 3], ["CSC202", 1]]);
  assert.equal((await w.svc.listCourses(hodC, q({ search: "101" }))).total, 1);
  const d = await w.svc.getCourse(hodC, w.csc201.id);
  assert.equal(d.enrolledCount, 3);
  assert.deepEqual(d.lecturers.map((l) => l.lecturerId), ["lecA"]);
  const u = await w.svc.updateCourse(hodC, w.csc202.id, { title: "Renamed", units: 4, description: "New" }, meta);
  assert.deepEqual([u.title, u.units, u.courseCode], ["Renamed", 4, "CSC202"]);
  // code / session / department can't be patched
  await w.svc.updateCourse(hodC, w.csc202.id, { title: "T2", ...({ courseCode: "ZZZ999", departmentId: MLS, academicSession: "2030/2031" } as object) });
  const rec = w.store.courses.find((c) => c.id === w.csc202.id)!;
  assert.deepEqual([rec.courseCode, rec.departmentId, rec.academicSession], ["CSC202", CSC, S]);
  // structure is locked once students are enrolled (or lecturers / reps assigned)
  assert.equal((await rejection(w.svc.updateCourse(hodC, w.csc201.id, { level: "300" }))).code, "COURSE_STRUCTURE_LOCKED");
  assert.equal((await rejection(w.svc.updateCourse(hodC, w.csc201.id, { semester: "SECOND" }))).code, "COURSE_STRUCTURE_LOCKED");
  const empty = await w.svc.createCourse(hodC, { courseCode: "CSC350", title: "Empty", units: 2, level: "300", semester: "FIRST" });
  assert.equal((await w.svc.updateCourse(hodC, empty.id, { level: "400", semester: "SECOND" })).level, "400");
  assert.equal((await rejection(w.svc.updateCourse(hodC, empty.id, { level: "500" }))).code, "INVALID_LEVEL");
  assert.equal((await w.svc.setCourseStatus(hodC, w.csc101.id, "ARCHIVED", meta)).status, "ARCHIVED");
  assert.equal((await rejection(w.svc.setCourseStatus(hodC, w.csc101.id, "ARCHIVED"))).code, "COURSE_STATUS_REFUSED");
  assert.equal((await w.svc.setCourseStatus(hodC, w.csc101.id, "ACTIVE")).status, "ACTIVE");
  assert.equal((await w.svc.listCourses(hodC, q({ status: "ARCHIVED" }))).total, 0);
});
test("13. Levels are per department: view, add, remove only when unused, never another department's", async () => {
  const w = makeHodWorld();
  assert.deepEqual((await w.svc.getDepartment(hodC)).levels, ["100", "200", "300", "400"]);
  assert.deepEqual((await w.svc.getDepartment(hodM)).levels, ["100", "200", "300", "400", "500"]);
  assert.deepEqual((await w.svc.updateDepartmentSettings(hodC, { levels: ["100", "200", "300", "400", "500"] }, meta)).levels, ["100", "200", "300", "400", "500"]);
  assert.deepEqual((await w.svc.getDepartment(hodM)).levels, ["100", "200", "300", "400", "500"]); // MLS untouched
  assert.equal((await w.svc.updateDepartmentSettings(hodC, { levels: ["100", "200", "300", "400"] })).levels.length, 4); // 500 had no students / courses
  assert.equal((await rejection(w.svc.updateDepartmentSettings(hodC, { levels: ["100", "300", "400"] }))).code, "LEVEL_CHANGE_REFUSED"); // 200 still has students and courses
  assert.equal((await rejection(w.svc.updateDepartmentSettings(hodC, { levels: [] }))).code, "LEVEL_CHANGE_REFUSED"); // at least one level
  assert.deepEqual((await w.svc.updateDepartmentSettings(hodC, { levels: ["100", "200", "300"] })).levels, ["100", "200", "300"]); // 400 is unused: removable
  assert.deepEqual((await w.svc.getDepartment(hodM)).levels, ["100", "200", "300", "400", "500"]); // MLS still its own
});

test("14. Department settings: name / faculty / contact only; code, matric code, id and active flag can't be changed", async () => {
  const w = makeHodWorld();
  const d = await w.svc.updateDepartmentSettings(hodC, { faculty: "Computing & Applied Sciences", contact: { email: "csc@uni.example", office: "Block B" }, ...({ code: "ZZZ", matricCode: "ZZZ", id: "x", isActive: false, departmentId: MLS } as object) }, meta);
  assert.deepEqual([d.faculty, d.contact?.email, d.code, d.isActive, d.id], ["Computing & Applied Sciences", "csc@uni.example", "CSC", true, CSC]);
  assert.deepEqual(d.editable, ["name", "faculty", "contact", "levels"]);
  assert.equal((await rejection(w.svc.updateDepartmentSettings(hodC, { name: "Medical Laboratory Science" }))).code, "DEPARTMENT_NAME_TAKEN");
  assert.equal((await w.svc.getDepartment(hodM)).faculty, "Health Sciences"); // the other department is untouched
  assert.ok(w.store.audit.some((a) => a.action === "DEPARTMENT_SETTINGS_CHANGED" && a.resourceId === CSC));
});
test("15. Academic term: forward only, one step, explicit confirmation, audited; registration window", async () => {
  const w = makeHodWorld();
  assert.equal((await rejection(w.svc.setAcademicTerm(hodC, { academicSession: S, semester: "SECOND", confirm: false }))).code, "CONFIRMATION_REQUIRED");
  assert.equal(w.store.terms.get(CSC)!.semester, "FIRST");
  assert.equal((await w.svc.setAcademicTerm(hodC, { academicSession: S, semester: "SECOND", confirm: true }, meta)).currentTerm.semester, "SECOND");
  assert.equal((await w.svc.getDepartment(hodM)).currentTerm?.semester, "FIRST"); // MLS term unchanged
  assert.equal((await rejection(w.svc.setAcademicTerm(hodC, { academicSession: S, semester: "FIRST", confirm: true }))).code, "TERM_TRANSITION_REFUSED"); // backwards
  assert.equal((await rejection(w.svc.setAcademicTerm(hodC, { academicSession: S, semester: "SECOND", confirm: true }))).code, "TERM_TRANSITION_REFUSED"); // same
  assert.equal((await rejection(w.svc.setAcademicTerm(hodC, { academicSession: "2028/2029", semester: "FIRST", confirm: true }))).code, "TERM_TRANSITION_REFUSED"); // skips a session
  assert.equal((await rejection(w.svc.setAcademicTerm(hodC, { academicSession: "2027/2028", semester: "SECOND", confirm: true }))).code, "TERM_TRANSITION_REFUSED"); // new session starts FIRST
  assert.equal((await w.svc.setAcademicTerm(hodC, { academicSession: "2027/2028", semester: "FIRST", confirm: true })).currentTerm.academicSession, "2027/2028");
  const a = w.store.audit.filter((x) => x.action === "ACADEMIC_TERM_CHANGED");
  assert.equal(a.length, 2);
  assert.deepEqual((a[0].detail as { from: { semester: string } }).from.semester, "FIRST");
  // registration settings
  assert.equal((await w.svc.updateRegistration(hodC, { registrationOpen: false, maxUnits: 20 }, meta)).registration.open, false);
  assert.equal((await rejection(w.svc.updateRegistration(hodC, { registrationOpensAt: new Date("2026-12-01"), registrationClosesAt: new Date("2026-11-01") }))).code, "INVALID_WINDOW");
  assert.equal(w.store.terms.get(MLS)!.registrationOpen, true);
});

/* ============================ representatives ============================ */
test("16. Appoint Course Rep + Assistant Course Rep for a LEVEL (not a course); every precondition is checked", async () => {
  const w = makeHodWorld();
  const cr = await w.svc.appointRepresentative(hodC, { studentId: "john", level: "200", role: "COURSE_REP" }, meta);
  assert.deepEqual([cr.role, cr.status, cr.scope, cr.level, cr.course, cr.student.matricNumber, cr.assignedBy], ["COURSE_REP", "ACTIVE", "LEVEL", "200", null, "25/208CSC/987", "Hope Chief"]);
  const rec = w.store.repAssigns.find((r) => r.id === cr.id)!;
  assert.deepEqual([rec.departmentId, rec.academicSession, rec.semester, rec.level, rec.scope, rec.courseId], [CSC, S, "FIRST", "200", "LEVEL", undefined]); // term = the department's current term; no course
  const acr = await w.svc.appointRepresentative(hodC, { studentId: "ada", level: "200", role: "ASSISTANT_COURSE_REP" });
  assert.equal(acr.role, "ASSISTANT_COURSE_REP");
  assert.ok(w.notes.some((n) => n.who === "john" && n.title.includes("Course Rep") && n.title.includes("200 Level")));
  const rules = async (p: Promise<unknown>) => (await rejection(p)).code;
  assert.equal(await rules(w.svc.appointRepresentative(hodC, { studentId: "sam", level: "200", role: "COURSE_REP" })), "ASSIGNMENT_RULE"); // the level already has a Course Rep
  assert.equal(await rules(w.svc.appointRepresentative(hodC, { studentId: "john", level: "200", role: "ASSISTANT_COURSE_REP" })), "ASSIGNMENT_RULE"); // already holds a role for the level
  assert.equal(await rules(w.svc.appointRepresentative(hodC, { studentId: "pend", level: "100", role: "COURSE_REP" })), "ASSIGNMENT_RULE"); // not an active student
  assert.equal(await rules(w.svc.appointRepresentative(hodC, { studentId: "susp", level: "100", role: "COURSE_REP" })), "ASSIGNMENT_RULE");
  assert.equal(await rules(w.svc.appointRepresentative(hodC, { studentId: "tola", level: "500", role: "COURSE_REP" })), "ASSIGNMENT_RULE"); // CSC doesn't offer 500 Level
  assert.equal((await rejection(w.svc.appointRepresentative(hodC, { studentId: "mia", level: "200", role: "COURSE_REP" }))).status, 404); // other department's student
  assert.equal((await w.svc.appointRepresentative(hodC, { studentId: "tola", level: "100", role: "COURSE_REP" })).level, "100"); // another level is independent
  // a level allows at most two assistants
  await w.svc.appointRepresentative(hodC, { studentId: "sam", level: "200", role: "ASSISTANT_COURSE_REP" });
  assert.equal(await rules(w.svc.appointRepresentative(hodC, { studentId: "tola", level: "200", role: "ASSISTANT_COURSE_REP" })), "ASSIGNMENT_RULE");
  // the term is required: no current term, no appointment
  w.store.terms.delete(CSC);
  const noTerm = await rejection(w.svc.appointRepresentative(hodC, { studentId: "tola", level: "300", role: "COURSE_REP" })); // an ACTIVE student, so only the missing term can refuse this
  assert.deepEqual([noTerm.code, noTerm.message], ["ASSIGNMENT_RULE", "Set the department's current term before appointing representatives."]);
  assert.ok(w.store.audit.some((a) => a.action === "REPRESENTATIVE_APPOINTED" && a.ip === "41.58.0.7" && (a.detail as { level?: string }).level === "200"));
});
test("17. Representatives: list / filter, deactivate / reinstate, revoke (immediate, final) and per-department views", async () => {
  const w = makeHodWorld();
  const cr = await w.svc.appointRepresentative(hodC, { studentId: "john", level: "200", role: "COURSE_REP" });
  const acr = await w.svc.appointRepresentative(hodC, { studentId: "ada", level: "200", role: "ASSISTANT_COURSE_REP" });
  await w.svc.appointRepresentative(hodM, { studentId: "mia", level: "200", role: "COURSE_REP" });
  assert.equal((await w.svc.listRepresentatives(hodC, q())).total, 2);
  assert.equal((await w.svc.listRepresentatives(hodM, q())).total, 1);
  assert.deepEqual((await w.svc.listRepresentatives(hodC, q({ role: "ASSISTANT_COURSE_REP" }))).items.map((r) => r.id), [acr.id]);
  assert.equal((await w.svc.listRepresentatives(hodC, q({ level: "200", academicSession: S, semester: "FIRST" }))).total, 2);
  assert.equal((await w.svc.listRepresentatives(hodC, q({ level: "300" }))).total, 0);
  assert.equal((await w.svc.listRepresentatives(hodC, q({ search: "obi" }))).total, 1);
  assert.equal((await w.svc.setRepresentativeStatus(hodC, cr.id, "INACTIVE", meta)).status, "INACTIVE");
  assert.equal((await rejection(w.svc.setRepresentativeStatus(hodC, cr.id, "INACTIVE"))).code, "ASSIGNMENT_STATUS_REFUSED");
  assert.equal((await w.svc.setRepresentativeStatus(hodC, cr.id, "ACTIVE")).status, "ACTIVE");
  await w.svc.revokeRepresentative(hodC, cr.id, meta);
  assert.equal(w.store.repAssigns.find((r) => r.id === cr.id)!.status, "REVOKED");
  assert.equal((await rejection(w.svc.revokeRepresentative(hodC, cr.id))).code, "ASSIGNMENT_REVOKED");
  assert.equal((await rejection(w.svc.setRepresentativeStatus(hodC, cr.id, "ACTIVE"))).code, "ASSIGNMENT_REVOKED"); // revoked = final; appoint again
  assert.equal((await w.svc.appointRepresentative(hodC, { studentId: "sam", level: "200", role: "COURSE_REP" })).role, "COURSE_REP"); // slot is free again
  // reinstating can't create a second Course Rep for the level
  await w.svc.setRepresentativeStatus(hodC, w.store.repAssigns.find((r) => r.studentId === "sam")!.id, "INACTIVE");
  const again = await w.svc.appointRepresentative(hodC, { studentId: "tola", level: "200", role: "COURSE_REP" });
  assert.equal((await rejection(w.svc.setRepresentativeStatus(hodC, w.store.repAssigns.find((r) => r.studentId === "sam")!.id, "ACTIVE"))).code, "ASSIGNMENT_DUPLICATE");
  assert.equal(again.level, "200");
  assert.ok(w.notes.some((n) => n.who === "john" && n.title.includes("ended")));
});
test("17a. Representative DTOs keep the student's name even when the store hands back a document-like object (names as prototype getters)", async () => {
  const w = makeHodWorld();
  const cr = await w.svc.appointRepresentative(hodC, { studentId: "john", level: "200", role: "COURSE_REP" });
  // what a Mongoose document looks like to object spread: the names live on the prototype, not as own properties
  class DocLike { constructor(private d: { f: string; l: string; m: string }) {} get firstName() { return this.d.f; } get lastName() { return this.d.l; } get matricNumber() { return this.d.m; } }
  w.store.repAssigns.find((r) => r.id === cr.id)!.student = new DocLike({ f: "John", l: "Doe", m: "25/208CSC/987" }) as never;
  const listed = (await w.svc.listRepresentatives(hodC, q())).items[0];
  assert.deepEqual([listed.student.firstName, listed.student.lastName, listed.student.matricNumber], ["John", "Doe", "25/208CSC/987"]);
  assert.match(read("src/services/hod/mongo-store.ts"), /student: student \? \{ firstName: student\.firstName, lastName: student\.lastName, matricNumber: student\.matricNumber \}/); // the store copies plain fields
});
test("17b. A level appointment shows on every course of that level (HOD course detail), and only on that level", async () => {
  const w = makeHodWorld();
  await w.svc.appointRepresentative(hodC, { studentId: "john", level: "200", role: "COURSE_REP" });
  const reps = async (courseId: string) => ((await w.svc.getCourse(hodC, courseId)) as unknown as { representatives: { role: string; student: { matricNumber: string } }[] }).representatives;
  assert.deepEqual((await reps(w.csc201.id)).map((r) => [r.role, r.student.matricNumber]), [["COURSE_REP", "25/208CSC/987"]]);
  assert.deepEqual((await reps(w.csc101.id)).length, 0); // a 100-level course is not covered
});

/* ============================ timetable / announcements / documents ============================ */
test("18. Timetable: HOD reviews it and sees clashes; there is no edit / override (the Course Rep owns the class timetable)", async () => {
  const w = makeHodWorld();
  const t = await w.svc.listTimetable(hodC, q());
  assert.equal(t.readOnly, true);
  assert.deepEqual(t.items.map((e) => e.id).sort(), ["t1", "t2", "t3"]); // no MLS entry
  assert.deepEqual((await w.svc.listTimetable(hodC, q({ source: "CLASS_REP" }))).items.map((e) => e.id), ["t2"]);
  assert.deepEqual((await w.svc.listTimetable(hodC, q({ courseId: w.csc201.id }))).items.map((e) => e.id), ["t1"]);
  assert.deepEqual((await w.svc.listTimetable(hodC, q({ day: "TUE" }))).items.map((e) => e.id), ["t3"]);
  assert.deepEqual((await w.svc.listTimetable(hodC, q({ level: "100" }))).items.map((e) => e.id), ["t3"]);
  const c = await w.svc.timetableConflicts(hodC);
  assert.deepEqual(c.conflicts.map((x) => x.type).sort(), ["VENUE", "LEVEL"].sort()); // t1 & t2: same LT1 slot, same level
  assert.equal((await w.svc.timetableConflicts(hodM)).conflicts.length, 0);
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(w.svc));
  assert.ok(!methods.some((m) => /timetable/i.test(m) && !/^(listTimetable|timetableConflicts|timetableDTO)$/.test(m)), "only read methods may exist for the timetable");
  assert.equal(w.store.timetable.length, 4);
});
test("19. Announcements: department-wide or level-targeted, edit / unpublish / delete own, never someone else's; no university-wide", async () => {
  const w = makeHodWorld();
  const a = await w.svc.createAnnouncement(hodC, { title: "Departmental meeting", content: "Friday 2pm", priority: "IMPORTANT" }, meta);
  const rec = w.store.announcements.find((x) => x.id === a.id)!;
  assert.deepEqual([rec.departmentId, rec.scope, rec.hodId, rec.authorRole, rec.status], [CSC, "DEPARTMENT", "hodC", "HOD", "PUBLISHED"]);
  const lvl = await w.svc.createAnnouncement(hodC, { title: "200 level exam info", content: "Hall B", levels: ["200", "200"] });
  assert.deepEqual([lvl.scope, lvl.levels], ["LEVEL", ["200"]]);
  assert.equal((await rejection(w.svc.createAnnouncement(hodC, { title: "x", content: "yyyy", levels: ["500"] }))).code, "INVALID_LEVEL");
  assert.deepEqual(w.notes.filter((n) => n.who.startsWith("dept:")).map((n) => n.who), [`dept:${CSC}:all`, `dept:${CSC}:200`]);
  assert.equal((await w.svc.updateAnnouncement(hodC, a.id, { content: "Friday 3pm", published: false }, meta)).published, false);
  assert.equal((await w.svc.updateAnnouncement(hodC, a.id, { published: true })).published, true);
  const list = await w.svc.listAnnouncements(hodC, q());
  assert.ok(list.items.some((x) => x.id === "a-lec" && x.canEdit === false)); // sees the lecturer's note, can't change it
  assert.equal((await rejection(w.svc.updateAnnouncement(hodC, "a-lec", { title: "hijack" }))).code, "NOT_OWNER");
  assert.equal((await rejection(w.svc.deleteAnnouncement(hodC, "a-lec"))).code, "NOT_OWNER");
  assert.equal((await w.svc.listAnnouncements(hodC, q({ mine: true }))).total, 2);
  await w.svc.deleteAnnouncement(hodC, a.id, meta);
  assert.equal(w.store.announcements.find((x) => x.id === a.id)!.status, "DELETED");
  assert.equal((await rejection(w.svc.updateAnnouncement(hodC, a.id, { title: "again" }))).status, 404);
});
test("20. Department documents are their own record type; the materials view is read-only and shows real owners", async () => {
  const w = makeHodWorld();
  const d = await w.svc.createDocument(hodC, { title: "Handbook", levels: ["100"], file: { buffer: Buffer.from("%PDF"), originalName: "hb.pdf" } }, meta);
  assert.deepEqual([d.published, d.levels], [true, ["100"]]);
  assert.equal((await rejection(w.svc.createDocument(hodC, { title: "x", fileUrl: "https://x.example", file: { buffer: Buffer.from("x"), originalName: "a.pdf" } }))).code, "INVALID_RESOURCE_SOURCE");
  assert.equal((await w.svc.updateDocument(hodC, d.id, { published: false, title: "Handbook v2" })).published, false);
  await w.svc.deleteDocument(hodC, d.id, meta);
  assert.deepEqual(w.deleted, ["pub-hb.pdf"]);
  const mats = await w.svc.materialsOverview(hodC, q());
  assert.deepEqual(mats.items.map((m) => [m.id, m.owner.role, m.readOnly]).sort(), [["m1", "LECTURER", true], ["m2", "COURSE_REP", true]]);
  assert.equal((await w.svc.materialsOverview(hodC, q({ type: "CLASS_RESOURCE" }))).total, 1);
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(w.svc));
  assert.ok(!methods.some((m) => /material/i.test(m) && m !== "materialsOverview"), "the HOD can't edit lecturer materials or class resources");
});

/* ============================ attendance oversight ============================ */
test("21. Attendance oversight: sessions, filters, detail, statistics, issues; strictly read-only", async () => {
  const w = makeHodWorld();
  const list = await w.svc.listAttendanceSessions(hodC, q());
  assert.deepEqual(list.items.map((s) => s.id).sort(), ["s-open", "s-past1", "s-past2"]); // no MLS session
  const open = list.items.find((s) => s.id === "s-open")!;
  assert.deepEqual([open.state, open.lecturer, open.present, open.enrolled, open.allowedRadiusInMeters], ["OPEN", "Amina Bello", 1, 3, 100]);
  assert.deepEqual((await w.svc.listAttendanceSessions(hodC, q({ state: "CLOSED" }))).items.map((s) => s.id).sort(), ["s-past1", "s-past2"]);
  assert.equal((await w.svc.listAttendanceSessions(hodC, q({ lecturerId: "lecA" }))).total, 3);
  assert.equal((await w.svc.listAttendanceSessions(hodC, q({ courseId: w.csc201.id }))).total, 3);
  assert.equal((await w.svc.listAttendanceSessions(hodC, q({ courseId: w.mls201.id }))).total, 0); // another department's course id: nothing
  const d = await w.svc.getAttendanceSession(hodC, "s-open");
  assert.deepEqual([d.counts, d.flaggedAttempts, d.readOnly, d.records[0].distanceMeters], [{ present: 1, late: 0, enrolled: 3, absent: 2 }, 2, true, 20]);
  const st = await w.svc.attendanceStatistics(hodC);
  assert.deepEqual(st.courses.map((c) => [c.courseCode, c.sessionsHeld, c.attendancePercentage, c.attendanceIssue]), [["CSC201", 3, 22.2, true]]); // 2 of 9 possible
  assert.equal(st.coursesWithIssues, 1);
  assert.equal((await w.svc.attendanceStatistics(hodM)).courses[0].courseCode, "MLS201");
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(w.svc));
  assert.ok(!methods.some((m) => /^(create|mark|edit|delete|update|close|open|correct|add|set|remove|revoke)\w*(attendance|session)/i.test(m)), `no attendance write methods: ${methods.join(",")}`);
  assert.equal(w.store.records.length, 3); // untouched
});

/* ============================ complaints ============================ */
test("22. Complaints: list / filter / search / paginate / view; only the department's own", async () => {
  const w = makeHodWorld();
  const all = await w.svc.listComplaints(hodC, q());
  assert.deepEqual(all.items.map((c) => c.id).sort(), ["1", "2"]);
  assert.deepEqual((await w.svc.listComplaints(hodC, q({ type: "COURSE" }))).items.map((c) => c.id), ["1"]);
  assert.deepEqual((await w.svc.listComplaints(hodC, q({ status: "SUBMITTED", courseId: w.csc201.id }))).items.map((c) => c.id), ["1"]);
  assert.deepEqual((await w.svc.listComplaints(hodC, q({ search: "clash" }))).items.map((c) => c.id), ["2"]);
  assert.deepEqual((await w.svc.listComplaints(hodC, q({ search: "24/208CSC/055" }))).items.map((c) => c.id), ["2"]);
  assert.equal((await w.svc.listComplaints(hodC, q({ limit: 1 }))).totalPages, 2);
  assert.equal((await w.svc.listComplaints(hodC, q({ from: new Date(T0.getTime() + 1000) }))).total, 0);
  const d = await w.svc.getComplaint(hodC, "1");
  assert.deepEqual([d.student.matricNumber, d.course?.courseCode, d.status, d.timeline?.length], ["25/208CSC/987", "CSC201", "SUBMITTED", 1]);
  assert.equal((await w.svc.listComplaints(hodM, q())).items[0].id, "m1");
});
test("23. Complaints: review -> assign -> respond -> resolve; the student sees each step; rules enforced", async () => {
  const w = makeHodWorld();
  const r1 = await w.svc.setComplaintStatus(hodC, "1", { status: "UNDER_REVIEW", note: "Looking into it" }, meta);
  assert.equal(r1.status, "UNDER_REVIEW");
  // course complaint -> only a lecturer assigned to that course
  assert.equal((await rejection(w.svc.assignComplaint(hodC, "1", { lecturerId: "lecI" }))).code, "ASSIGNEE_REFUSED"); // not active
  assert.equal((await rejection(w.svc.assignComplaint(hodC, "1", { lecturerId: "lecS" }))).code, "ASSIGNEE_REFUSED");
  await w.svc.assignLecturerToCourse(hodC, "lecI", w.csc202.id);
  assert.equal((await rejection(w.svc.assignComplaint(hodC, "1", { lecturerId: "lecM" }))).code, "ASSIGNEE_REFUSED"); // another department's lecturer
  const a = await w.svc.assignComplaint(hodC, "1", { lecturerId: "lecA", note: "Please check the marks" }, meta);
  assert.deepEqual([a.status, a.assignedTo?.id], ["ASSIGNED", "lecA"]);
  assert.ok(w.notes.some((n) => n.who === "lecA" && n.title.includes("forwarded to you")));
  const resp = await w.svc.respondToComplaint(hodC, "1", { message: "The lecturer is reviewing this." }, meta);
  assert.equal(resp.status, "ASSIGNED"); // a reply doesn't change an advanced status
  assert.equal((await rejection(w.svc.setComplaintStatus(hodC, "1", { status: "RESOLVED" }))).code, "RESOLUTION_REQUIRED");
  const done = await w.svc.setComplaintStatus(hodC, "1", { status: "RESOLVED", resolution: "Marks corrected." }, meta);
  assert.deepEqual([done.status, done.resolution, done.resolvedAt instanceof Date], ["RESOLVED", "Marks corrected.", true]);
  assert.deepEqual(done.timeline?.map((e) => e.status), ["SUBMITTED", "UNDER_REVIEW", "ASSIGNED", "ASSIGNED", "RESOLVED"]);
  assert.equal((await rejection(w.svc.setComplaintStatus(hodC, "1", { status: "UNDER_REVIEW" }))).code, "COMPLAINT_TRANSITION_REFUSED"); // resolved can only close
  assert.equal((await w.svc.setComplaintStatus(hodC, "1", { status: "CLOSED" })).status, "CLOSED");
  assert.equal((await rejection(w.svc.respondToComplaint(hodC, "1", { message: "more" }))).code, "COMPLAINT_CLOSED");
  const kinds = w.notes.filter((n) => n.who === "john").map((n) => n.kind);
  assert.deepEqual(kinds, ["STATUS_CHANGED", "ASSIGNED", "RESPONSE", "RESOLVED", "STATUS_CHANGED"]);
  const actions = w.store.audit.map((x) => x.action);
  for (const x of ["COMPLAINT_STATUS_CHANGED", "COMPLAINT_ASSIGNED", "COMPLAINT_RESPONDED", "COMPLAINT_RESOLVED"]) assert.ok(actions.includes(x), x);
});
test("24. Complaints: reject needs a reason; a first reply starts the review; HOD-type complaints go to any active lecturer; the invalid path 'assign' via status is refused", async () => {
  const w = makeHodWorld();
  assert.equal((await rejection(w.svc.setComplaintStatus(hodC, "2", { status: "REJECTED" }))).code, "REASON_REQUIRED");
  assert.equal((await rejection(w.svc.setComplaintStatus(hodC, "2", { status: "ASSIGNED" }))).code, "COMPLAINT_TRANSITION_REFUSED"); // must use /assign
  const r = await w.svc.respondToComplaint(hodC, "2", { message: "We will look at the timetable." });
  assert.equal(r.status, "UNDER_REVIEW");
  assert.equal((await w.svc.assignComplaint(hodC, "2", { lecturerId: "lecA" })).status, "ASSIGNED"); // no course on this complaint
  const rej = await w.svc.setComplaintStatus(hodC, "2", { status: "REJECTED", note: "Not within the department's remit." });
  assert.equal(rej.status, "REJECTED");
  assert.equal((await rejection(w.svc.setComplaintStatus(hodC, "2", { status: "CLOSED" }))).code, "COMPLAINT_TRANSITION_REFUSED");
  assert.equal(w.store.complaints.find((c) => c.id === "m1")!.status, "SUBMITTED"); // MLS complaint untouched
});

/* ============================ notifications / profile / escalation ============================ */
test("25. HOD notifications: own only; mark read / read-all", async () => {
  const w = makeHodWorld();
  const row = (id: string, who: string, read = false) => w.store.notifications.push({ id, recipientId: who, kind: "SUBMITTED", title: id, body: "b", read, createdAt: new Date() });
  row("n1", "hodC"); row("n2", "hodC", true); row("n3", "hodM");
  const l = await w.svc.listNotifications(hodC, { page: 1, limit: 10 });
  assert.deepEqual([l.items.map((n) => n.id).sort(), l.unreadCount], [["n1", "n2"], 1]);
  assert.equal((await rejection(w.svc.markNotificationRead(hodC, "n3"))).status, 404);
  assert.equal((await w.svc.markNotificationRead(hodC, "n1")).read, true);
  assert.equal((await w.svc.markAllNotificationsRead(hodM)).updated, 1);
  assert.equal((await w.svc.dashboard(hodC)).unreadNotifications, 0);
});
test("26. Privilege escalation: a HOD can only change their phone; role / department / staffId / email are unreachable", async () => {
  const w = makeHodWorld();
  const before = { ...w.store.hods.find((h) => h.id === "hodC")! };
  const p = await w.svc.updateProfile(hodC, { phone: "+2348099999999", ...({ role: "SUPER_ADMIN", departmentId: MLS, department: MLS, staffId: "X", email: "evil@x.example", permissions: ["*"] } as object) }, meta);
  assert.equal(p.phone, "+2348099999999");
  const after = w.store.hods.find((h) => h.id === "hodC")!;
  assert.deepEqual([after.role, after.departmentId, after.staffId, after.email, after.status], [before.role, before.departmentId, before.staffId, before.email, before.status]);
  assert.equal((await w.svc.getProfile(hodC)).department?.code, "CSC");
  await w.svc.setProfilePhoto(hodC, Buffer.from([0xff, 0xd8, 0xff]));
  await w.svc.setProfilePhoto(hodC, Buffer.from([0xff, 0xd8, 0xff]));
  assert.equal(w.deleted.length, 1); // the previous image was removed, the new one kept
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(w.svc));
  assert.ok(!methods.some((m) => /(role|permission|superadmin|promote|createHod|setDepartment|changeDepartment)/i.test(m)), methods.join(","));
});
test("27. Recent activity feeds from HOD, lecturer and representative actions of the department only", async () => {
  const w = makeHodWorld();
  w.store.otherActivity.push({ departmentId: CSC, source: "LECTURER", action: "ATTENDANCE_SESSION_CREATED", actorName: "Amina Bello", role: "LECTURER", courseCode: "CSC201", at: new Date(T0.getTime() - 1000) }, { departmentId: MLS, source: "LECTURER", action: "MATERIAL_UPLOADED", at: new Date(T0.getTime() - 500) });
  await w.svc.createAnnouncement(hodC, { title: "Hello", content: "world!" }, meta);
  const act = (await w.svc.dashboard(hodC)).recentActivity;
  assert.ok(act.some((a) => a.source === "LECTURER" && a.action === "ATTENDANCE_SESSION_CREATED"));
  assert.ok(act.some((a) => a.source === "HOD" && a.action === "ANNOUNCEMENT_CREATED"));
  assert.ok(!act.some((a) => a.action === "MATERIAL_UPLOADED")); // the MLS item
});
test("28. Every important HOD action is audited with actor, role, department, resource, id and IP", async () => {
  const w = makeHodWorld();
  const l = await w.svc.createLecturer(hodC, { firstName: "A", lastName: "B", email: "ab@uni.example", staffId: "CSC-77" }, meta);
  await w.svc.setLecturerStatus(hodC, "lecA", "SUSPENDED", meta);
  await w.svc.assignLecturerToCourse(hodC, "lecI", w.csc202.id, meta);
  const c = await w.svc.createCourse(hodC, { courseCode: "CSC360", title: "x", units: 3, level: "300", semester: "FIRST" }, meta);
  await w.svc.updateCourse(hodC, c.id, { title: "y" }, meta);
  await w.svc.setComplaintStatus(hodC, "1", { status: "UNDER_REVIEW" }, meta);
  await w.svc.createAnnouncement(hodC, { title: "T", content: "contents" }, meta);
  await w.svc.updateDepartmentSettings(hodC, { faculty: "New" }, meta);
  const got = new Set(w.store.audit.map((a) => a.action));
  for (const x of ["LECTURER_CREATED", "LECTURER_STATUS_CHANGED", "LECTURER_ASSIGNED_TO_COURSE", "COURSE_CREATED", "COURSE_UPDATED", "COMPLAINT_STATUS_CHANGED", "ANNOUNCEMENT_CREATED", "DEPARTMENT_SETTINGS_CHANGED"]) assert.ok(got.has(x), x);
  const e = w.store.audit.find((a) => a.action === "LECTURER_CREATED")!;
  assert.deepEqual([e.actorId, e.actorName, e.role, e.departmentId, e.resourceType, e.resourceId, e.ip], ["hodC", "Hope Chief", "HOD", CSC, "LECTURER", l.id, "41.58.0.7"]);
  assert.ok(e.at instanceof Date);
  assert.ok(w.store.audit.every((a) => a.departmentId === CSC)); // nothing leaks into another department's trail
});
