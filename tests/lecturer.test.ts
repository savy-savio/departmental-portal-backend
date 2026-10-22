import { test } from "node:test";
import assert from "node:assert/strict";
import { AttendanceSecurityService } from "../src/services/attendance/attendance-security.service";
import { MemoryStore as AttendanceMemoryStore } from "./helpers/memory-store";
import { actor as attendanceActor, config as attendanceConfig, meta as studentMeta } from "./helpers/world";
import { CSC, FAR, MLS, NEAR, S, actor, makeLecturerWorld, meta, rejection } from "./helpers/lecturer-world";

const studentActor = (id: string) => attendanceActor(id, CSC); // students live in the same department as the lecturer world
const lecA = actor("lecA");    // CSC201 + CSC203
const lecB = actor("lecB");    // CSC202
const lecC = actor("lecC");    // CSC201 (co-lecturer)
const lecM = actor("lecM", MLS); // MLS201
const none = actor("lecNone"); // no assignments

const session = (over: object = {}) => ({ latitude: CAMPUS_LAT, longitude: CAMPUS_LNG, allowedRadiusInMeters: 100, ...over });
const CAMPUS_LAT = 6.5244, CAMPUS_LNG = 3.3792;
const work = (over: object = {}) => ({ title: "Linked lists", description: "Implement a list", dueDate: new Date("2026-11-20T23:59:00Z"), ...over });

/* ============================ authorization ============================ */
test("A. A lecturer sees only the courses assigned to her, for the current term", async () => {
  const w = makeLecturerWorld();
  assert.deepEqual((await w.svc.listCourses(lecA)).map((c) => c.courseCode).sort(), ["CSC201", "CSC203"]);
  assert.deepEqual((await w.svc.listCourses(lecB)).map((c) => c.courseCode), ["CSC202"]);
  assert.deepEqual(await w.svc.listCourses(none), []);
  const c = await w.svc.getCourse(lecA, w.csc201.id);
  assert.equal(c.enrolledCount, 3);
  assert.deepEqual(c.schedule.map((s) => s.dayOfWeek), ["MON", "FRI"]); // official + class-rep slot, no draft
});
test("B. She cannot reach an unassigned course (same answer as 'other department' or 'doesn't exist')", async () => {
  const w = makeLecturerWorld();
  for (const id of [w.csc202.id, w.mls201.id, "c-nope"]) {
    assert.equal((await rejection(w.svc.getCourse(lecA, id))).code, "NOT_ASSIGNED_TO_COURSE");
    assert.equal((await rejection(w.svc.listStudents(lecA, id, { page: 1, limit: 10 }))).code, "NOT_ASSIGNED_TO_COURSE");
    assert.equal((await rejection(w.svc.listMaterials(lecA, id))).code, "NOT_ASSIGNED_TO_COURSE");
    assert.equal((await rejection(w.svc.createCourseWork(lecA, id, work()))).code, "NOT_ASSIGNED_TO_COURSE");
    assert.equal((await rejection(w.svc.createAttendanceSession(lecA, id, session()))).code, "NOT_ASSIGNED_TO_COURSE");
    assert.equal((await rejection(w.svc.listAttendanceSessions(lecA, id))).code, "NOT_ASSIGNED_TO_COURSE");
    assert.equal((await rejection(w.svc.attendanceStatistics(lecA, id))).code, "NOT_ASSIGNED_TO_COURSE");
    assert.equal((await rejection(w.svc.getTimetable(lecA, { courseId: id }))).code, "NOT_ASSIGNED_TO_COURSE");
  }
  assert.equal((await rejection(w.svc.getCourse(none, w.csc201.id))).code, "NOT_ASSIGNED_TO_COURSE");
});
test("C. Multi-department: a CSC lecturer can't touch MLS and an MLS lecturer can't touch CSC", async () => {
  const w = makeLecturerWorld();
  assert.equal((await rejection(w.svc.getCourse(lecA, w.mls201.id))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.getCourse(lecM, w.csc201.id))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.createAnnouncement(lecM, { courseId: w.csc201.id, title: "x", content: "yyyy" }))).code, "NOT_ASSIGNED_TO_COURSE");
  // forging the department on the identity doesn't help: assignments belong to the lecturer's own department
  assert.equal((await rejection(w.svc.getCourse({ ...lecA, departmentId: MLS }, w.mls201.id))).code, "NOT_ASSIGNED_TO_COURSE");
  // each lecturer only ever sees her own department's students / timetable
  assert.deepEqual((await w.svc.listStudents(lecM, w.mls201.id, { page: 1, limit: 10 })).items.map((s) => s.studentId), ["mia"]);
  assert.ok((await w.svc.getTimetable(lecM, {})).entries.every((e) => e.courseCode === "MLS201"));
  assert.ok((await w.svc.getTimetable(lecA, {})).entries.every((e) => e.courseCode === "CSC201"));
  // a CSC announcement id looked up by an MLS lecturer is simply not found
  const a = await w.svc.createAnnouncement(lecA, { courseId: w.csc201.id, title: "CSC only", content: "body text" });
  assert.equal((await rejection(w.svc.updateAnnouncement(lecM, a.id, { title: "x" }))).status, 404);
});
test("D. Revoked / inactive / old-term assignments stop working immediately", async () => {
  const w = makeLecturerWorld();
  const a = await w.svc.createAnnouncement(lecA, { courseId: w.csc201.id, title: "Before", content: "body text" });
  w.aA201.status = "REVOKED";
  assert.equal((await rejection(w.svc.getCourse(lecA, w.csc201.id))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.updateAnnouncement(lecA, a.id, { title: "After" }))).status, 404);
  assert.deepEqual((await w.svc.listCourses(lecA)).map((c) => c.courseCode), ["CSC203"]); // her other course is unaffected
  assert.equal((await w.svc.getCourse(lecC, w.csc201.id)).courseCode, "CSC201");            // the co-lecturer is unaffected
  w.aA201.status = "ACTIVE";
  w.store.terms.set(CSC, { academicSession: S, semester: "SECOND" });
  assert.deepEqual(await w.svc.listCourses(lecA), []); // last term's assignments are inert until renewed
});

