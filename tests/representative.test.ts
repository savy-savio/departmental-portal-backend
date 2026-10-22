import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLE_PERMISSIONS } from "../src/services/representative/policy";
import { CSC, MLS, actor, makeRepWorld, rejection } from "./helpers/rep-world";

const john = actor("john");   // CSC201 Course Rep
const ada = actor("ada");     // CSC201 Assistant Course Rep
const peter = actor("peter"); // CSC202 Course Rep
const sam = actor("sam");     // plain student
const mia = actor("mia", MLS); // MLS201 Course Rep
const zed = actor("zed", MLS); // MLS201 Assistant

/* ============================ COURSE REP ============================ */
test("1. Valid Course Rep can access the assigned class", async () => {
  const w = makeRepWorld();
  const profile = await w.svc.getProfile(john);
  assert.equal(profile.assignments.length, 1);
  assert.equal(profile.assignments[0].role, "COURSE_REP");
  assert.equal(profile.assignments[0].course.courseCode, "CSC201");
  assert.deepEqual((await w.svc.listCourses(john)).map((c) => c.courseCode), ["CSC201"]);
  const o = await w.svc.overview(john);
  assert.equal(o.classes[0].memberCount, 3);
  assert.equal(o.unreadNotifications, 3);
});

test("2. Course Rep creates an announcement: audience is the assigned class, class is notified (not the author)", async () => {
  const w = makeRepWorld();
  const a = await w.svc.createAnnouncement(john, { courseId: w.csc201.id, title: "Test on Friday", body: "Bring calculators", priority: "URGENT" });
  assert.equal(a.status, "PUBLISHED");
  const stored = w.store.announcements[0];
  assert.equal(stored.courseCode, "CSC201");
  assert.equal(stored.departmentId, CSC);
  assert.equal(stored.level, "200");
  assert.equal(stored.createdByStudentId, "john");
  assert.equal(stored.createdByRole, "COURSE_REP");
  assert.deepEqual(w.notified, [{ courseCode: "CSC201", kind: "ANNOUNCEMENT", exclude: "john" }]);
  // course omitted works when the rep holds exactly one assignment
  const b = await w.svc.createAnnouncement(john, { title: "Reminder", body: "Bring ID" });
  assert.equal(b.courseCode, "CSC201");
  // drafts don't notify
  w.notified.length = 0;
  await w.svc.createAnnouncement(john, { title: "Draft", body: "wip", status: "DRAFT" });
  assert.equal(w.notified.length, 0);
});

test("3. Course Rep updates their own announcement (and publishing a draft notifies)", async () => {
  const w = makeRepWorld();
  const a = await w.svc.createAnnouncement(john, { title: "Draft", body: "wip", status: "DRAFT" });
  const u = await w.svc.updateAnnouncement(john, a.id, { title: "Final", status: "PUBLISHED" });
  assert.equal(u.title, "Final");
  assert.equal(u.status, "PUBLISHED");
  assert.equal(w.notified.length, 1);
});

test("4. Course Rep unpublishes and deletes (soft) their own announcement", async () => {
  const w = makeRepWorld();
  const a = await w.svc.createAnnouncement(john, { title: "A", body: "body text" });
  assert.equal((await w.svc.updateAnnouncement(john, a.id, { status: "UNPUBLISHED" })).status, "UNPUBLISHED");
  await w.svc.deleteAnnouncement(john, a.id);
  assert.equal(w.store.announcements[0].status, "DELETED"); // kept for audit
  assert.equal((await w.svc.listAnnouncements(john, {})).length, 0);
  assert.equal((await rejection(w.svc.updateAnnouncement(john, a.id, { title: "again" }))).status, 404);
});

test("5. Course Rep uploads a class resource (file or link); it is a CLASS_RESOURCE, never official", async () => {
  const w = makeRepWorld();
  const r = await w.svc.createResource(john, { courseId: w.csc201.id, title: "Past questions 2025", resourceType: "PAST_QUESTION", file: { buffer: Buffer.from("%PDF-1"), originalName: "pq.pdf" } });
  assert.equal(r.type, "CLASS_RESOURCE");
  assert.equal(r.resourceType, "PAST_QUESTION");
  assert.equal(r.uploadedBy.role, "COURSE_REP");
  const link = await w.svc.createResource(john, { title: "Notes link", resourceType: "CLASS_NOTES", fileUrl: "https://drive.example.com/notes" });
  assert.equal(link.file.url, "https://drive.example.com/notes");
  assert.deepEqual(w.notified.map((n) => n.kind), ["MATERIAL", "MATERIAL"]);
  assert.equal((await rejection(w.svc.createResource(john, { title: "both", resourceType: "OTHER", fileUrl: "https://x.example", file: { buffer: Buffer.from("x"), originalName: "a.pdf" } }))).code, "INVALID_RESOURCE_SOURCE");
  assert.equal((await rejection(w.svc.createResource(john, { title: "none", resourceType: "OTHER" }))).code, "INVALID_RESOURCE_SOURCE");
});

