import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { actor, CSC, makeRepWorld, MLS, rejection } from "./helpers/rep-world";
import { makeHodWorld, hodC } from "./helpers/hod-world";
import { makeLecturerWorld, actor as lecturer } from "./helpers/lecturer-world";
import { JPEG } from "./helpers/election-world";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const slot = (courseId: string, over: object = {}) => ({ courseId, dayOfWeek: "FRI" as const, startTime: "08:00", endTime: "09:00", ...over });
/** The shared world pre-assigns some legacy course appointments; these tests start from a clean slate and add level appointments only. */
function fresh() { const w = makeRepWorld(); w.store.assignments.length = 0; w.store.timetable.length = 0; return w; }

/* ============================ 1. appointment for a level ============================ */
test("1. A level appointment covers every course of that level this term, and nothing else", async () => {
  const w = fresh();
  w.assignLevel("john", CSC, "200", "COURSE_REP");
  const john = actor("john");
  const courses = await w.svc.listCourses(john);
  assert.deepEqual(courses.map((c) => c.courseCode).sort(), ["CSC201", "CSC202"]); // both 200-level courses, not CSC301 (300L), not MLS201 (other department)
  for (const id of [w.csc201.id, w.csc202.id]) assert.equal((await w.svc.getCourse(john, id)).id, id);
  for (const id of [w.csc301.id, w.mls201.id, "does-not-exist"]) assert.equal((await rejection(w.svc.getCourse(john, id))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal(w.store.audit.filter((a) => a.action === "ACCESS_DENIED").length, 3);
});
test("2. A rep of another level, or of another department's same level, gets nothing from this one's courses", async () => {
  const w = fresh();
  w.assignLevel("peter", CSC, "300", "COURSE_REP");
  w.assignLevel("mia", MLS, "200", "COURSE_REP");
  assert.deepEqual((await w.svc.listCourses(actor("peter"))).map((c) => c.courseCode), ["CSC301"]);
  assert.equal((await rejection(w.svc.getCourse(actor("peter"), w.csc201.id))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.deepEqual((await w.svc.listCourses(actor("mia", MLS))).map((c) => c.courseCode), ["MLS201"]);
  assert.equal((await rejection(w.svc.getCourse(actor("mia", MLS), w.csc201.id))).code, "NOT_ASSIGNED_TO_COURSE"); // same level, other department
});
test("3. An appointment only works in its own term; inactive or revoked ones give no authority", async () => {
  const w = fresh();
  const a = w.assignLevel("john", CSC, "200", "COURSE_REP");
  a.status = "INACTIVE";
  assert.equal((await rejection(w.svc.listCourses(actor("john")))).code, "NOT_A_REPRESENTATIVE");
  a.status = "ACTIVE"; a.academicSession = "2025/2026"; // an appointment from a past term
  assert.equal((await rejection(w.svc.listCourses(actor("john")))).code, "NOT_A_REPRESENTATIVE");
  a.academicSession = "2026/2027"; a.status = "REVOKED";
  assert.equal((await rejection(w.svc.listCourses(actor("john")))).code, "NOT_A_REPRESENTATIVE");
});
test("4. The rep overview of a level appointment shows the level, its courses and the whole class", async () => {
  const w = fresh();
  w.assignLevel("john", CSC, "200", "COURSE_REP");
  const o = await w.svc.overview(actor("john"));
  assert.equal(o.classes.length, 1);
  assert.deepEqual([o.classes[0].scope, o.classes[0].level, o.classes[0].course, o.classes[0].courses.map((c) => c.courseCode).sort()], ["LEVEL", "200", null, ["CSC201", "CSC202"]]);
  assert.equal(o.classes[0].memberCount, 4); // john, ada, peter, sam are the 200-level CSC students
});

/* ============================ 4. timetable: select course, lecturer comes from the course ============================ */
test("5. The rep selects the course: the title and the lecturer come from it, not from typing", async () => {
  const w = fresh();
  w.assignLevel("john", CSC, "200", "COURSE_REP");
  const e = await w.svc.createTimetableEntry(actor("john"), slot(w.csc201.id));
  assert.deepEqual([e.title.includes("CSC201"), e.courseCode, e.lecturerName], [true, "CSC201", "Dr. Bello"]);
  // typed lecturer names are not an input any more: even if one slips through, the assigned lecturers win
  const typed = await w.svc.createTimetableEntry(actor("john"), slot(w.csc202.id, { lecturerName: "Somebody Else", dayOfWeek: "TUE" } as never));
  assert.equal(typed.lecturerName, "Dr. Musa");
  // several lecturers on a course are all shown
  w.assignLevel("peter", CSC, "300", "COURSE_REP");
  assert.equal((await w.svc.createTimetableEntry(actor("peter"), slot(w.csc301.id))).lecturerName, "Dr. Okoro, Prof. Ade");
  // a course with no lecturer assigned yet simply has none
  w.store.courseLecturers.delete(w.csc201.id);
  assert.equal((await w.svc.createTimetableEntry(actor("john"), slot(w.csc201.id, { dayOfWeek: "SAT" }))).lecturerName, null);
});
test("6. The course list a rep chooses from carries each course's lecturer(s)", async () => {
  const w = fresh();
  w.assignLevel("john", CSC, "200", "COURSE_REP");
  const list = await w.svc.listCourses(actor("john"));
  assert.deepEqual(list.map((c) => [c.courseCode, (c as unknown as { lecturers: string[] }).lecturers]).sort(), [["CSC201", ["Dr. Bello"]], ["CSC202", ["Dr. Musa"]]]);
});
test("7. A rep can only select a course of their own level when creating a timetable entry", async () => {
  const w = fresh();
  w.assignLevel("john", CSC, "200", "COURSE_REP");
  for (const id of [w.csc301.id, w.mls201.id]) assert.equal((await rejection(w.svc.createTimetableEntry(actor("john"), slot(id)))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal(w.store.timetable.filter((t) => t.source === "CLASS_REP").length, 0);
});
test("8. The venue is optional: leave it out, send null or empty, and clear it later", async () => {
  const w = fresh();
  w.assignLevel("john", CSC, "200", "COURSE_REP");
  const none = await w.svc.createTimetableEntry(actor("john"), slot(w.csc201.id, { dayOfWeek: "MON" }));
  assert.equal(none.venue, null);
  assert.equal((await w.svc.createTimetableEntry(actor("john"), slot(w.csc201.id, { dayOfWeek: "TUE", venue: null }))).venue, null);
  assert.equal((await w.svc.createTimetableEntry(actor("john"), slot(w.csc201.id, { dayOfWeek: "WED", venue: "   " }))).venue, null);
  const withVenue = await w.svc.createTimetableEntry(actor("john"), slot(w.csc201.id, { dayOfWeek: "THU", venue: "LT 2" }));
  assert.equal(withVenue.venue, "LT 2");
  assert.equal((await w.svc.updateTimetableEntry(actor("john"), withVenue.id, { venue: "" })).venue, null);
  assert.equal((await w.svc.updateTimetableEntry(actor("john"), none.id, { venue: "Lab 1" })).venue, "Lab 1");
  const v = read("src/validators/representative.validators.ts");
  assert.match(v, /const venue = z\.union\(\[z\.string\(\)\.trim\(\)\.max\(100\), z\.null\(\)\]\)\.optional\(\)/);
  assert.match(v, /courseId: objectId,\n\s+title:/); // the course must be selected
  assert.ok(!/lecturerName/.test(v.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "the lecturer is not an input");
});

/* ============================ announcements by a level rep ============================ */
test("9. A level rep announces to their whole level without naming a course; the audience comes from the appointment", async () => {
  const w = fresh();
  w.assignLevel("john", CSC, "200", "COURSE_REP");
  const a = await w.svc.createAnnouncement(actor("john"), { title: "Class meeting", body: "Friday 2pm in LT1" });
  assert.deepEqual([a.audience, a.courseId, a.level, a.status], ["LEVEL", null, "200", "PUBLISHED"]);
  assert.deepEqual(w.notifiedLevels, [{ level: "200", title: "200 Level: Class meeting", exclude: "john" }]);
  assert.equal(w.notified.length, 0); // nobody is notified through a single course
  const rec = w.store.announcements.find((x) => x.id === a.id)!;
  assert.deepEqual([rec.courseId, rec.courseCode, rec.academicSession, rec.departmentId], [undefined, undefined, "2026/2027", CSC]);
  assert.deepEqual((await w.svc.listAnnouncements(actor("john"), {})).map((x) => x.id), [a.id]);
});
test("10. A rep can still address one course of their level; a course outside the level is refused", async () => {
  const w = fresh();
  w.assignLevel("john", CSC, "200", "COURSE_REP");
  const one = await w.svc.createAnnouncement(actor("john"), { courseId: w.csc202.id, title: "CSC202 quiz", body: "Monday" });
  assert.deepEqual([one.audience, one.courseCode], ["COURSE", "CSC202"]);
  assert.deepEqual(w.notified, [{ courseCode: "CSC202", kind: "ANNOUNCEMENT", exclude: "john" }]);
  assert.equal((await rejection(w.svc.createAnnouncement(actor("john"), { courseId: w.csc301.id, title: "Nope", body: "xxx" }))).code, "NOT_ASSIGNED_TO_COURSE");
  assert.equal((await rejection(w.svc.createAnnouncement(actor("john"), { courseId: w.mls201.id, title: "Nope", body: "xxx" }))).code, "NOT_ASSIGNED_TO_COURSE");
});
test("11. Reps of other levels or departments never see, edit or delete another level's announcement", async () => {
  const w = fresh();
  w.assignLevel("john", CSC, "200", "COURSE_REP");
  w.assignLevel("peter", CSC, "300", "COURSE_REP");
  w.assignLevel("mia", MLS, "200", "COURSE_REP");
  const a = await w.svc.createAnnouncement(actor("john"), { title: "For 200L", body: "only for you" });
  assert.deepEqual(await w.svc.listAnnouncements(actor("peter"), {}), []);
  assert.deepEqual(await w.svc.listAnnouncements(actor("mia", MLS), {}), []);
  for (const who of [actor("peter"), actor("mia", MLS)]) {
    assert.equal((await rejection(w.svc.updateAnnouncement(who, a.id, { title: "hijack" }))).status, 404);
    assert.equal((await rejection(w.svc.deleteAnnouncement(who, a.id))).status, 404);
  }
  assert.equal(w.store.announcements.find((x) => x.id === a.id)!.title, "For 200L");
});
test("12. A second rep of the same level can see the class announcements but only the author can change them", async () => {
  const w = fresh();
  w.assignLevel("john", CSC, "200", "COURSE_REP");
  w.assignLevel("ada", CSC, "200", "ASSISTANT_COURSE_REP");
  const a = await w.svc.createAnnouncement(actor("john"), { title: "Shared note", body: "see you" });
  assert.ok((await w.svc.listAnnouncements(actor("ada"), {})).some((x) => x.id === a.id && x.mine === false));
  assert.equal((await rejection(w.svc.updateAnnouncement(actor("ada"), a.id, { title: "mine now" }))).code, "NOT_OWNER");
});

/* ============================ announcement images ============================ */
test("13. A rep attaches a picture: real images only, one stored file, the storage id is never returned", async () => {
  const w = fresh();
  w.assignLevel("john", CSC, "200", "COURSE_REP");
  assert.equal((await rejection(w.svc.createAnnouncement(actor("john"), { title: "Bad", body: "xxx", image: Buffer.from("<script>alert(1)</script>") }))).status, 415);
  assert.equal(w.images.uploaded.length, 0); // nothing reached storage
  const a = await w.svc.createAnnouncement(actor("john"), { title: "With photo", body: "see attached", image: JPEG });
  assert.deepEqual(a.image, { url: "https://cdn.example/img-1.jpg" });
  assert.ok(!JSON.stringify(a).includes("img-1\""), "no publicId in the response");
  assert.equal(w.store.announcements.find((x) => x.id === a.id)!.image!.publicId, "img-1");
});
test("14. Replace, remove and delete clean up the stored picture; a picture alone is a valid edit; an empty edit is refused", async () => {
  const w = fresh();
  w.assignLevel("john", CSC, "200", "COURSE_REP");
  const a = await w.svc.createAnnouncement(actor("john"), { title: "Pic", body: "xxx", image: JPEG });
  const replaced = await w.svc.updateAnnouncement(actor("john"), a.id, { image: JPEG }); // only a file, no text fields
  assert.deepEqual([replaced.image!.url, w.images.deleted], ["https://cdn.example/img-2.jpg", ["img-1"]]);
  assert.equal((await w.svc.updateAnnouncement(actor("john"), a.id, { removeImage: true })).image, null);
  assert.deepEqual(w.images.deleted, ["img-1", "img-2"]);
  assert.equal((await rejection(w.svc.updateAnnouncement(actor("john"), a.id, {}))).code, "NOTHING_TO_UPDATE");
  assert.equal((await rejection(w.svc.updateAnnouncement(actor("john"), a.id, { image: Buffer.from("nope") }))).status, 415);
  const b = await w.svc.createAnnouncement(actor("john"), { title: "Pic 2", body: "xxx", image: JPEG });
  await w.svc.deleteAnnouncement(actor("john"), b.id);
  assert.equal(w.images.deleted.at(-1), "img-3");
});

/* ============================ HOD + lecturer announcements: images ============================ */
test("15. HOD announcements accept a picture (and replace / remove / delete it cleanly)", async () => {
  const w = makeHodWorld();
  assert.equal((await rejection(w.svc.createAnnouncement(hodC, { title: "Bad file", content: "xxx", image: Buffer.from("not an image") }))).status, 415);
  const a = await w.svc.createAnnouncement(hodC, { title: "Orientation", content: "Welcome back", image: JPEG });
  assert.ok(a.image!.url.startsWith("https://cdn.example/ann-"));
  assert.ok(!JSON.stringify(a).includes("publicId"));
  const first = w.store.announcements.find((x) => x.id === a.id)!.image!.publicId!;
  const r = await w.svc.updateAnnouncement(hodC, a.id, { image: JPEG });
  assert.notEqual(r.image!.url, a.image!.url);
  assert.deepEqual(w.deleted.filter((d) => d.startsWith("ann-")), [first]);
  assert.equal((await w.svc.updateAnnouncement(hodC, a.id, { removeImage: true })).image, null);
  assert.equal((await rejection(w.svc.updateAnnouncement(hodC, a.id, {}))).code, "NOTHING_TO_UPDATE");
  const b = await w.svc.createAnnouncement(hodC, { title: "Second", content: "yyy", image: JPEG });
  await w.svc.deleteAnnouncement(hodC, b.id);
  assert.equal(w.deleted.filter((d) => d.startsWith("ann-")).length, 3);
});
test("16. Lecturer announcements accept a picture", async () => {
  const w = makeLecturerWorld();
  assert.equal((await rejection(w.svc.createAnnouncement(lecturer("lecA"), { courseId: w.csc201.id, title: "Bad", content: "xxxx", image: Buffer.from("nope") }))).status, 415);
  const a = await w.svc.createAnnouncement(lecturer("lecA"), { courseId: w.csc201.id, title: "Lab photo", content: "see below", image: JPEG });
  assert.ok(a.image!.url.startsWith("https://cdn.example/ann-"));
  const u = await w.svc.updateAnnouncement(lecturer("lecA"), a.id, { removeImage: true });
  assert.equal(u.image, null);
  assert.equal(w.deleted.filter((d) => d.startsWith("ann-")).length, 1);
  assert.equal((await rejection(w.svc.updateAnnouncement(lecturer("lecA"), a.id, {}))).code, "NOTHING_TO_UPDATE");
});

/* ============================ 5. lecturers don't see course rep announcements ============================ */
test("17. Lecturers never see a course rep's announcement: not in lists, not on the dashboard, not by id", async () => {
  const w = makeLecturerWorld();
  const mine = await w.svc.createAnnouncement(lecturer("lecA"), { courseId: w.csc201.id, title: "Lecturer note", content: "xxxx" });
  const colleague = await w.svc.createAnnouncement(lecturer("lecC"), { courseId: w.csc201.id, title: "Colleague note", content: "yyyy" });
  const ids = (await w.svc.listAnnouncements(lecturer("lecA"), {})).map((x) => x.id);
  assert.ok(ids.includes(mine.id) && ids.includes(colleague.id)); // colleagues on the same course are still visible
  assert.ok(!ids.includes("rep-ann"));
  assert.ok(!(await w.svc.dashboard(lecturer("lecA"))).recentAnnouncements.some((x) => x.id === "rep-ann"));
  for (const p of [w.svc.updateAnnouncement(lecturer("lecA"), "rep-ann", { title: "x" }), w.svc.deleteAnnouncement(lecturer("lecA"), "rep-ann")]) assert.equal((await rejection(p)).code, "NOT_FOUND");
  // even if a store (wrongly) returned it, the service filters student-written announcements out
  const store = w.store, orig = store.listAnnouncements.bind(store);
  store.listAnnouncements = async (...a) => [...(await orig(...a)), { ...store.announcements.find((x) => x.id === "rep-ann")! }];
  assert.ok(!(await w.svc.listAnnouncements(lecturer("lecA"), {})).some((x) => x.id === "rep-ann"));
  const m = read("src/services/lecturer/mongo-store.ts");
  assert.ok((m.match(/createdByLecturer: \{ \$exists: true \}/g) ?? []).length >= 3, "list, get and update are all lecturer-only in Mongo");
});

/* ============================ wiring ============================ */
test("18. Announcement endpoints accept an optional picture and use the picture limiter; students see the image", () => {
  for (const [file, limiter] of [["src/routes/representative.routes.ts", "repUploadLimiter"], ["src/routes/hod.routes.ts", "hodUploadLimiter"], ["src/routes/lecturer.routes.ts", "lecturerUploadLimiter"]]) {
    const chunks = read(file).split(/\nrouter\./).filter((c) => /^(post|patch)\(\s*"\/announcements/.test(c));
    assert.equal(chunks.length, 2, file);
    for (const c of chunks) assert.ok(c.includes("announcementImageUpload") && c.includes(limiter), `${file}: ${c.slice(0, 80)}`);
  }
  assert.match(read("src/services/student-announcements.service.ts"), /image: a\.image\?\.url \? \{ url: a\.image\.url \} : null/);
  assert.match(read("src/models/Announcement.ts"), /publicId: \{ type: String, select: false \}/); // the storage id is never loaded by default
});
test("19. The migration for existing course-scoped appointments exists and the new unique rules are per level", () => {
  const m = read("src/models/CourseRepresentativeAssignment.ts");
  assert.match(m, /one_course_rep_per_level_term/);
  assert.match(m, /scope: "LEVEL"/);
  assert.match(read("src/scripts/migrate-rep-levels.ts"), /syncIndexes/);
  assert.match(read("package.json"), /"migrate:rep-levels"/);
});