/* ============================ materials ============================ */
test("E. Materials: create (file or link), read, update, delete; official type only; students notified", async () => {
  const w = makeLecturerWorld();
  const m = await w.svc.createMaterial(lecA, w.csc201.id, { title: "Lecture 1", description: "Intro", file: { buffer: Buffer.from("%PDF"), originalName: "l1.pdf" } }, meta);
  assert.equal(m.published, true);
  const rec = w.store.materials.find((x) => x.id === m.id)!;
  assert.deepEqual([rec.type, rec.lecturerId, rec.departmentId, rec.courseCode, rec.academicSession, rec.uploadedByRole], ["OFFICIAL_COURSE_MATERIAL", "lecA", CSC, "CSC201", S, "LECTURER"]);
  const link = await w.svc.createMaterial(lecA, w.csc201.id, { title: "Reading", fileUrl: "https://x.example/r", published: false });
  assert.equal(link.published, false);
  assert.deepEqual(w.notified.map((n) => n.kind), ["MATERIAL"]); // the hidden one didn't notify
  assert.deepEqual((await w.svc.listMaterials(lecA, w.csc201.id)).map((x) => x.title).sort(), ["Lecture 1", "Reading"]);
  const u = await w.svc.updateMaterial(lecA, m.id, { title: "Lecture 1 v2", published: false }, meta);
  assert.equal(u.title, "Lecture 1 v2");
  assert.equal(u.published, false);
  await w.svc.deleteMaterial(lecA, m.id, meta);
  assert.ok(!w.store.materials.some((x) => x.id === m.id));
  assert.deepEqual(w.deleted, ["pub-l1.pdf"]);
  assert.equal((await rejection(w.svc.createMaterial(lecA, w.csc201.id, { title: "both", fileUrl: "https://x.example", file: { buffer: Buffer.from("x"), originalName: "a.pdf" } }))).code, "INVALID_RESOURCE_SOURCE");
});
test("F. Materials: a colleague's, another course's, another department's and a rep's resource can't be changed", async () => {
  const w = makeLecturerWorld();
  const mine = await w.svc.createMaterial(lecA, w.csc201.id, { title: "Mine", fileUrl: "https://x.example/m" });
  const theirs = await w.svc.createMaterial(lecB, w.csc202.id, { title: "B's", fileUrl: "https://x.example/b" });
  const mls = await w.svc.createMaterial(lecM, w.mls201.id, { title: "MLS", fileUrl: "https://x.example/l" });
  assert.equal((await rejection(w.svc.updateMaterial(lecC, mine.id, { title: "hijack" }))).code, "NOT_OWNER"); // same course, not hers
  assert.equal((await rejection(w.svc.deleteMaterial(lecC, mine.id))).code, "NOT_OWNER");
  assert.equal((await rejection(w.svc.updateMaterial(lecA, theirs.id, { title: "hijack" }))).status, 404);   // other course
  assert.equal((await rejection(w.svc.deleteMaterial(lecA, theirs.id))).status, 404);
  assert.equal((await rejection(w.svc.deleteMaterial(lecA, mls.id))).status, 404);                           // other department
  assert.equal((await rejection(w.svc.updateMaterial(lecA, "rep-res", { title: "hijack" }))).status, 404);   // a rep's class resource is a different record type
  assert.equal(w.store.materials.find((m) => m.id === "rep-res")!.title, "Past questions");
  assert.equal(w.store.materials.find((m) => m.id === mine.id)!.title, "Mine");
  // class resources never appear in the lecturer's official list
  assert.ok(!(await w.svc.listMaterials(lecA, w.csc201.id)).some((m) => m.id === "rep-res"));
});