test("6. Course Rep updates their own resource", async () => {
  const w = makeRepWorld();
  const r = await w.svc.createResource(john, { title: "Notes", resourceType: "CLASS_NOTES", fileUrl: "https://x.example/n" });
  const u = await w.svc.updateResource(john, r.id, { title: "Notes v2", status: "HIDDEN" });
  assert.equal(u.title, "Notes v2");
  assert.equal(u.status, "HIDDEN");
});

test("7. Course Rep deletes their own resource (the stored file is removed too)", async () => {
  const w = makeRepWorld();
  const r = await w.svc.createResource(john, { title: "Handout", resourceType: "HANDOUT", file: { buffer: Buffer.from("x"), originalName: "h.pdf" } });
  await w.svc.deleteResource(john, r.id);
  assert.ok(!w.store.resources.some((x) => x.id === r.id));
  assert.deepEqual(w.deletedFiles, ["up-h.pdf"]);
});

test("8. Course Rep views class members: names/matric/photo only, carryovers included, searchable, paginated", async () => {
  const w = makeRepWorld();
  w.store.enrollments.push({ studentId: "peter", departmentId: CSC, courseCode: "CSC201", academicSession: "2026/2027", semester: "FIRST", type: "CARRYOVER" });
  const res = await w.svc.listMembers(john, w.csc201.id, { page: 1, limit: 2 });
  assert.equal(res.total, 4);
  assert.equal(res.items.length, 2);
  assert.equal(res.totalPages, 2);
  const all = await w.svc.listMembers(john, w.csc201.id, { page: 1, limit: 50 });
  assert.ok(all.items.some((m) => m.studentId === "peter" && m.enrollmentType === "CARRYOVER"));
  for (const m of all.items) {
    assert.deepEqual(Object.keys(m).sort(), ["enrollmentType", "firstName", "lastName", "level", "matricNumber", "profilePhoto", "studentId"]);
    assert.ok(!("email" in m) && !("phone" in m));
  }
  assert.equal((await w.svc.listMembers(john, w.csc201.id, { page: 1, limit: 50, search: "obi" })).total, 1);
});

test("9. Course Rep views course information (count + lecturer where known)", async () => {
  const w = makeRepWorld();
  const c = await w.svc.getCourse(john, w.csc201.id);
  assert.equal(c.courseCode, "CSC201");
  assert.equal(c.units, 3);
  assert.equal(c.enrolledCount, 3);
  assert.deepEqual(c.lecturers, ["Dr. Bello"]);
});

test("10. Course Rep views the timetable (ordered, course or class view; official entries flagged read-only)", async () => {
  const w = makeRepWorld();
  const t = await w.svc.getTimetable(john, { view: "course" });
  assert.equal(t.officialTimetableReadOnly, true);
  assert.ok(t.entries.every((e) => e.source === "OFFICIAL" && e.canEdit === false && e.canDelete === false));
  assert.deepEqual(t.entries.map((e) => e.dayOfWeek), ["MON", "WED"]);
  assert.ok(t.entries.every((e) => e.courseCode === "CSC201"));
  // class view = every slot for the level (CSC202 too), still only the rep's department
  const cls = await w.svc.getTimetable(john, { view: "class" });
  assert.deepEqual([...new Set(cls.entries.map((e) => e.courseCode))].sort(), ["CSC201", "CSC202"]);
});

/* ============================ ASSISTANT COURSE REP ============================ */
test("11. Valid Assistant Course Rep can access the assigned class", async () => {
  const w = makeRepWorld();
  assert.equal((await w.svc.getProfile(ada)).assignments[0].role, "ASSISTANT_COURSE_REP");
  assert.equal((await w.svc.getCourse(ada, w.csc201.id)).courseCode, "CSC201");
  assert.equal((await w.svc.listMembers(ada, w.csc201.id, { page: 1, limit: 10 })).total, 3);
  assert.equal((await w.svc.getTimetable(ada, { view: "course" })).entries.length, 2);
});

test("12. Assistant performs the announcement actions it is allowed: create, edit own, unpublish own", async () => {
  const w = makeRepWorld();
  const a = await w.svc.createAnnouncement(ada, { courseId: w.csc201.id, title: "Venue change", body: "Now in LT2", priority: "IMPORTANT" });
  assert.equal(a.canEdit, true);
  assert.equal(a.canUnpublish, true);
  assert.equal(a.canDelete, false);
  assert.equal((await w.svc.updateAnnouncement(ada, a.id, { body: "Now in LT3" })).message, "Now in LT3");
  assert.equal((await w.svc.updateAnnouncement(ada, a.id, { status: "UNPUBLISHED" })).status, "UNPUBLISHED");
  assert.equal(w.store.announcements[0].createdByRole, "ASSISTANT_COURSE_REP");
});

