import { createHash } from "node:crypto";
import { HodService } from "../../src/services/hod/hod.service";
import type { ComplaintRec, CourseRec, HodActor } from "../../src/services/hod/types";
import { HodMemoryStore } from "./hod-memory-store";

export const CSC = "d-csc";
export const MLS = "d-mls";
export const S = "2026/2027";
export const T0 = new Date("2026-10-10T10:00:00Z");

export const hodC: HodActor = { hodId: "hodC", departmentId: CSC, firstName: "Hope", lastName: "Chief" };
export const hodM: HodActor = { hodId: "hodM", departmentId: MLS, firstName: "Mark", lastName: "Lead" };
export const meta = { ip: "41.58.0.7" };

export function makeHodWorld() {
  const store = new HodMemoryStore();
  const clock = { now: new Date(T0) };
  store.departments.set(CSC, { id: CSC, name: "Computer Science", code: "CSC", faculty: "Computing", isActive: true, levels: ["100", "200", "300", "400"] });
  store.departments.set(MLS, { id: MLS, name: "Medical Laboratory Science", code: "MLS", faculty: "Health Sciences", isActive: true, levels: ["100", "200", "300", "400", "500"] });
  store.terms.set(CSC, { academicSession: S, semester: "FIRST", registrationOpen: true, maxUnits: 24 });
  store.terms.set(MLS, { academicSession: S, semester: "FIRST", registrationOpen: true, maxUnits: 24 });
  store.hods.push(
    { id: "hodC", firstName: "Hope", lastName: "Chief", email: "hope@uni.example", staffId: "CSC-HOD", departmentId: CSC, role: "HOD", status: "ACTIVE" },
    { id: "hodM", firstName: "Mark", lastName: "Lead", email: "mark@uni.example", staffId: "MLS-HOD", departmentId: MLS, role: "HOD", status: "ACTIVE" },
  );

  const course = (id: string, departmentId: string, courseCode: string, level = "200", semester: "FIRST" | "SECOND" = "FIRST"): CourseRec => ({ id, departmentId, courseCode, title: `${courseCode} title`, units: 3, level, semester, academicSession: S, status: "ACTIVE" });
  const csc201 = course("c-csc201", CSC, "CSC201"), csc202 = course("c-csc202", CSC, "CSC202"), csc101 = course("c-csc101", CSC, "CSC101", "100"), mls201 = course("c-mls201", MLS, "MLS201");
  store.courses.push(csc201, csc202, csc101, mls201);

  const student = (id: string, departmentId: string, first: string, last: string, matric: string, level: string, status: "ACTIVE" | "PENDING_ONBOARDING" | "SUSPENDED" = "ACTIVE") =>
    store.students.push({ id, departmentId, firstName: first, lastName: last, matricNumber: matric, email: `${id}@private.example`, phone: "+2348000000000", level, academicSession: S, status, onboardingCompleted: status !== "PENDING_ONBOARDING" });
  student("john", CSC, "John", "Doe", "25/208CSC/987", "200"); student("ada", CSC, "Ada", "Obi", "24/208CSC/055", "200"); student("sam", CSC, "Sam", "Plain", "24/208CSC/101", "200");
  student("tola", CSC, "Tola", "Ade", "25/208CSC/300", "100"); student("pend", CSC, "Pen", "Ding", "25/208CSC/400", "100", "PENDING_ONBOARDING"); student("susp", CSC, "Sus", "Pended", "23/208CSC/500", "300", "SUSPENDED");
  student("mia", MLS, "Mia", "Bello", "25/208MLS/123", "200"); student("zed", MLS, "Zed", "Ade", "25/208MLS/045", "300");

  const enroll = (studentId: string, departmentId: string, courseCode: string, type: "REGULAR" | "CARRYOVER" = "REGULAR") => store.enrollments.push({ studentId, departmentId, courseCode, academicSession: S, semester: "FIRST", enrollmentType: type, status: "ENROLLED" });
  for (const id of ["john", "ada", "sam"]) enroll(id, CSC, "CSC201");
  enroll("sam", CSC, "CSC202", "CARRYOVER"); enroll("tola", CSC, "CSC101"); enroll("mia", MLS, "MLS201"); enroll("zed", MLS, "MLS201");

  store.lecturers.push(
    { id: "lecA", departmentId: CSC, firstName: "Amina", lastName: "Bello", email: "a@uni.example", staffId: "CSC-001", status: "ACTIVE" },
    { id: "lecI", departmentId: CSC, firstName: "Ivy", lastName: "Invited", email: "i@uni.example", staffId: "CSC-002", status: "INVITED" },
    { id: "lecS", departmentId: CSC, firstName: "Sol", lastName: "Suspended", email: "s@uni.example", staffId: "CSC-003", status: "SUSPENDED" },
    { id: "lecM", departmentId: MLS, firstName: "Chika", lastName: "Eze", email: "c@uni.example", staffId: "MLS-001", status: "ACTIVE" },
  );
  store.lecturerAssigns.push({ id: "la1", lecturerId: "lecA", departmentId: CSC, courseId: csc201.id, courseCode: "CSC201", level: "200", academicSession: S, semester: "FIRST", status: "ACTIVE", assignedBy: { name: "HOD", role: "HOD" }, assignedAt: new Date() });
  store.lecturerAssigns.push({ id: "la2", lecturerId: "lecM", departmentId: MLS, courseId: mls201.id, courseCode: "MLS201", level: "200", academicSession: S, semester: "FIRST", status: "ACTIVE", assignedBy: { name: "HOD", role: "HOD" }, assignedAt: new Date() });

  store.timetable.push(
    { id: "t1", departmentId: CSC, courseCode: "CSC201", level: "200", academicSession: S, semester: "FIRST", title: "CSC201", type: "LECTURE", dayOfWeek: "MON", startTime: "10:00", endTime: "12:00", venue: "LT1", lecturerName: "Dr. Bello", source: "OFFICIAL", status: "PUBLISHED" },
    { id: "t2", departmentId: CSC, courseCode: "CSC202", level: "200", academicSession: S, semester: "FIRST", title: "CSC202", type: "LECTURE", dayOfWeek: "MON", startTime: "11:00", endTime: "13:00", venue: "LT1", lecturerName: "Dr. Musa", source: "CLASS_REP", status: "PUBLISHED", createdByStudentId: "john", createdByRole: "COURSE_REP" },
    { id: "t3", departmentId: CSC, courseCode: "CSC101", level: "100", academicSession: S, semester: "FIRST", title: "CSC101", type: "LECTURE", dayOfWeek: "TUE", startTime: "10:00", endTime: "12:00", venue: "LT2", lecturerName: "Dr. Bello", source: "OFFICIAL", status: "PUBLISHED" },
    { id: "t4", departmentId: MLS, courseCode: "MLS201", level: "200", academicSession: S, semester: "FIRST", title: "MLS201", type: "LECTURE", dayOfWeek: "TUE", startTime: "08:00", endTime: "10:00", venue: "LT1", source: "OFFICIAL", status: "PUBLISHED" },
  );

  store.materials.push(
    { id: "m1", departmentId: CSC, courseCode: "CSC201", title: "Lecture 1", type: "OFFICIAL_COURSE_MATERIAL", ownerName: "Amina Bello", ownerRole: "LECTURER", status: "PUBLISHED", createdAt: new Date() },
    { id: "m2", departmentId: CSC, courseCode: "CSC201", title: "Past questions", type: "CLASS_RESOURCE", ownerName: "John Doe", ownerRole: "COURSE_REP", status: "PUBLISHED", createdAt: new Date() },
    { id: "m3", departmentId: MLS, courseCode: "MLS201", title: "MLS manual", type: "OFFICIAL_COURSE_MATERIAL", ownerName: "Chika Eze", ownerRole: "LECTURER", status: "PUBLISHED", createdAt: new Date() },
  );
  store.announcements.push(
    { id: "a-lec", departmentId: CSC, title: "Lecturer note", body: "x", priority: "NORMAL", status: "PUBLISHED", scope: "COURSE", courseCode: "CSC201", lecturerId: "lecA", authorName: "Amina Bello", authorRole: "LECTURER", publishedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
    { id: "a-mls", departmentId: MLS, title: "MLS note", body: "x", priority: "NORMAL", status: "PUBLISHED", scope: "DEPARTMENT", hodId: "hodM", authorName: "Mark Lead", authorRole: "HOD", publishedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
  );

  const sess = (id: string, departmentId: string, courseId: string, courseCode: string, lecturerId: string, lecturerName: string, startOffsetMin: number, durationMin: number) => {
    const opensAt = new Date(T0.getTime() + startOffsetMin * 60_000);
    store.sessions.push({ id, departmentId, courseId, courseCode, level: "200", academicSession: S, semester: "FIRST", title: `${courseCode} session`, opensAt, closesAt: new Date(opensAt.getTime() + durationMin * 60_000), lateAfterMinutes: 15, status: "ACTIVE", location: { latitude: 6.5, longitude: 3.4, allowedRadiusInMeters: 100 }, lecturerId, lecturerName, createdAt: new Date() });
  };
  sess("s-open", CSC, csc201.id, "CSC201", "lecA", "Amina Bello", -5, 90);
  sess("s-past1", CSC, csc201.id, "CSC201", "lecA", "Amina Bello", -2880, 90);
  sess("s-past2", CSC, csc201.id, "CSC201", "lecA", "Amina Bello", -1440, 90);
  sess("s-mls", MLS, mls201.id, "MLS201", "lecM", "Chika Eze", -5, 90);
  const rec = (sessionId: string, studentId: string, status: "PRESENT" | "LATE", first: string, last: string, matric: string) => store.records.push({ sessionId, studentId, firstName: first, lastName: last, matricNumber: matric, status, markedAt: new Date(T0.getTime() - 60_000), distanceMeters: 20 });
  rec("s-open", "john", "PRESENT", "John", "Doe", "25/208CSC/987"); rec("s-past1", "john", "PRESENT", "John", "Doe", "25/208CSC/987"); rec("s-mls", "mia", "PRESENT", "Mia", "Bello", "25/208MLS/123");
  store.flagged.set("s-open", 2);

  const complaint = (id: string, departmentId: string, studentId: string, studentName: string, matric: string, type: "COURSE" | "HOD", title: string, c?: CourseRec): ComplaintRec => ({
    id, referenceNumber: `CMP-${departmentId === CSC ? "CSC" : "MLS"}-2026-${id}`, departmentId, studentId, studentName, matricNumber: matric, type, title, message: "A detailed description of the problem.", courseId: c?.id, courseCode: c?.courseCode, courseTitle: c?.title,
    status: "SUBMITTED", attachments: [], timeline: [{ status: "SUBMITTED", label: "Complaint submitted", at: new Date(T0.getTime() - 3600_000) }], createdAt: new Date(T0.getTime() - 3600_000), updatedAt: new Date(T0.getTime() - 3600_000),
  });
  store.complaints.push(complaint("1", CSC, "john", "John Doe", "25/208CSC/987", "COURSE", "Missing marks entry for CSC201", csc201), complaint("2", CSC, "ada", "Ada Obi", "24/208CSC/055", "HOD", "Timetable clash"), complaint("m1", MLS, "mia", "Mia Bello", "25/208MLS/123", "HOD", "Lab access"));

  const invites: { to: string; token: string }[] = [];
  const notes: { who: string; kind: string; title: string }[] = [];
  const deleted: string[] = [];
  let tokenN = 0;
  let failInvite = false;
  const svc = new HodService({
    store, now: () => new Date(clock.now),
    generateToken: () => `raw-token-${++tokenN}`, hashToken: (r) => createHash("sha256").update(r).digest("hex"),
    sendInvite: async (to, _f, token) => { if (failInvite) throw new Error("mail down"); invites.push({ to, token }); },
    uploadFile: async (f) => ({ url: `https://cdn.example/${f.originalName}`, publicId: `pub-${f.originalName}`, originalName: f.originalName, mimeType: "application/pdf", sizeBytes: f.buffer.length }),
    deleteFile: async (f) => void deleted.push(f.publicId ?? ""),
    uploadAnnouncementImage: async () => { const publicId = `ann-${++tokenN}`; return { url: `https://cdn.example/${publicId}.jpg`, publicId }; }, deleteAnnouncementImage: async (p) => void deleted.push(p),
    uploadAvatar: async (_b, id) => ({ url: `https://cdn.example/${id}.jpg`, publicId: `avatar-${id}-${++tokenN}` }), deleteAvatar: async (p) => void deleted.push(p),
    signPrivateFile: (f) => `https://signed.example/${f.publicId}`,
    notifyStudent: async (id, _d, n) => void notes.push({ who: id, kind: n.kind, title: n.title }),
    notifyLecturer: async (id, _d, n) => void notes.push({ who: id, kind: n.kind, title: n.title }),
    notifyDepartmentStudents: async (d, levels, n) => void notes.push({ who: `dept:${d}:${levels.join("+") || "all"}`, kind: n.kind, title: n.title }),
  });
  return { store, svc, clock, invites, notes, deleted, setFailInvite: (v: boolean) => { failInvite = v; }, csc201, csc202, csc101, mls201 };
}

export async function rejection(p: Promise<unknown>): Promise<{ status: number; code?: string; message: string }> {
  try { await p; } catch (e) {
    const err = e as { statusCode?: number; code?: string; message: string };
    return { status: err.statusCode ?? 0, code: err.code, message: err.message };
  }
  throw new Error("Expected the call to be rejected, but it succeeded");
}
export const q = (over: object = {}) => ({ page: 1, limit: 20, ...over });
