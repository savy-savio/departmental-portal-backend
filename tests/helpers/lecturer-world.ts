import { LecturerService } from "../../src/services/lecturer/lecturer.service";
import type { CourseRec, LecturerActor, LecturerAssignmentRec, StoredFile } from "../../src/services/lecturer/types";
import { LecturerMemoryStore } from "./lecturer-memory-store";

export const CSC = "d-csc";
export const MLS = "d-mls";
export const S = "2026/2027";
export const T0 = new Date("2026-10-10T10:00:00Z");
export const CAMPUS = { latitude: 6.5244, longitude: 3.3792 };
export const NEAR = { latitude: CAMPUS.latitude + 0.0003, longitude: CAMPUS.longitude };
export const FAR = { latitude: CAMPUS.latitude + 0.02, longitude: CAMPUS.longitude };

export const actor = (lecturerId: string, departmentId = CSC): LecturerActor => ({ lecturerId, departmentId, firstName: lecturerId, lastName: "Staff" });
export const meta = { ip: "41.58.0.9" };

export function makeLecturerWorld() {
  const store = new LecturerMemoryStore();
  const clock = { now: new Date(T0) };
  store.terms.set(CSC, { academicSession: S, semester: "FIRST" });
  store.terms.set(MLS, { academicSession: S, semester: "FIRST" });
  store.departments.set(CSC, { id: CSC, name: "Computer Science", code: "CSC" });
  store.departments.set(MLS, { id: MLS, name: "Medical Laboratory Science", code: "MLS" });

  const course = (id: string, departmentId: string, courseCode: string): CourseRec => ({ id, departmentId, courseCode, title: `${courseCode} title`, units: 3, level: "200", semester: "FIRST", academicSession: S, status: "ACTIVE" });
  const csc201 = course("c-csc201", CSC, "CSC201");
  const csc202 = course("c-csc202", CSC, "CSC202");
  const csc203 = course("c-csc203", CSC, "CSC203");
  const mls201 = course("c-mls201", MLS, "MLS201");
  store.courses.push(csc201, csc202, csc203, mls201);

  const lecturer = (id: string, departmentId: string, staffId: string) =>
    store.lecturers.push({ id, firstName: id, lastName: "Staff", email: `${id}@uni.example`, phone: "+2348011111111", staffId, departmentId, role: "LECTURER", status: "ACTIVE" });
  lecturer("lecA", CSC, "CSC-001"); lecturer("lecB", CSC, "CSC-002"); lecturer("lecC", CSC, "CSC-003"); lecturer("lecM", MLS, "MLS-001"); lecturer("lecNone", CSC, "CSC-004");

  const student = (id: string, departmentId: string, first: string, last: string, matric: string) =>
    store.students.push({ id, departmentId, firstName: first, lastName: last, matricNumber: matric, email: `${id}@private.example`, phone: "+2348000000000", level: "200" });
  student("john", CSC, "John", "Doe", "25/208CSC/987"); student("ada", CSC, "Ada", "Obi", "24/208CSC/055");
  student("sam", CSC, "Sam", "Plain", "24/208CSC/101"); student("peter", CSC, "Peter", "Eze", "24/208CSC/078");
  student("mia", MLS, "Mia", "Bello", "25/208MLS/123");
  const enroll = (studentId: string, departmentId: string, courseCode: string, type: "REGULAR" | "CARRYOVER" = "REGULAR") =>
    store.enrollments.push({ studentId, departmentId, courseCode, academicSession: S, semester: "FIRST", type });
  for (const id of ["john", "ada", "sam"]) enroll(id, CSC, "CSC201");
  enroll("sam", CSC, "CSC202", "CARRYOVER"); enroll("peter", CSC, "CSC202"); enroll("mia", MLS, "MLS201");

  let n = 0;
  const assign = (lecturerId: string, departmentId: string, c: CourseRec): LecturerAssignmentRec => {
    const a: LecturerAssignmentRec = { id: `la-${++n}`, lecturerId, departmentId, courseId: c.id, courseCode: c.courseCode, level: c.level, academicSession: S, semester: "FIRST", status: "ACTIVE", assignedBy: { name: "HOD", role: "HOD" }, assignedAt: new Date() };
    store.assignments.push(a);
    return a;
  };
  const aA201 = assign("lecA", CSC, csc201);
  assign("lecA", CSC, csc203);
  assign("lecC", CSC, csc201); // co-lecturer on the same course
  const aB202 = assign("lecB", CSC, csc202);
  const aM201 = assign("lecM", MLS, mls201);

  // timetable: an official slot and a Course Rep's class slot for CSC201
  store.timetable.push(
    { id: "tt-official", departmentId: CSC, courseCode: "CSC201", level: "200", academicSession: S, semester: "FIRST", title: "CSC201", type: "LECTURE", dayOfWeek: "MON", startTime: "10:00", endTime: "12:00", venue: "LT1", lecturerName: "Dr. A", source: "OFFICIAL", status: "PUBLISHED" },
    { id: "tt-rep", departmentId: CSC, courseCode: "CSC201", level: "200", academicSession: S, semester: "FIRST", title: "CSC201 tutorial", type: "TUTORIAL", dayOfWeek: "FRI", startTime: "14:00", endTime: "15:00", venue: "LT3", source: "CLASS_REP", status: "PUBLISHED", createdByStudentId: "john", createdByRole: "COURSE_REP" },
    { id: "tt-draft", departmentId: CSC, courseCode: "CSC201", level: "200", academicSession: S, semester: "FIRST", title: "draft", type: "LECTURE", dayOfWeek: "SAT", startTime: "09:00", endTime: "10:00", source: "CLASS_REP", status: "DRAFT", createdByStudentId: "john", createdByRole: "COURSE_REP" },
    { id: "tt-mls", departmentId: MLS, courseCode: "MLS201", level: "200", academicSession: S, semester: "FIRST", title: "MLS201", type: "LECTURE", dayOfWeek: "TUE", startTime: "08:00", endTime: "10:00", source: "OFFICIAL", status: "PUBLISHED" },
  );

  // things a representative wrote (must stay untouchable by lecturers)
  const file: StoredFile = { url: "https://example.com/x.pdf", originalName: "x.pdf", mimeType: "application/pdf", sizeBytes: 10 };
  store.materials.push({ id: "rep-res", departmentId: CSC, courseId: csc201.id, courseCode: "CSC201", level: "200", academicSession: S, semester: "FIRST", title: "Past questions", type: "CLASS_RESOURCE", file, studentId: "john", uploadedByName: "John", uploadedByRole: "COURSE_REP", status: "PUBLISHED", createdAt: new Date(), updatedAt: new Date() });
  store.announcements.push({ id: "rep-ann", departmentId: CSC, courseId: csc201.id, courseCode: "CSC201", level: "200", academicSession: S, semester: "FIRST", title: "Rep note", body: "bring pens", priority: "NORMAL", status: "PUBLISHED", studentId: "john", authorName: "John", authorRole: "COURSE_REP", publishedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });

  let avatarN = 0;
  const notified: { courseCode: string; kind: string }[] = [];
  const deleted: string[] = [];
  let imgN = 0;
  const hodNotes: { departmentId: string; kind: string; title: string; complaintId: string }[] = [];
  const studentNotes: { studentId: string; departmentId: string; kind: string; title: string }[] = [];
  const svc = new LecturerService({
    store, now: () => new Date(clock.now),
    notifyClass: async (c, nn) => void notified.push({ courseCode: c.courseCode, kind: nn.kind }),
    uploadFile: async (f) => ({ url: `https://cdn.example/${f.originalName}`, publicId: `pub-${f.originalName}`, originalName: f.originalName, mimeType: "application/pdf", sizeBytes: f.buffer.length }),
    deleteFile: async (f) => void deleted.push(f.publicId ?? ""),
    uploadAvatar: async (_b, id) => ({ url: `https://cdn.example/avatar-${id}.jpg`, publicId: `avatar-${id}-${++avatarN}` }), // unique per upload, like the real one
    deleteAvatar: async (p) => void deleted.push(p),
    signSubmissionFile: (f) => `https://signed.example/${f.publicId}`,
    uploadAnnouncementImage: async () => { const publicId = `ann-${++imgN}`; return { url: `https://cdn.example/${publicId}.jpg`, publicId }; },
    deleteAnnouncementImage: async (p) => void deleted.push(p),
    notifyHod: async (departmentId, n) => void hodNotes.push({ departmentId, kind: n.kind, title: n.title, complaintId: n.complaintId }),
    notifyStudent: async (studentId, departmentId, n) => void studentNotes.push({ studentId, departmentId, kind: n.kind, title: n.title }),
  });
  return { store, svc, clock, notified, deleted, hodNotes, studentNotes, csc201, csc202, csc203, mls201, aA201, aB202, aM201 };
}

export async function rejection(p: Promise<unknown>): Promise<{ status: number; code?: string; message: string; details?: unknown }> {
  try { await p; } catch (e) {
    const err = e as { statusCode?: number; code?: string; message: string; details?: unknown };
    return { status: err.statusCode ?? 0, code: err.code, message: err.message, details: err.details };
  }
  throw new Error("Expected the call to be rejected, but it succeeded");
}