test("13. Assistant uploads, updates and deletes their own resources", async () => {
  const w = makeRepWorld();
  const r = await w.svc.createResource(ada, { title: "Slides", resourceType: "STUDY_MATERIAL", fileUrl: "https://x.example/s" });
  assert.equal(r.uploadedBy.role, "ASSISTANT_COURSE_REP");
  await w.svc.updateResource(ada, r.id, { description: "week 3" });
  await w.svc.deleteResource(ada, r.id);
  assert.equal(w.store.resources.filter((x) => x.createdByStudentId === "ada").length, 0);
});

test("14. Assistant cannot do restricted Course Rep things", async () => {
  const w = makeRepWorld();
  const own = await w.svc.createAnnouncement(ada, { title: "Mine", body: "body text" });
  // hard delete is a Course Rep power
  assert.equal((await rejection(w.svc.deleteAnnouncement(ada, own.id))).code, "PERMISSION_DENIED");
  // priority ceiling is lower
  assert.equal((await rejection(w.svc.createAnnouncement(ada, { title: "Shout", body: "body text", priority: "URGENT" }))).code, "PRIORITY_NOT_ALLOWED");
  assert.equal((await rejection(w.svc.updateAnnouncement(ada, own.id, { priority: "URGENT" }))).code, "PRIORITY_NOT_ALLOWED");
  // the Course Rep's items are not hers to change
  const reps = await w.svc.createAnnouncement(john, { title: "Rep's", body: "body text" });
  assert.equal((await rejection(w.svc.updateAnnouncement(ada, reps.id, { title: "hijack" }))).code, "NOT_OWNER");
  assert.equal((await rejection(w.svc.updateAnnouncement(ada, reps.id, { status: "UNPUBLISHED" }))).code, "NOT_OWNER");
  const res = await w.svc.createResource(john, { title: "Rep resource", resourceType: "OTHER", fileUrl: "https://x.example/r" });
  assert.equal((await rejection(w.svc.deleteResource(ada, res.id))).code, "NOT_OWNER");
  // ...and the Course Rep still can
  assert.equal((await w.svc.createAnnouncement(john, { title: "Urgent", body: "body text", priority: "URGENT" })).priority, "URGENT");
});

/* ============================ SECURITY ============================ */
test("15. A normal student cannot use any representative function", async () => {
  const w = makeRepWorld();
  const calls: Promise<unknown>[] = [
    w.svc.getProfile(sam), w.svc.listCourses(sam), w.svc.overview(sam), w.svc.getCourse(sam, w.csc201.id),
    w.svc.listMembers(sam, w.csc201.id, { page: 1, limit: 10 }), w.svc.listAnnouncements(sam, {}), w.svc.listResources(sam, {}),
    w.svc.getTimetable(sam, { view: "course" }), w.svc.createAnnouncement(sam, { courseId: w.csc201.id, title: "x", body: "yyyyyyyyyy" }),
    w.svc.createResource(sam, { courseId: w.csc201.id, title: "x", resourceType: "OTHER", fileUrl: "https://x.example" }),
  ];
  for (const c of calls) assert.equal((await rejection(c)).code, "NOT_A_REPRESENTATIVE");
  // sam is enrolled in CSC201 as a student: that gives no representative power
  assert.equal(w.store.announcements.length, 0);
});

test("16. Course Rep A cannot reach Course Rep B's class (course, members, lists, create, edit, timetable)", async () => {
  const w = makeRepWorld();
  const b = await w.svc.createAnnouncement(peter, { title: "CSC202 note", body: "body text" });
  const bRes = await w.svc.createResource(peter, { title: "CSC202 notes", resourceType: "CLASS_NOTES", fileUrl: "https://x.example/b" });
  assert.equal((await rejection(w.svc.getCourse(john, w.csc202.id))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.listMembers(john, w.csc202.id, { page: 1, limit: 10 }))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.listAnnouncements(john, { courseId: w.csc202.id }))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.listResources(john, { courseId: w.csc202.id }))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.getTimetable(john, { courseId: w.csc202.id, view: "course" }))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.createAnnouncement(john, { courseId: w.csc202.id, title: "x", body: "yyyyyyyyyy" }))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.createResource(john, { courseId: w.csc202.id, title: "x", resourceType: "OTHER", fileUrl: "https://x.example" }))).code, "NOT_ASSIGNED_TO_COURSE");
  // B's items by id: not found for A, and untouched
  assert.equal((await rejection(w.svc.updateAnnouncement(john, b.id, { title: "hijack" }))).status, 404);
  assert.equal((await rejection(w.svc.deleteAnnouncement(john, b.id))).status, 404);
  assert.equal((await rejection(w.svc.updateResource(john, bRes.id, { title: "hijack" }))).status, 404);
  assert.equal((await rejection(w.svc.deleteResource(john, bRes.id))).status, 404);
  assert.equal(w.store.announcements[0].title, "CSC202 note");
  assert.equal(w.store.resources.find((r) => r.id === bRes.id)?.title, "CSC202 notes");
  // A's listings never include B's items
  assert.ok((await w.svc.listAnnouncements(john, {})).every((x) => x.courseCode === "CSC201"));
});