/* ============================ announcements ============================ */
test("G. Announcements: create (course class only), read, update, unpublish, delete", async () => {
  const w = makeLecturerWorld();
  const a = await w.svc.createAnnouncement(lecA, { courseId: w.csc201.id, title: "Test Friday", content: "Chapters 1-3", priority: "URGENT" }, meta);
  const rec = w.store.announcements.find((x) => x.id === a.id)!;
  assert.deepEqual([rec.courseCode, rec.departmentId, rec.lecturerId, rec.authorRole, rec.academicSession, rec.status], ["CSC201", CSC, "lecA", "LECTURER", S, "PUBLISHED"]);
  assert.deepEqual(w.notified, [{ courseCode: "CSC201", kind: "ANNOUNCEMENT" }]);
  const listed = await w.svc.listAnnouncements(lecA, {});
  assert.ok(!listed.some((x) => x.id === "rep-ann")); // a course representative's announcement is NOT shown to lecturers
  assert.ok(listed.some((x) => x.id === a.id));
  assert.equal((await w.svc.updateAnnouncement(lecA, a.id, { content: "Chapters 1-4" }, meta)).content, "Chapters 1-4");
  assert.equal((await w.svc.updateAnnouncement(lecA, a.id, { published: false }, meta)).published, false);
  w.notified.length = 0;
  await w.svc.updateAnnouncement(lecA, a.id, { published: true });
  assert.equal(w.notified.length, 1);
  await w.svc.deleteAnnouncement(lecA, a.id, meta);
  assert.equal(w.store.announcements.find((x) => x.id === a.id)!.status, "DELETED");
  assert.equal((await rejection(w.svc.updateAnnouncement(lecA, a.id, { title: "again" }))).status, 404);
});
test("H. Announcements: other lecturers' / reps' / other departments' announcements can't be changed", async () => {
  const w = makeLecturerWorld();
  const mine = await w.svc.createAnnouncement(lecA, { courseId: w.csc201.id, title: "Mine", content: "body text" });
  const b = await w.svc.createAnnouncement(lecB, { courseId: w.csc202.id, title: "B's", content: "body text" });
  assert.equal((await rejection(w.svc.updateAnnouncement(lecA, b.id, { title: "hijack" }))).status, 404);
  assert.equal((await rejection(w.svc.deleteAnnouncement(lecA, b.id))).status, 404);
  assert.equal((await rejection(w.svc.updateAnnouncement(lecC, mine.id, { title: "hijack" }))).code, "NOT_OWNER");
  assert.equal((await rejection(w.svc.deleteAnnouncement(lecC, mine.id))).code, "NOT_OWNER");
  assert.deepEqual((await rejection(w.svc.updateAnnouncement(lecA, "rep-ann", { title: "hijack" }))).code, "NOT_FOUND"); // a rep's note is invisible to lecturers: it looks like a missing id
  assert.equal((await rejection(w.svc.deleteAnnouncement(lecA, "rep-ann"))).status, 404);
  assert.equal((await rejection(w.svc.updateAnnouncement(lecM, mine.id, { title: "x" }))).status, 404);
  assert.equal(w.store.announcements.find((x) => x.id === "rep-ann")!.title, "Rep note");
  // there is no system-wide / cross-course announcement
  assert.equal((await rejection(w.svc.createAnnouncement(lecA, { courseId: w.csc202.id, title: "x", content: "yyyy" }))).code, "NOT_ASSIGNED_TO_COURSE");
});

