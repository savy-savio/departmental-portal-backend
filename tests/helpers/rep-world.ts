import { RepresentativeService } from "../../src/services/representative/representative.service";
import type { AssignmentRec, CourseRec, RepActor, StoredFile } from "../../src/services/representative/types";
import { RepMemoryStore } from "./rep-memory-store";

export const CSC = "d-csc";
export const MLS = "d-mls";
const S = "2026/2027";

export const actor = (studentId: string, departmentId = CSC): RepActor => ({ studentId, departmentId, firstName: studentId, lastName: "Tester" });

export function makeRepWorld(opts: { permissions?: import("../../src/services/representative/policy").PermissionTable } = {}) {
  const store = new RepMemoryStore();
  store.terms.set(CSC, { academicSession: S, semester: "FIRST" });
  store.terms.set(MLS, { academicSession: S, semester: "FIRST" });

  const course = (id: string, departmentId: string, courseCode: string, level = "200"): CourseRec => ({ id, departmentId, courseCode, title: `${courseCode} title`, units: 3, level, semester: "FIRST", academicSession: S, status: "ACTIVE" });
  const csc201 = course("c-csc201", CSC, "CSC201");
  const csc202 = course("c-csc202", CSC, "CSC202");
  const mls201 = course("c-mls201", MLS, "MLS201");
  const csc301 = course("c-csc301", CSC, "CSC301", "300");
  store.courses.push(csc201, csc202, csc301, mls201);
  // The lecturer(s) ASSIGNED to each course (the only source of "the lecturer of this course").
  store.courseLecturers.set(csc201.id, ["Dr. Bello"]);
  store.courseLecturers.set(csc202.id, ["Dr. Musa"]);
  store.courseLecturers.set(csc301.id, ["Dr. Okoro", "Prof. Ade"]);
  store.courseLecturers.set(mls201.id, ["Dr. Eze"]);

  const student = (id: string, departmentId: string, first: string, last: string, matric: string, level = "200") =>
    store.students.push({ id, departmentId, firstName: first, lastName: last, matricNumber: matric, email: `${id}@private.example`, phone: "+2348000000000", level, profilePhoto: `https://img/${id}.jpg` });
  student("john", CSC, "John", "Doe", "25/208CSC/987");
  student("ada", CSC, "Ada", "Obi", "24/208CSC/055");
  student("peter", CSC, "Peter", "Eze", "24/208CSC/078");
  student("sam", CSC, "Sam", "Plain", "24/208CSC/101");
  student("mia", MLS, "Mia", "Bello", "25/208MLS/123");
  student("zed", MLS, "Zed", "Ade", "25/208MLS/045");

  const enroll = (studentId: string, departmentId: string, courseCode: string, type: "REGULAR" | "CARRYOVER" = "REGULAR") =>
    store.enrollments.push({ studentId, departmentId, courseCode, academicSession: S, semester: "FIRST", type });
  for (const id of ["john", "ada", "sam"]) enroll(id, CSC, "CSC201");
  enroll("sam", CSC, "CSC202", "CARRYOVER");
  enroll("peter", CSC, "CSC202");
  enroll("mia", MLS, "MLS201");
  enroll("zed", MLS, "MLS201");

  const addTimetable = (departmentId: string, courseCode: string | undefined, day: "MON" | "TUE" | "WED", start: string, lec: string, level = "200") =>
    store.timetable.push({ id: `${departmentId}-${courseCode}-${day}`, departmentId, academicSession: S, semester: "FIRST", courseCode, title: `${courseCode} class`, type: "LECTURE", dayOfWeek: day, startTime: start, endTime: "12:00", venue: "LT1", lecturerName: lec, level, source: "OFFICIAL", status: "PUBLISHED" });
  addTimetable(CSC, "CSC201", "WED", "08:00", "Dr. Bello");
  addTimetable(CSC, "CSC201", "MON", "10:00", "Dr. Bello");
  addTimetable(CSC, "CSC202", "TUE", "10:00", "Dr. Musa");
  addTimetable(MLS, "MLS201", "TUE", "08:00", "Dr. Eze");

  let n = 0;
  const assign = (studentId: string, departmentId: string, c: CourseRec, role: AssignmentRec["role"]): AssignmentRec => {
    const a: AssignmentRec = {
      id: `asg-${++n}`, studentId, departmentId, courseId: c.id, courseCode: c.courseCode, level: c.level, academicSession: S,
      semester: "FIRST", role, status: "ACTIVE", assignedBy: { name: "HOD", role: "HOD" }, assignedAt: new Date(),
    };
    store.assignments.push(a);
    return a;
  };
  /** Level appointment (the new model): covers every course of the level in the term, and the class itself. */
  const assignLevel = (studentId: string, departmentId: string, level: string, role: AssignmentRec["role"]): AssignmentRec => {
    const a: AssignmentRec = {
      id: `lvl-${++n}`, studentId, departmentId, scope: "LEVEL", level, academicSession: S, semester: "FIRST", role, status: "ACTIVE",
      assignedBy: { name: "HOD", role: "HOD" }, assignedAt: new Date(),
    };
    store.assignments.push(a);
    return a;
  };
  const johnAsg = assign("john", CSC, csc201, "COURSE_REP");
  const adaAsg = assign("ada", CSC, csc201, "ASSISTANT_COURSE_REP");
  const peterAsg = assign("peter", CSC, csc202, "COURSE_REP");
  const miaAsg = assign("mia", MLS, mls201, "COURSE_REP");
  const zedAsg = assign("zed", MLS, mls201, "ASSISTANT_COURSE_REP");

  // An OFFICIAL lecturer material for CSC201 (lecturer phase owns these).
  const file: StoredFile = { url: "https://example.com/official.pdf", originalName: "official.pdf", mimeType: "application/pdf", sizeBytes: 100, publicId: "official-1", resourceType: "raw" };
  store.resources.push({
    id: "official-1", departmentId: CSC, courseId: csc201.id, courseCode: "CSC201", level: "200", academicSession: S, semester: "FIRST",
    title: "Official lecture 1", type: "OFFICIAL_COURSE_MATERIAL", file, uploadedByName: "Dr. Bello", uploadedByRole: "LECTURER",
    status: "PUBLISHED", createdAt: new Date(), updatedAt: new Date(),
  });

  const notified: { courseCode: string; kind: string; exclude: string }[] = [];
  const notifiedLevels: { level: string; title: string; exclude: string }[] = [];
  const images = { uploaded: [] as string[], deleted: [] as string[] };
  const deletedFiles: string[] = [];
  const svc = new RepresentativeService({
    store, permissions: opts.permissions, now: () => new Date("2026-10-10T10:00:00Z"),
    notifyClass: async (c, n, exclude) => void notified.push({ courseCode: c.courseCode, kind: n.kind, exclude }),
    notifyLevel: async (c, n, exclude) => void notifiedLevels.push({ level: c.level, title: n.title, exclude }),
    uploadAnnouncementImage: async () => { const publicId = `img-${images.uploaded.length + 1}`; images.uploaded.push(publicId); return { url: `https://cdn.example/${publicId}.jpg`, publicId }; },
    deleteAnnouncementImage: async (publicId) => void images.deleted.push(publicId),
    unreadNotifications: async () => 3,
    uploadFile: async (f) => ({ url: `https://cdn.example/${f.originalName}`, publicId: `up-${f.originalName}`, resourceType: "raw", originalName: f.originalName, mimeType: "application/pdf", sizeBytes: f.buffer.length }),
    deleteFile: async (f) => void deletedFiles.push(f.publicId ?? ""),
  });
  return { store, svc, notified, notifiedLevels, images, assignLevel, deletedFiles, csc201, csc202, csc301, mls201, johnAsg, adaAsg, peterAsg, miaAsg, zedAsg };
}

export async function rejection(p: Promise<unknown>): Promise<{ status: number; code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { statusCode?: number; code?: string; message: string };
    return { status: err.statusCode ?? 0, code: err.code, message: err.message };
  }
  throw new Error("Expected the call to be rejected, but it succeeded");
}