test("17. A Course Rep cannot reach another department (and vice versa)", async () => {
  const w = makeRepWorld();
  assert.equal((await rejection(w.svc.getCourse(john, w.mls201.id))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.createAnnouncement(john, { courseId: w.mls201.id, title: "x", body: "yyyyyyyyyy" }))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.getCourse(mia, w.csc201.id))).code, "NOT_ASSIGNED_TO_COURSE");
  // Even forging the department on the actor can't help: assignments are checked against the student's own record
  const forged = { ...john, departmentId: MLS };
  assert.equal((await rejection(w.svc.getCourse(forged, w.mls201.id))).code, "NOT_A_REPRESENTATIVE");
  // a CSC announcement id looked up by an MLS rep is simply not found
  const a = await w.svc.createAnnouncement(john, { title: "CSC only", body: "body text" });
  assert.equal((await rejection(w.svc.updateAnnouncement(mia, a.id, { title: "x" }))).status, 404);
});

test("18. Assistant Course Rep cannot access another course or department", async () => {
  const w = makeRepWorld();
  assert.equal((await rejection(w.svc.getCourse(ada, w.csc202.id))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.listMembers(ada, w.mls201.id, { page: 1, limit: 10 }))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.createAnnouncement(ada, { courseId: w.csc202.id, title: "x", body: "yyyyyyyyyy" }))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.getCourse(zed, w.csc201.id))).code, "NOT_ASSIGNED_TO_COURSE");
});

test("19. Representatives cannot modify official lecturer materials", async () => {
  const w = makeRepWorld();
  for (const who of [john, ada]) {
    assert.equal((await rejection(w.svc.updateResource(who, "official-1", { title: "hacked" }))).code, "OFFICIAL_MATERIAL_PROTECTED");
    assert.equal((await rejection(w.svc.deleteResource(who, "official-1"))).code, "OFFICIAL_MATERIAL_PROTECTED");
  }
  const official = w.store.resources.find((r) => r.id === "official-1")!;
  assert.equal(official.title, "Official lecture 1");
  const listed = (await w.svc.listResources(john, {})).find((r) => r.id === "official-1")!;
  assert.equal(listed.canEdit, false);
  assert.equal(listed.canDelete, false);
  // another class's rep can't even see it exists
  assert.equal((await rejection(w.svc.updateResource(peter, "official-1", { title: "x" }))).status, 404);
  // nobody can create an OFFICIAL material through the rep API: everything created is a CLASS_RESOURCE
  await w.svc.createResource(john, { title: "x", resourceType: "OTHER", fileUrl: "https://x.example/x", ...({ type: "OFFICIAL_COURSE_MATERIAL" } as object) });
  assert.ok(w.store.resources.filter((r) => r.createdByStudentId === "john").every((r) => r.type === "CLASS_RESOURCE"));
});

test("25. Changing ids / identity fields in requests cannot bypass authorization", async () => {
  const w = makeRepWorld();
  // identity is the actor only: studentId / role / departmentId smuggled into inputs are ignored
  const sneaky = { courseId: w.csc201.id, title: "Hi", body: "body text", studentId: "peter", createdByStudentId: "peter", role: "COURSE_REP", departmentId: MLS, courseCode: "MLS201" };
  await w.svc.createAnnouncement(ada, sneaky as never);
  const rec = w.store.announcements[0];
  assert.equal(rec.createdByStudentId, "ada");
  assert.equal(rec.createdByRole, "ASSISTANT_COURSE_REP");
  assert.equal(rec.departmentId, CSC);
  assert.equal(rec.courseCode, "CSC201");
  // a patch that tries to move the announcement to another course / dept / author changes nothing
  await w.svc.updateAnnouncement(ada, w.store.announcements[0].id, { title: "ok", ...({ courseId: w.csc202.id, departmentId: MLS, createdByStudentId: "peter" } as object) });
  assert.equal(w.store.announcements[0].courseId, w.csc201.id);
  assert.equal(w.store.announcements[0].createdByStudentId, "ada");
  // guessing ids
  assert.equal((await rejection(w.svc.getCourse(john, "c-does-not-exist"))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.updateAnnouncement(john, "nope", { title: "x" }))).status, 404);
  // a plain student who adds {role:"COURSE_REP"} to anything is still just a student
  assert.equal((await rejection(w.svc.createAnnouncement({ ...sam, ...({ role: "COURSE_REP" } as object) }, { courseId: w.csc201.id, title: "x", body: "yyyyyyyyyy" }))).code, "NOT_A_REPRESENTATIVE");
});