/* ============================ assignments ============================ */
test("I. Assignments: create (draft), publish, update, unpublish, view submissions, delete (refused once students have submitted)", async () => {
  const w = makeLecturerWorld();
  const a = await w.svc.createCourseWork(lecA, w.csc201.id, work({ fileUrl: "https://x.example/brief" }), meta);
  assert.equal(a.published, false);
  assert.equal(a.attachment?.url, "https://x.example/brief");
  const rec = w.store.work.find((x) => x.id === a.id)!;
  assert.deepEqual([rec.lecturerId, rec.departmentId, rec.courseCode, rec.academicSession, rec.status], ["lecA", CSC, "CSC201", S, "DRAFT"]);
  assert.equal(w.notified.length, 0);
  const pub = await w.svc.updateCourseWork(lecA, a.id, { published: true }, meta);
  assert.equal(pub.published, true);
  assert.deepEqual(w.notified, [{ courseCode: "CSC201", kind: "ASSIGNMENT" }]);
  const upd = await w.svc.updateCourseWork(lecA, a.id, { title: "Linked lists v2", dueDate: new Date("2026-12-01T10:00:00Z"), allowLateSubmission: true });
  assert.equal(upd.title, "Linked lists v2");
  assert.equal(upd.allowLateSubmission, true);
  assert.equal((await w.svc.updateCourseWork(lecA, a.id, { published: false })).published, false);
  await w.svc.updateCourseWork(lecA, a.id, { published: true });

  w.store.submissions.push(
    { id: "s1", assignmentId: a.id, studentId: "john", firstName: "John", lastName: "Doe", matricNumber: "25/208CSC/987", submittedAt: new Date("2026-10-11T09:00:00Z"), isLate: false, content: "my answer", file: { name: "a.pdf", mimeType: "application/pdf", sizeBytes: 5, publicId: "priv-1", resourceType: "raw" } },
    { id: "s2", assignmentId: a.id, studentId: "ada", firstName: "Ada", lastName: "Obi", matricNumber: "24/208CSC/055", submittedAt: new Date("2026-12-02T09:00:00Z"), isLate: true },
  );
  const subs = await w.svc.listSubmissions(lecA, a.id, meta);
  assert.deepEqual(subs.summary, { submitted: 2, late: 1, enrolled: 3, notSubmitted: 1 });
  assert.equal(subs.items[0].file?.url, "https://signed.example/priv-1");
  assert.ok(subs.items.every((s) => !("score" in s) && !("grade" in s) && !("feedback" in s))); // no grading in this phase
  assert.equal((await w.svc.listSubmissions(lecC, a.id)).summary.submitted, 2); // a co-lecturer of the course may view them
  assert.equal((await rejection(w.svc.deleteCourseWork(lecA, a.id))).code, "ASSIGNMENT_HAS_SUBMISSIONS");

  const empty = await w.svc.createCourseWork(lecA, w.csc201.id, work({ title: "Unused" }));
  await w.svc.deleteCourseWork(lecA, empty.id, meta);
  assert.ok(!w.store.work.some((x) => x.id === empty.id));
});
test("J. Assignments: due dates must be in the future; other lecturers / courses / departments are blocked", async () => {
  const w = makeLecturerWorld();
  assert.equal((await rejection(w.svc.createCourseWork(lecA, w.csc201.id, work({ dueDate: new Date("2026-01-01T00:00:00Z") })))).code, "INVALID_DUE_DATE");
  const mine = await w.svc.createCourseWork(lecA, w.csc201.id, work());
  assert.equal((await rejection(w.svc.updateCourseWork(lecA, mine.id, { dueDate: new Date("2026-01-01T00:00:00Z") }))).code, "INVALID_DUE_DATE");
  const b = await w.svc.createCourseWork(lecB, w.csc202.id, work());
  const mls = await w.svc.createCourseWork(lecM, w.mls201.id, work());
  assert.equal((await rejection(w.svc.updateCourseWork(lecC, mine.id, { title: "hijack" }))).code, "NOT_OWNER");
  assert.equal((await rejection(w.svc.deleteCourseWork(lecC, mine.id))).code, "NOT_OWNER");
  for (const id of [b.id, mls.id]) {
    assert.equal((await rejection(w.svc.updateCourseWork(lecA, id, { title: "hijack" }))).status, 404);
    assert.equal((await rejection(w.svc.deleteCourseWork(lecA, id))).status, 404);
    assert.equal((await rejection(w.svc.listSubmissions(lecA, id))).status, 404);
  }
  assert.equal(w.store.work.find((x) => x.id === b.id)!.title, "Linked lists");
});

/* ============================ students (read-only) ============================ */
test("K. Lecturers view enrolled students (carryovers too) with no private data, and have no way to change them", async () => {
  const w = makeLecturerWorld();
  const res = await w.svc.listStudents(lecB, w.csc202.id, { page: 1, limit: 10 });
  assert.deepEqual(res.items.map((s) => [s.studentId, s.enrollmentType]).sort(), [["peter", "REGULAR"], ["sam", "CARRYOVER"]]);
  for (const s of res.items) assert.ok(!("email" in s) && !("phone" in s));
  assert.equal((await w.svc.listStudents(lecA, w.csc201.id, { page: 1, limit: 10, search: "obi" })).total, 1);
  // read-only by construction: the engine has no method that writes a student, enrollment, department or role
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(w.svc));
  assert.ok(!methods.some((m) => /student|enrol|department|role|grade|score|result|mark(?!Notification)/i.test(m.replace(/listStudents|markNotification|markAllNotifications/g, ""))), methods.join(","));
});

/* ============================ timetable ============================ */
test("L. Lecturers VIEW the timetable (official + Course Rep entries, never drafts) and cannot change it", async () => {
  const w = makeLecturerWorld();
  const t = await w.svc.getTimetable(lecA, {});
  assert.equal(t.readOnly, true);
  assert.deepEqual(t.entries.map((e) => [e.id, e.source]), [["tt-official", "OFFICIAL"], ["tt-rep", "CLASS_REP"]]);
  assert.ok(!t.entries.some((e) => e.id === "tt-draft"));
  assert.ok(t.entries.every((e) => !("canEdit" in e)));
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(w.svc));
  assert.ok(!methods.some((m) => /timetable/i.test(m) && !/^getTimetable$/.test(m)), "only getTimetable may exist");
  assert.equal(w.store.timetable.length, 4); // untouched
});

