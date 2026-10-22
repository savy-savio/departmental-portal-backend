import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { groupCourseLecturers, publicLecturers } from "../src/services/course-lecturers-rules";
import { hodC, hodM, makeHodWorld, q } from "./helpers/hod-world";
import { actor, makeLecturerWorld, MLS } from "./helpers/lecturer-world";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const names = (l: { name: string }[]) => l.map((x) => x.name);
type L = { lecturerId: string; name: string }[];
/** DTOs type their extra fields loosely, so read `lecturers` through one typed accessor. */
const lec = (c: unknown): L => (c as { lecturers: L }).lecturers;

test("1. Grouping: names per course, sorted, one entry per lecturer; suspended and unknown lecturers are left out", () => {
  const m = groupCourseLecturers(
    [{ courseId: "c1", lecturerId: "z" }, { courseId: "c1", lecturerId: "a" }, { courseId: "c1", lecturerId: "a" }, { courseId: "c1", lecturerId: "sus" }, { courseId: "c1", lecturerId: "gone" }, { courseId: "c2", lecturerId: "a" }],
    [{ id: "a", firstName: "Amina", lastName: "Bello", status: "ACTIVE" }, { id: "z", firstName: "Zed", lastName: "Ade", status: "INVITED" }, { id: "sus", firstName: "Sus", lastName: "Pended", status: "SUSPENDED" }],
  );
  assert.deepEqual(m.get("c1"), [{ lecturerId: "a", name: "Amina Bello" }, { lecturerId: "z", name: "Zed Ade" }]);
  assert.deepEqual(m.get("c2"), [{ lecturerId: "a", name: "Amina Bello" }]);
  assert.equal(m.get("c3"), undefined);
});
test("2. Students only ever get the name: no id, email or phone", () => {
  assert.deepEqual(publicLecturers([{ lecturerId: "a", name: "Amina Bello" }]), [{ name: "Amina Bello" }]);
  assert.deepEqual(publicLecturers(undefined), []);
  const src = read("src/services/student-courses.service.ts");
  assert.match(src, /lecturers: publicLecturers\(lecturers\)/);
  for (const fn of ["listMyCourses", "listAvailableCourses", "listCarryoverOptions", "courseHistory", "addCourse", "updateEnrollment"]) assert.match(src, new RegExp(`function ${fn}`));
  assert.equal((src.match(/lecturerNames\(/g) ?? []).length >= 7, true); // every student course view looks the names up
  assert.ok(!/email|phone|staffId/.test(read("src/services/course-lecturers.ts").replace(/\/\/.*$/gm, "")), "the lookup never selects contact details");
});
test("3. The HOD's course list shows who teaches each course; a course with nobody assigned shows an empty list", async () => {
  const w = makeHodWorld();
  const list = (await w.svc.listCourses(hodC, q())).items;
  assert.deepEqual(lec(list.find((c) => c.id === w.csc201.id)), [{ lecturerId: "lecA", name: "Amina Bello" }]);
  assert.deepEqual(lec(list.find((c) => c.id === w.csc101.id)), []);
  assert.ok(Array.isArray(lec(await w.svc.getCourse(hodC, w.csc201.id)))); // detail unchanged
});
test("4. Another department's lecturers never appear on a course", async () => {
  const w = makeHodWorld();
  const mls = (await w.svc.listCourses(hodM, q())).items.find((c) => c.id === w.mls201.id)!;
  assert.deepEqual(lec(mls).map((l) => l.lecturerId), ["lecM"]);
  assert.ok((await w.svc.listCourses(hodC, q())).items.every((c) => !lec(c).some((l) => l.lecturerId === "lecM")));
});
test("5. A lecturer sees the names of everyone assigned to each of their courses (co-lecturers included)", async () => {
  const w = makeLecturerWorld();
  const courses = await w.svc.listCourses(actor("lecA"));
  const csc201 = courses.find((c) => c.courseCode === "CSC201")!, csc203 = courses.find((c) => c.courseCode === "CSC203")!;
  assert.deepEqual(names(lec(csc201)), ["lecA Staff", "lecC Staff"]);
  assert.deepEqual(names(lec(csc203)), ["lecA Staff"]);
  const detail = await w.svc.getCourse(actor("lecA"), w.csc201.id);
  assert.deepEqual(names(lec(detail)), ["lecA Staff", "lecC Staff"]);
  const dash = await w.svc.dashboard(actor("lecA"));
  assert.deepEqual(names(lec(dash.courses.find((c) => c.courseCode === "CSC201"))), ["lecA Staff", "lecC Staff"]);
});
test("6. Revoked or suspended lecturers drop off the course; other departments' lecturers are never listed", async () => {
  const w = makeLecturerWorld();
  w.store.assignments.find((a) => a.lecturerId === "lecC")!.status = "REVOKED";
  assert.deepEqual(names(lec(await w.svc.getCourse(actor("lecA"), w.csc201.id))), ["lecA Staff"]);
  w.store.assignments.push({ ...w.aA201, id: "la-x", lecturerId: "lecB" });
  w.store.lecturers.find((l) => l.id === "lecB")!.status = "SUSPENDED";
  assert.deepEqual(names(lec(await w.svc.getCourse(actor("lecA"), w.csc201.id))), ["lecA Staff"]);
  // an MLS lecturer wrongly attached to a CSC course id is still not shown to the CSC department
  w.store.assignments.push({ ...w.aA201, id: "la-y", lecturerId: "lecM", departmentId: MLS });
  assert.deepEqual(names(lec(await w.svc.getCourse(actor("lecA"), w.csc201.id))), ["lecA Staff"]);
  assert.deepEqual(names(lec((await w.svc.listCourses(actor("lecM", MLS)))[0])), ["lecM Staff"]);
});