test("26. Revoked / inactive / expired assignments remove representative permissions immediately", async () => {
  const w = makeRepWorld();
  const a = await w.svc.createAnnouncement(john, { title: "Before", body: "body text" });
  const r = await w.svc.createResource(john, { title: "Before", resourceType: "OTHER", fileUrl: "https://x.example/x" });
  assert.equal((await w.svc.getProfile(john)).isRepresentative, true);

  w.johnAsg.status = "REVOKED"; // HOD revokes: the very next request is already refused
  assert.equal((await rejection(w.svc.getProfile(john))).code, "NOT_A_REPRESENTATIVE");
  assert.equal((await rejection(w.svc.getCourse(john, w.csc201.id))).code, "NOT_A_REPRESENTATIVE");
  assert.equal((await rejection(w.svc.createAnnouncement(john, { title: "After", body: "body text" }))).code, "NOT_A_REPRESENTATIVE");
  assert.equal((await rejection(w.svc.updateAnnouncement(john, a.id, { title: "After" }))).code, "NOT_A_REPRESENTATIVE");
  assert.equal((await rejection(w.svc.deleteResource(john, r.id))).code, "NOT_A_REPRESENTATIVE");
  assert.equal(w.store.announcements[0].title, "Before");

  w.johnAsg.status = "INACTIVE"; // suspended: same
  assert.equal((await rejection(w.svc.getProfile(john))).code, "NOT_A_REPRESENTATIVE");

  w.johnAsg.status = "ACTIVE"; // reinstated
  assert.equal((await w.svc.getProfile(john)).isRepresentative, true);

  // the assistant is untouched by the Course Rep's revocation
  w.johnAsg.status = "REVOKED";
  assert.equal((await w.svc.getProfile(ada)).isRepresentative, true);
  // ...and the audit trail still shows the history, with the history listing flagging it as not current
  const hist = await w.svc.listAssignments(john);
  assert.equal(hist[0].current, false);
  assert.deepEqual(hist[0].permissions, []);

  // a new term makes last term's assignment inert until it is renewed
  w.johnAsg.status = "ACTIVE";
  w.store.terms.set(CSC, { academicSession: "2026/2027", semester: "SECOND" });
  assert.equal((await rejection(w.svc.getProfile(john))).code, "NOT_A_REPRESENTATIVE");
});

test("28. Two representatives from different departments stay completely isolated", async () => {
  const w = makeRepWorld();
  await w.svc.createAnnouncement(john, { title: "CSC thing", body: "body text" });
  await w.svc.createAnnouncement(mia, { title: "MLS thing", body: "body text" });
  await w.svc.createResource(john, { title: "CSC res", resourceType: "OTHER", fileUrl: "https://x.example/c" });
  await w.svc.createResource(mia, { title: "MLS res", resourceType: "OTHER", fileUrl: "https://x.example/m" });

  assert.deepEqual((await w.svc.listAnnouncements(john, {})).map((x) => x.title), ["CSC thing"]);
  assert.deepEqual((await w.svc.listAnnouncements(mia, {})).map((x) => x.title), ["MLS thing"]);
  assert.ok((await w.svc.listResources(john, {})).every((x) => x.courseCode === "CSC201"));
  assert.ok((await w.svc.listResources(mia, {})).every((x) => x.courseCode === "MLS201"));
  assert.deepEqual((await w.svc.listMembers(mia, w.mls201.id, { page: 1, limit: 50 })).items.map((m) => m.studentId).sort(), ["mia", "zed"]);
  assert.equal((await w.svc.getTimetable(mia, { view: "class" })).entries.every((e) => e.courseCode === "MLS201"), true);
  // every notification fan-out stayed inside its own course
  assert.deepEqual(w.notified.map((n) => n.courseCode).sort(), ["CSC201", "CSC201", "MLS201", "MLS201"]);
  // audit rows carry the right department
  assert.ok(w.store.audit.filter((x) => x.actorId === "mia").every((x) => x.departmentId === MLS));
  assert.ok(w.store.audit.filter((x) => x.actorId === "john").every((x) => x.departmentId === CSC));
});