/* ============================ attendance ============================ */
test("M. Attendance: the lecturer sets GPS location + radius + window; everything else is derived from the assignment", async () => {
  const w = makeLecturerWorld();
  const s = await w.svc.createAttendanceSession(lecA, w.csc201.id, { latitude: 9.0765, longitude: 7.3986, allowedRadiusInMeters: 100, durationMinutes: 90, code: "4821", title: "Week 3" }, meta);
  assert.deepEqual([s.latitude, s.longitude, s.allowedRadiusInMeters, s.state, s.requiresCode], [9.0765, 7.3986, 100, "OPEN", true]);
  const rec = w.store.sessions.find((x) => x.id === s.id)!;
  assert.deepEqual([rec.departmentId, rec.courseCode, rec.academicSession, rec.semester, rec.lecturerId, rec.status, rec.level], [CSC, "CSC201", S, "FIRST", "lecA", "ACTIVE", "200"]);
  assert.equal(rec.location?.allowedRadiusInMeters, 100);
  assert.notEqual(rec.codeHash, "4821"); // the code is stored hashed
  assert.equal(rec.closesAt.getTime() - rec.opensAt.getTime(), 90 * 60_000);
});
test("N. Attendance validation: coordinates, radius, window and overlap", async () => {
  const w = makeLecturerWorld();
  const bad = async (over: object) => (await rejection(w.svc.createAttendanceSession(lecA, w.csc201.id, session(over)))).code;
  assert.equal(await bad({ latitude: 91 }), "INVALID_ATTENDANCE_SESSION");
  assert.equal(await bad({ longitude: -181 }), "INVALID_ATTENDANCE_SESSION");
  assert.equal(await bad({ latitude: Number.NaN }), "INVALID_ATTENDANCE_SESSION");
  assert.equal(await bad({ allowedRadiusInMeters: 0 }), "INVALID_ATTENDANCE_SESSION");
  assert.equal(await bad({ allowedRadiusInMeters: -50 }), "INVALID_ATTENDANCE_SESSION");
  assert.equal(await bad({ allowedRadiusInMeters: 50_000 }), "INVALID_ATTENDANCE_SESSION");
  assert.equal(await bad({ durationMinutes: 24 * 60 }), "INVALID_ATTENDANCE_SESSION");
  assert.equal(await bad({ startTime: new Date("2026-10-10T08:00:00Z"), endTime: new Date("2026-10-10T09:00:00Z") }), "INVALID_ATTENDANCE_SESSION"); // already over
  assert.equal(await bad({ code: "no spaces!" }), "INVALID_ATTENDANCE_SESSION");
  assert.equal(w.store.sessions.length, 0);
  await w.svc.createAttendanceSession(lecA, w.csc201.id, session());
  assert.equal(await bad({}), "SESSION_OVERLAP");
});
test("N2. The lecturer's own GPS fix must be accurate enough to set the venue; the HTTP schema requires coordinates AND accuracy", async () => {
  const w = makeLecturerWorld();
  const poor = await rejection(w.svc.createAttendanceSession(lecA, w.csc201.id, session({ accuracyMeters: 850 })));
  assert.deepEqual([poor.status, poor.code], [422, "LOCATION_ACCURACY_LOW"]);
  assert.equal(w.store.sessions.length, 0);
  await w.svc.createAttendanceSession(lecA, w.csc201.id, session({ accuracyMeters: 12 }));
  assert.equal(w.store.sessions.length, 1);
  // HTTP boundary (read as text, like the other guard tests): accuracy is a required number on both the lecturer and the student side.
  const fs = await import("node:fs"); const path = await import("node:path");
  const read = (f: string) => fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");
  assert.match(read("src/validators/lecturer.validators.ts"), /accuracyMeters: z\.number\(\{ required_error/);
  assert.match(read("src/validators/student-attendance.validators.ts"), /accuracyMeters: z\.number\(\{ required_error/);
});
test("N3. The accuracy limit is configurable, and a kilometres-wide reading gets an actionable message with details", async () => {
  const w = makeLecturerWorld();
  const approx = await rejection(w.svc.createAttendanceSession(lecA, w.csc201.id, session({ accuracyMeters: 50000 })));
  assert.deepEqual([approx.status, approx.code], [422, "LOCATION_ACCURACY_LOW"]);
  assert.match(approx.message, /approximate location \(about 50 km\)/);
  assert.match(approx.message, /phone with GPS/);
  assert.deepEqual(approx.details, { accuracyMeters: 50000, maxAccuracyMeters: 100, approximate: true });
  const near = await rejection(w.svc.createAttendanceSession(lecA, w.csc201.id, session({ accuracyMeters: 250 })));
  assert.match(near.message, /accurate to about 250 m, but 100 m or better is needed/);
  assert.equal((near.details as { approximate: boolean }).approximate, false);
  // an institution can loosen it (the env schema still caps it at 1000 m)
  (w.svc as unknown as { d: { maxCreatorAccuracyMeters?: number } }).d.maxCreatorAccuracyMeters = 300;
  await w.svc.createAttendanceSession(lecA, w.csc201.id, session({ accuracyMeters: 250 }));
  assert.equal(w.store.sessions.length, 1);
  assert.equal((await rejection(w.svc.createAttendanceSession(lecA, w.csc203.id, session({ accuracyMeters: 50000 })))).code, "LOCATION_ACCURACY_LOW"); // a rough network-based fix is never accepted
});
test("O. Close / reopen / history / live view / statistics", async () => {
  const w = makeLecturerWorld();
  const s = await w.svc.createAttendanceSession(lecA, w.csc201.id, session({ durationMinutes: 120 }), meta);
  const rec = w.store.sessions.find((x) => x.id === s.id)!;
  w.store.records.push(
    { sessionId: s.id, studentId: "john", firstName: "John", lastName: "Doe", matricNumber: "25/208CSC/987", status: "PRESENT", markedAt: new Date("2026-10-10T10:01:00Z"), distanceMeters: 12 },
    { sessionId: s.id, studentId: "ada", firstName: "Ada", lastName: "Obi", matricNumber: "24/208CSC/055", status: "LATE", markedAt: new Date("2026-10-10T10:30:00Z"), distanceMeters: 40 },
  );
  w.store.flagged.set(s.id, 2);
  const live = await w.svc.getAttendanceSession(lecA, s.id, meta);
  assert.deepEqual(live.counts, { present: 1, late: 1, enrolled: 3, absent: 1 });
  assert.equal(live.flaggedAttempts, 2);
  assert.deepEqual(live.notYetMarked.map((m) => m.studentId), ["sam"]);
  assert.deepEqual(live.records.map((r) => [r.studentId, r.distanceMeters]), [["john", 12], ["ada", 40]]);

  const closed = await w.svc.closeAttendanceSession(lecA, s.id, meta);
  assert.equal(closed.state, "CLOSED");
  assert.ok(rec.closesAt.getTime() <= w.clock.now.getTime());
  assert.equal((await rejection(w.svc.closeAttendanceSession(lecA, s.id))).code, "ALREADY_CLOSED");
  const reopened = await w.svc.openAttendanceSession(lecA, s.id, { durationMinutes: 20 }, meta);
  assert.equal(reopened.state, "OPEN");
  assert.equal(rec.closesAt.getTime(), w.clock.now.getTime() + 20 * 60_000);
  assert.equal((await rejection(w.svc.openAttendanceSession(lecA, s.id, { durationMinutes: 999 }))).code, "INVALID_ATTENDANCE_SESSION");

  const history = await w.svc.listAttendanceSessions(lecA, w.csc201.id);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].counts, { present: 1, late: 1, enrolled: 3, absent: 1 });
  const stats = await w.svc.attendanceStatistics(lecA, w.csc201.id);
  assert.equal(stats.sessionsHeld, 1);
  assert.equal(stats.averageAttendancePercentage, 66.7);
  assert.deepEqual(stats.students.map((x) => [x.studentId, x.percentage]).sort(), [["ada", 100], ["john", 100], ["sam", 0]]);
});
test("P. Unauthorized lecturers can't see, close, reopen or create sessions for someone else's class", async () => {
  const w = makeLecturerWorld();
  const mine = await w.svc.createAttendanceSession(lecA, w.csc201.id, session());
  const theirs = await w.svc.createAttendanceSession(lecB, w.csc202.id, session());
  const mls = await w.svc.createAttendanceSession(lecM, w.mls201.id, session());
  assert.equal((await rejection(w.svc.closeAttendanceSession(lecC, mine.id))).code, "NOT_OWNER");   // same course, not the opener
  assert.equal((await rejection(w.svc.openAttendanceSession(lecC, mine.id, {}))).code, "NOT_OWNER");
  for (const id of [theirs.id, mls.id]) {
    assert.equal((await rejection(w.svc.closeAttendanceSession(lecA, id))).status, 404);          // another course / department
    assert.equal((await rejection(w.svc.getAttendanceSession(lecA, id))).status, 404);
    assert.equal((await rejection(w.svc.openAttendanceSession(lecA, id, {}))).status, 404);
  }
  assert.equal((await rejection(w.svc.closeAttendanceSession(none, mine.id))).status, 404);
  assert.equal(w.store.sessions.find((s) => s.id === theirs.id)!.status, "ACTIVE");
  assert.equal((await w.svc.getAttendanceSession(lecC, mine.id)).id, mine.id); // a co-lecturer may VIEW it
});
test("Q. The existing student attendance security still applies to lecturer-created sessions (GPS + device + token + one mark)", async () => {
  const w = makeLecturerWorld();
  const created = await w.svc.createAttendanceSession(lecA, w.csc201.id, { latitude: 6.5244, longitude: 3.3792, allowedRadiusInMeters: 100, durationMinutes: 60 }, meta);
  const lecRec = w.store.sessions.find((s) => s.id === created.id)!;

  // hand the lecturer's session to the (unchanged) student attendance engine
  const store = new AttendanceMemoryStore();
  store.sessions.push(lecRec);
  store.courseCtx.set("john", { term: { academicSession: S, semester: "FIRST" }, enrolledCodes: ["CSC201"] });
  store.courseCtx.set("outsider", { term: { academicSession: S, semester: "FIRST" }, enrolledCodes: ["CSC201"] });
  const pw = new Map([["john", "pw"], ["outsider", "pw"]]);
  const codes: string[] = [];
  const att = new AttendanceSecurityService({
    store, config: attendanceConfig, now: () => new Date(w.clock.now), verifyPassword: async (id, p) => pw.get(id) === p, sendVerificationCode: async (_a, c) => void codes.push(c),
  });
  const register = async (id: string) => {
    await att.requestDeviceVerification(studentActor(id), studentMeta(), "pw");
    return (await att.completeDeviceRegistration(studentActor(id), studentMeta(), { code: codes[codes.length - 1] })).deviceToken;
  };
  const johnPhone = await register("john");
  const outsiderPhone = await register("outsider");
  const attend = async (id: string, phone: string, where: { latitude: number; longitude: number }) => {
    const ch = await att.createChallenge(studentActor(id), studentMeta(), lecRec.id, phone);
    return att.markAttendance(studentActor(id), studentMeta(), lecRec.id, phone, { attendanceToken: ch.attendanceToken, ...where });
  };
  assert.equal((await rejection(attend("outsider", outsiderPhone, FAR))).code, "LOCATION_OUTSIDE_RADIUS");
  assert.equal((await rejection(attend("outsider", johnPhone, NEAR))).code, "DEVICE_BOUND_TO_OTHER_STUDENT");
  assert.equal((await attend("john", johnPhone, NEAR)).status, "PRESENT");
  assert.equal((await rejection(attend("john", johnPhone, NEAR))).code, "ALREADY_MARKED");

  // the lecturer closes it: students are locked out immediately
  await w.svc.closeAttendanceSession(lecA, created.id);
  lecRec.status = "CLOSED"; // (same record object in a real DB)
  assert.equal((await rejection(attend("outsider", outsiderPhone, NEAR))).code, "SESSION_CLOSED");
});

/* ============================ profile / IDOR / audit / notifications / dashboard ============================ */
test("R. A lecturer can't change department, role, staff id or email; only the phone (and photo) are editable", async () => {
  const w = makeLecturerWorld();
  const before = { ...w.store.lecturers.find((l) => l.id === "lecA")! };
  const res = await w.svc.updateProfile(lecA, { phone: "+2348099999999", ...({ departmentId: MLS, department: MLS, role: "HOD", staffId: "X-1", email: "evil@x.example", firstName: "Evil" } as object) }, meta);
  assert.equal(res.phone, "+2348099999999");
  const after = w.store.lecturers.find((l) => l.id === "lecA")!;
  assert.deepEqual([after.departmentId, after.role, after.staffId, after.email, after.firstName], [before.departmentId, before.role, before.staffId, before.email, before.firstName]);
  const photo = await w.svc.setProfilePhoto(lecA, Buffer.from([0xff, 0xd8, 0xff]), meta);
  assert.equal(photo.profilePhoto, "https://cdn.example/avatar-lecA.jpg");
  await w.svc.setProfilePhoto(lecA, Buffer.from([0xff, 0xd8, 0xff]));
  assert.deepEqual(w.deleted, ["avatar-lecA-1"]); // the OLD image was removed, the new one kept
  const profile = await w.svc.getProfile(lecA);
  assert.deepEqual([profile.staffId, profile.role, profile.department?.code], ["CSC-001", "LECTURER", "CSC"]);
  assert.ok(!("passwordHash" in profile));
});
test("S. A lecturer can't assign herself (or anyone) to a course: the engine has no such operation, and assignments are the only authority", async () => {
  const w = makeLecturerWorld();
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(w.svc));
  assert.ok(!methods.some((m) => /assignLecturer|assignSelf|assignTo|createAssignment|revoke|setAssignment/i.test(m)), methods.join(","));
  // smuggling a course id of someone else's class into a create call is just an unassigned course
  assert.equal((await rejection(w.svc.createMaterial(lecA, w.csc202.id, { title: "x", fileUrl: "https://x.example" }))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal(w.store.assignments.filter((a) => a.lecturerId === "lecA").length, 2);
});
test("T. IDOR: swapping ids for every resource type never crosses a boundary", async () => {
  const w = makeLecturerWorld();
  const bAnn = await w.svc.createAnnouncement(lecB, { courseId: w.csc202.id, title: "B", content: "body text" });
  const bMat = await w.svc.createMaterial(lecB, w.csc202.id, { title: "B", fileUrl: "https://x.example/b" });
  const bWork = await w.svc.createCourseWork(lecB, w.csc202.id, work());
  const bSes = await w.svc.createAttendanceSession(lecB, w.csc202.id, session());
  const mWork = await w.svc.createCourseWork(lecM, w.mls201.id, work());
  const attempts = [
    w.svc.updateAnnouncement(lecA, bAnn.id, { title: "x" }), w.svc.deleteAnnouncement(lecA, bAnn.id),
    w.svc.updateMaterial(lecA, bMat.id, { title: "x" }), w.svc.deleteMaterial(lecA, bMat.id),
    w.svc.updateCourseWork(lecA, bWork.id, { title: "x" }), w.svc.deleteCourseWork(lecA, bWork.id), w.svc.listSubmissions(lecA, bWork.id), w.svc.listSubmissions(lecA, mWork.id),
    w.svc.getAttendanceSession(lecA, bSes.id), w.svc.closeAttendanceSession(lecA, bSes.id), w.svc.openAttendanceSession(lecA, bSes.id, {}),
    w.svc.markNotificationRead(lecA, "someone-elses"),
  ];
  for (const p of attempts) assert.equal((await rejection(p)).status, 404);
  assert.equal(w.store.sessions.find((s) => s.id === bSes.id)!.status, "ACTIVE");
  assert.equal(w.store.announcements.find((a) => a.id === bAnn.id)!.title, "B");
  // denied attempts are audited
  assert.ok(w.store.audit.filter((a) => a.action === "ACCESS_DENIED").length >= 10);
});
test("U. Every important lecturer action is audited with actor, role, department, resource, course and IP", async () => {
  const w = makeLecturerWorld();
  const a = await w.svc.createAnnouncement(lecA, { courseId: w.csc201.id, title: "T", content: "body text" }, meta);
  await w.svc.updateAnnouncement(lecA, a.id, { title: "T2" }, meta);
  await w.svc.deleteAnnouncement(lecA, a.id, meta);
  const m = await w.svc.createMaterial(lecA, w.csc201.id, { title: "M", fileUrl: "https://x.example/m" }, meta);
  await w.svc.deleteMaterial(lecA, m.id, meta);
  const cw = await w.svc.createCourseWork(lecA, w.csc201.id, work(), meta);
  await w.svc.updateCourseWork(lecA, cw.id, { published: true }, meta);
  await w.svc.updateCourseWork(lecA, cw.id, { published: false }, meta);
  await w.svc.deleteCourseWork(lecA, cw.id, meta);
  const s = await w.svc.createAttendanceSession(lecA, w.csc201.id, session(), meta);
  await w.svc.closeAttendanceSession(lecA, s.id, meta);
  const actions = new Set(w.store.audit.map((x) => x.action));
  for (const x of ["ANNOUNCEMENT_CREATED", "ANNOUNCEMENT_UPDATED", "ANNOUNCEMENT_DELETED", "MATERIAL_UPLOADED", "MATERIAL_DELETED", "ASSIGNMENT_CREATED", "ASSIGNMENT_PUBLISHED", "ASSIGNMENT_UNPUBLISHED", "ASSIGNMENT_UPDATED".replace("UPDATED", "DELETED"), "ATTENDANCE_SESSION_CREATED", "ATTENDANCE_SESSION_CLOSED"]) assert.ok(actions.has(x), `missing ${x}`);
  const e = w.store.audit.find((x) => x.action === "ANNOUNCEMENT_CREATED")!;
  assert.deepEqual([e.actorId, e.role, e.departmentId, e.courseCode, e.resourceType, e.ip], ["lecA", "LECTURER", CSC, "CSC201", "ANNOUNCEMENT", "41.58.0.9"]);
  assert.ok(e.at instanceof Date && e.resourceId);
});
test("V. Notifications: a lecturer sees and marks only her own", async () => {
  const w = makeLecturerWorld();
  const row = (id: string, who: string, read = false) => w.store.notifications.push({ id, recipientId: who, kind: "ASSIGNMENT", title: id, body: "b", read, createdAt: new Date() });
  row("n1", "lecA"); row("n2", "lecA", true); row("n3", "lecB");
  const list = await w.svc.listNotifications(lecA, { page: 1, limit: 10 });
  assert.deepEqual(list.items.map((n) => n.id).sort(), ["n1", "n2"]);
  assert.equal(list.unreadCount, 1);
  assert.equal((await rejection(w.svc.markNotificationRead(lecA, "n3"))).status, 404);
  assert.equal((await w.svc.markNotificationRead(lecA, "n1")).read, true);
  assert.equal((await w.svc.markAllNotificationsRead(lecB)).updated, 1);
});
test("W. Dashboard: profile, department, term, courses, upcoming assignments, announcements, sessions, notifications, statistics", async () => {
  const w = makeLecturerWorld();
  await w.svc.createCourseWork(lecA, w.csc201.id, work({ published: true }));
  await w.svc.createAnnouncement(lecA, { courseId: w.csc201.id, title: "Hello", content: "body text" });
  await w.svc.createAttendanceSession(lecA, w.csc201.id, session());
  w.store.notifications.push({ id: "n1", recipientId: "lecA", kind: "ASSIGNMENT", title: "x", body: "b", read: false, createdAt: new Date() });
  const d = await w.svc.dashboard(lecA);
  assert.equal(d.lecturer.department?.code, "CSC");
  assert.deepEqual(d.term, { academicSession: S, semester: "FIRST" });
  assert.deepEqual(d.courses.map((c) => c.courseCode).sort(), ["CSC201", "CSC203"]);
  assert.equal(d.upcomingAssignments.length, 1);
  assert.ok(d.recentAnnouncements.some((a) => a.title === "Hello"));
  assert.equal(d.attendanceSessions.open.length, 1);
  assert.equal(d.notifications.unreadCount, 1);
  const s201 = d.statistics.find((s) => s.courseCode === "CSC201")!;
  assert.deepEqual([s201.enrolled, s201.publishedAssignments, s201.sessionsHeld], [3, 1, 1]);
  const empty = await w.svc.dashboard(none);
  assert.deepEqual([empty.courses.length, empty.statistics.length], [0, 0]);
});