/* ============================ AUDIT ============================ */
test("every representative action and every denied attempt is audited", async () => {
  const w = makeRepWorld();
  const a = await w.svc.createAnnouncement(john, { title: "T", body: "body text" });
  await w.svc.updateAnnouncement(john, a.id, { title: "T2" });
  await w.svc.updateAnnouncement(john, a.id, { status: "UNPUBLISHED" });
  await w.svc.deleteAnnouncement(john, a.id);
  const r = await w.svc.createResource(john, { title: "R", resourceType: "OTHER", fileUrl: "https://x.example/r" });
  await w.svc.updateResource(john, r.id, { title: "R2" });
  await w.svc.deleteResource(john, r.id);
  await rejection(w.svc.getCourse(john, w.csc202.id));
  await rejection(w.svc.deleteAnnouncement(ada, (await w.svc.createAnnouncement(ada, { title: "x", body: "yyyyyyyyyy" })).id));

  const actions = w.store.audit.map((x) => x.action);
  for (const expected of ["ANNOUNCEMENT_CREATED", "ANNOUNCEMENT_UPDATED", "ANNOUNCEMENT_UNPUBLISHED", "ANNOUNCEMENT_DELETED", "RESOURCE_UPLOADED", "RESOURCE_UPDATED", "RESOURCE_DELETED", "ACCESS_DENIED"]) {
    assert.ok(actions.includes(expected), `missing ${expected}`);
  }
  const created = w.store.audit.find((x) => x.action === "ANNOUNCEMENT_CREATED")!;
  assert.equal(created.actorId, "john");
  assert.equal(created.role, "COURSE_REP");
  assert.equal(created.courseCode, "CSC201");
  assert.equal(created.departmentId, CSC);
  assert.equal(created.resourceType, "ANNOUNCEMENT");
  assert.ok(created.at instanceof Date);
  const denied = w.store.audit.filter((x) => x.action === "ACCESS_DENIED");
  assert.ok(denied.some((x) => (x.detail as { reason: string }).reason === "NOT_ASSIGNED_TO_COURSE"));
  assert.ok(denied.some((x) => (x.detail as { reason: string }).reason === "PERMISSION_DENIED"));
});

/* ============================ CLASS TIMETABLE (Course Rep manages, Assistant views) ============================ */
const slot = (over: object = {}) => ({ courseId: "c-csc201", dayOfWeek: "FRI" as const, startTime: "14:00", endTime: "16:00", venue: "LT3", ...over });

test("T1. Course Rep creates a class timetable entry (everything but the slot is derived from the assigned course)", async () => {
  const w = makeRepWorld();
  const e = await w.svc.createTimetableEntry(john, slot({ lecturerName: "Dr. Bello", type: "PRACTICAL" }));
  assert.equal(e.source, "CLASS_REP");
  assert.equal(e.status, "PUBLISHED");
  assert.equal(e.canEdit, true);
  const rec = w.store.timetable.find((t) => t.id === e.id)!;
  assert.equal(rec.departmentId, CSC);
  assert.equal(rec.courseCode, "CSC201");
  assert.equal(rec.level, "200");
  assert.equal(rec.academicSession, "2026/2027");
  assert.equal(rec.semester, "FIRST");
  assert.equal(rec.createdByStudentId, "john");
  assert.equal(rec.createdByRole, "COURSE_REP");
  assert.deepEqual(w.notified.map((n) => n.kind), ["TIMETABLE"]);
  // the course can be omitted when the rep holds only one assignment; a date-only one-off works and derives its weekday
  const oneOff = await w.svc.createTimetableEntry(john, { date: "2026-10-21", startTime: "09:00", endTime: "10:00", title: "Make-up class" });
  assert.equal(oneOff.dayOfWeek, "WED");
  assert.equal(oneOff.date, "2026-10-21");
  // bad slots and clashes are refused
  assert.equal((await rejection(w.svc.createTimetableEntry(john, slot({ startTime: "16:00", endTime: "15:00" })))).code, "INVALID_TIMETABLE");
  assert.equal((await rejection(w.svc.createTimetableEntry(john, slot({ dayOfWeek: "MON", date: "2026-10-21" })))).code, "INVALID_TIMETABLE");
  assert.equal((await rejection(w.svc.createTimetableEntry(john, slot({ startTime: "15:00", endTime: "17:00" })))).code, "TIMETABLE_CLASH");
  assert.equal((await rejection(w.svc.createTimetableEntry(john, slot({ dayOfWeek: "MON", startTime: "09:00", endTime: "11:00" })))).code, "TIMETABLE_CLASH"); // official MON 10:00 slot
});

test("T2. Course Rep edits their class timetable (partial updates are validated as a whole)", async () => {
  const w = makeRepWorld();
  const e = await w.svc.createTimetableEntry(john, slot());
  const u = await w.svc.updateTimetableEntry(john, e.id, { venue: "LT9", startTime: "13:00" });
  assert.equal(u.venue, "LT9");
  assert.equal(u.startTime, "13:00");
  assert.equal(u.endTime, "16:00");
  // an update that would make the slot invalid or clashing is refused and changes nothing
  assert.equal((await rejection(w.svc.updateTimetableEntry(john, e.id, { endTime: "12:00" }))).code, "INVALID_TIMETABLE");
  assert.equal((await rejection(w.svc.updateTimetableEntry(john, e.id, { dayOfWeek: "MON", startTime: "10:30", endTime: "11:30" }))).code, "TIMETABLE_CLASH");
  assert.equal(w.store.timetable.find((t) => t.id === e.id)!.endTime, "16:00");
  // publish / unpublish: a draft is hidden from the Assistant (and from students) until published
  const draft = await w.svc.updateTimetableEntry(john, e.id, { status: "DRAFT" });
  assert.equal(draft.status, "DRAFT");
  assert.ok((await w.svc.getTimetable(john, { view: "course" })).entries.some((x) => x.id === e.id));
  assert.ok(!(await w.svc.getTimetable(ada, { view: "course" })).entries.some((x) => x.id === e.id));
  w.notified.length = 0;
  await w.svc.updateTimetableEntry(john, e.id, { status: "PUBLISHED" });
  assert.equal(w.notified.length, 1);
  assert.ok((await w.svc.getTimetable(ada, { view: "course" })).entries.some((x) => x.id === e.id));
  // course / department / level / author can't be moved by a patch
  await w.svc.updateTimetableEntry(john, e.id, { venue: "LT1", ...({ courseId: w.csc202.id, courseCode: "CSC202", departmentId: MLS, level: "300", createdByStudentId: "peter" } as object) });
  const rec = w.store.timetable.find((t) => t.id === e.id)!;
  assert.deepEqual([rec.courseCode, rec.departmentId, rec.level, rec.createdByStudentId], ["CSC201", CSC, "200", "john"]);
});

test("T3. Course Rep deletes their class timetable entry", async () => {
  const w = makeRepWorld();
  const e = await w.svc.createTimetableEntry(john, slot());
  await w.svc.deleteTimetableEntry(john, e.id);
  assert.ok(!w.store.timetable.some((t) => t.id === e.id));
  assert.equal((await rejection(w.svc.deleteTimetableEntry(john, e.id))).status, 404);
});

test("T4. Course Rep cannot touch another class's timetable (create, edit, delete, list)", async () => {
  const w = makeRepWorld();
  const theirs = await w.svc.createTimetableEntry(peter, slot({ courseId: "c-csc202", dayOfWeek: "THU" }));
  assert.equal((await rejection(w.svc.createTimetableEntry(john, slot({ courseId: w.csc202.id })))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.updateTimetableEntry(john, theirs.id, { venue: "hijack" }))).status, 404);
  assert.equal((await rejection(w.svc.deleteTimetableEntry(john, theirs.id))).status, 404);
  assert.equal((await rejection(w.svc.getTimetable(john, { courseId: w.csc202.id, view: "course" }))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal(w.store.timetable.find((t) => t.id === theirs.id)!.venue, "LT3");
  // ids smuggled in the body don't redirect a create to another class either
  const sneaky = await w.svc.createTimetableEntry(john, { ...slot({ dayOfWeek: "SAT" }), ...({ courseCode: "CSC202", departmentId: MLS, studentId: "peter" } as object) });
  const rec = w.store.timetable.find((t) => t.id === sneaky.id)!;
  assert.deepEqual([rec.courseCode, rec.departmentId, rec.createdByStudentId], ["CSC201", CSC, "john"]);
  // official entries of MY OWN class are protected too
  assert.equal((await rejection(w.svc.updateTimetableEntry(john, "d-csc-CSC201-WED", { venue: "x" }))).code, "OFFICIAL_TIMETABLE_PROTECTED");
  assert.equal((await rejection(w.svc.deleteTimetableEntry(john, "d-csc-CSC201-WED"))).code, "OFFICIAL_TIMETABLE_PROTECTED");
  assert.ok(w.store.timetable.some((t) => t.id === "d-csc-CSC201-WED"));
});

test("T5. Course Rep cannot manage another department's timetable (and vice versa)", async () => {
  const w = makeRepWorld();
  const mls = await w.svc.createTimetableEntry(mia, { courseId: w.mls201.id, dayOfWeek: "FRI", startTime: "10:00", endTime: "12:00" });
  assert.equal((await rejection(w.svc.createTimetableEntry(john, slot({ courseId: w.mls201.id })))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.updateTimetableEntry(john, mls.id, { venue: "x" }))).status, 404);
  assert.equal((await rejection(w.svc.deleteTimetableEntry(john, mls.id))).status, 404);
  const cscEntry = await w.svc.createTimetableEntry(john, slot());
  assert.equal((await rejection(w.svc.updateTimetableEntry(mia, cscEntry.id, { venue: "x" }))).status, 404);
  assert.equal((await rejection(w.svc.createTimetableEntry(mia, slot()))).code, "NOT_ASSIGNED_TO_COURSE");
  // forging the department on the actor doesn't help
  assert.equal((await rejection(w.svc.createTimetableEntry({ ...john, departmentId: MLS }, slot({ courseId: w.mls201.id })))).code, "NOT_A_REPRESENTATIVE");
  assert.ok(w.store.timetable.filter((t) => t.departmentId === MLS && t.source === "CLASS_REP").every((t) => t.createdByStudentId === "mia"));
});

test("T6. Assistant Course Rep can view the assigned class timetable", async () => {
  const w = makeRepWorld();
  const t = await w.svc.getTimetable(ada, { view: "course" });
  assert.deepEqual(t.entries.map((e) => e.dayOfWeek), ["MON", "WED"]);
  assert.ok(t.entries.every((e) => e.canEdit === false && e.canDelete === false));
  assert.equal((await rejection(w.svc.getTimetable(ada, { courseId: w.csc202.id, view: "course" }))).code, "NOT_ASSIGNED_TO_COURSE");
});

test("T7. Assistant cannot create / edit / delete the timetable ... unless that permission is explicitly enabled later", async () => {
  const w = makeRepWorld();
  const e = await w.svc.createTimetableEntry(john, slot());
  assert.equal((await rejection(w.svc.createTimetableEntry(ada, slot({ dayOfWeek: "SAT" })))).code, "PERMISSION_DENIED");
  assert.equal((await rejection(w.svc.updateTimetableEntry(ada, e.id, { venue: "x" }))).code, "PERMISSION_DENIED");
  assert.equal((await rejection(w.svc.deleteTimetableEntry(ada, e.id))).code, "PERMISSION_DENIED");
  assert.equal(w.store.timetable.find((t) => t.id === e.id)!.venue, "LT3");

  // Later, an administrator enables it by editing the permission table: it works for her own class only.
  const w2 = makeRepWorld({ permissions: { ...ROLE_PERMISSIONS, ASSISTANT_COURSE_REP: [...ROLE_PERMISSIONS.ASSISTANT_COURSE_REP, "timetable:create", "timetable:update"] } });
  const mine = await w2.svc.createTimetableEntry(ada, slot({ dayOfWeek: "SAT" }));
  await w2.svc.updateTimetableEntry(ada, mine.id, { venue: "LT7" });
  assert.equal((await rejection(w2.svc.deleteTimetableEntry(ada, mine.id))).code, "PERMISSION_DENIED"); // delete was not enabled
  assert.equal((await rejection(w2.svc.createTimetableEntry(ada, slot({ courseId: w2.csc202.id })))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal(w2.store.timetable.find((t) => t.id === mine.id)!.createdByRole, "ASSISTANT_COURSE_REP");
});

test("T8. A normal student cannot modify the timetable through the representative API", async () => {
  const w = makeRepWorld();
  const e = await w.svc.createTimetableEntry(john, slot());
  assert.equal((await rejection(w.svc.createTimetableEntry(sam, slot()))).code, "NOT_A_REPRESENTATIVE");
  assert.equal((await rejection(w.svc.updateTimetableEntry(sam, e.id, { venue: "x" }))).code, "NOT_A_REPRESENTATIVE");
  assert.equal((await rejection(w.svc.deleteTimetableEntry(sam, e.id))).code, "NOT_A_REPRESENTATIVE");
  assert.equal((await rejection(w.svc.getTimetable(sam, { view: "course" }))).code, "NOT_A_REPRESENTATIVE");
});

test("T9. Revoking the assignment ends timetable control immediately; all timetable actions are audited", async () => {
  const w = makeRepWorld();
  const e = await w.svc.createTimetableEntry(john, slot());
  await w.svc.updateTimetableEntry(john, e.id, { venue: "LT2" });
  await w.svc.deleteTimetableEntry(john, e.id);
  const again = await w.svc.createTimetableEntry(john, slot());
  w.johnAsg.status = "REVOKED";
  assert.equal((await rejection(w.svc.updateTimetableEntry(john, again.id, { venue: "x" }))).code, "NOT_A_REPRESENTATIVE");
  assert.equal((await rejection(w.svc.deleteTimetableEntry(john, again.id))).code, "NOT_A_REPRESENTATIVE");
  assert.ok(w.store.timetable.some((t) => t.id === again.id)); // untouched
  const actions = w.store.audit.map((a) => a.action);
  for (const a of ["TIMETABLE_CREATED", "TIMETABLE_UPDATED", "TIMETABLE_DELETED"]) assert.ok(actions.includes(a), `missing ${a}`);
  assert.equal(w.store.audit.find((a) => a.action === "TIMETABLE_CREATED")!.courseCode, "CSC201");
});
