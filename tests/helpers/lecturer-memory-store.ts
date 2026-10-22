import { randomUUID } from "node:crypto";
import { groupCourseLecturers } from "../../src/services/course-lecturers-rules";
import type { LecturerStore } from "../../src/services/lecturer/store";
import type {
  AnnouncementRec, AttendanceRecordView, CourseRec, CourseWorkRec, LecturerAssignmentRec, LecturerAuditRec, LecturerRec, LecturerSessionRec,
  MaterialRec, MemberRec, NotificationView, SubmissionView, TimetableRec, LecturerComplaintEvent, LecturerComplaintQuery, LecturerComplaintRec,
} from "../../src/services/lecturer/types";
import type { ComplaintStatusName } from "../../src/services/hod/policy";

export interface StudentRow { id: string; departmentId: string; firstName: string; lastName: string; matricNumber: string; email: string; phone: string; level: string }
export interface EnrollmentRow { studentId: string; departmentId: string; courseCode: string; academicSession: string; semester: "FIRST" | "SECOND"; type: "REGULAR" | "CARRYOVER" }
export interface NotificationRow extends NotificationView { recipientId: string }

/** In-memory LecturerStore applying the same department / ownership / type filters as the Mongo store. */
export class LecturerMemoryStore implements LecturerStore {
  terms = new Map<string, { academicSession: string; semester: "FIRST" | "SECOND" }>();
  departments = new Map<string, { id: string; name: string; code: string }>();
  lecturers: LecturerRec[] = [];
  assignments: LecturerAssignmentRec[] = [];
  courses: CourseRec[] = [];
  students: StudentRow[] = [];
  enrollments: EnrollmentRow[] = [];
  timetable: TimetableRec[] = [];
  announcements: AnnouncementRec[] = [];
  materials: MaterialRec[] = [];
  work: CourseWorkRec[] = [];
  submissions: SubmissionView[] = [];
  sessions: LecturerSessionRec[] = [];
  records: AttendanceRecordView[] = [];
  notifications: NotificationRow[] = [];
  flagged = new Map<string, number>();
  /** Same record shape as the HOD store, so a test can hand BOTH stores the very same array. */
  complaints: LecturerComplaintRec[] = [];
  audit: LecturerAuditRec[] = [];

  async listComplaints(d: string, lecturerId: string, q: LecturerComplaintQuery) {
    const needle = q.search?.toLowerCase();
    const rows = this.complaints
      .filter((c) => c.departmentId === d && c.assignedLecturer?.id === lecturerId && (!q.status || c.status === q.status) && (!q.courseId || c.courseId === q.courseId)
        && (!q.from || c.createdAt >= q.from) && (!q.to || c.createdAt <= q.to) && (!needle || `${c.referenceNumber} ${c.title} ${c.courseCode ?? ""} ${c.studentName} ${c.matricNumber}`.toLowerCase().includes(needle)))
      .sort((a, b) => (q.order === "asc" ? 1 : -1) * (a.createdAt.getTime() - b.createdAt.getTime()));
    return { items: rows.slice((q.page - 1) * q.limit, q.page * q.limit), total: rows.length };
  }
  async getAssignedComplaint(d: string, lecturerId: string, id: string) { return this.complaints.find((c) => c.id === id && c.departmentId === d && c.assignedLecturer?.id === lecturerId) ?? null; }
  async appendComplaintEvent(d: string, lecturerId: string, id: string, expected: readonly ComplaintStatusName[], event: LecturerComplaintEvent, newStatus?: ComplaintStatusName) {
    const c = this.complaints.find((x) => x.id === id && x.departmentId === d && x.assignedLecturer?.id === lecturerId && expected.includes(x.status));
    if (!c) return null; // same conditional write as the Mongo store
    if (newStatus) c.status = newStatus;
    c.timeline.push(event); c.updatedAt = new Date();
    return c;
  }

  async courseLecturers(d: string, courseIds: string[]) {
    return groupCourseLecturers(
      this.assignments.filter((a) => a.departmentId === d && a.status === "ACTIVE" && courseIds.includes(a.courseId)).map((a) => ({ courseId: a.courseId, lecturerId: a.lecturerId })),
      this.lecturers.filter((l) => l.departmentId === d).map((l) => ({ id: l.id, firstName: l.firstName, lastName: l.lastName, status: l.status })),
    );
  }
  async getCurrentTerm(d: string) { return this.terms.get(d) ?? null; }
  async getLecturer(id: string) { return this.lecturers.find((l) => l.id === id) ?? null; }
  async getDepartment(id: string) { return this.departments.get(id) ?? null; }
  async updateLecturerProfile(id: string, patch: { phone?: string | null; profilePhoto?: string | null; profilePhotoPublicId?: string | null }) {
    const l = this.lecturers.find((x) => x.id === id);
    if (!l) return null;
    // Only these three fields exist as parameters: role / department / staffId / email can't be reached.
    if (patch.phone !== undefined) l.phone = patch.phone ?? undefined;
    if (patch.profilePhoto !== undefined) l.profilePhoto = patch.profilePhoto ?? undefined;
    if (patch.profilePhotoPublicId !== undefined) l.profilePhotoPublicId = patch.profilePhotoPublicId ?? undefined;
    return l;
  }
  async assignmentsForLecturer(id: string) { return this.assignments.filter((a) => a.lecturerId === id); }
  async getCourse(id: string, d: string) { return this.courses.find((c) => c.id === id && c.departmentId === d) ?? null; }

  private enrolled(c: CourseRec) {
    return this.enrollments.filter((e) => e.departmentId === c.departmentId && e.courseCode === c.courseCode && e.academicSession === c.academicSession && e.semester === c.semester);
  }
  private members(c: CourseRec): MemberRec[] {
    return this.enrolled(c).map((e) => ({ e, s: this.students.find((s) => s.id === e.studentId && s.departmentId === c.departmentId) }))
      .filter((x): x is { e: EnrollmentRow; s: StudentRow } => Boolean(x.s))
      .map(({ e, s }) => ({ studentId: s.id, firstName: s.firstName, lastName: s.lastName, matricNumber: s.matricNumber, level: s.level, enrollmentType: e.type }));
  }
  async listMembers(c: CourseRec, q: { page: number; limit: number; search?: string }) {
    const needle = q.search?.toLowerCase();
    const rows = this.members(c).filter((m) => !needle || `${m.firstName} ${m.lastName} ${m.matricNumber}`.toLowerCase().includes(needle)).sort((a, b) => a.lastName.localeCompare(b.lastName));
    return { items: rows.slice((q.page - 1) * q.limit, q.page * q.limit), total: rows.length };
  }
  async countMembers(c: CourseRec) { return this.members(c).length; }
  async listTimetable(courses: CourseRec[]) {
    return this.timetable.filter((t) => courses.some((c) => t.departmentId === c.departmentId && t.academicSession === c.academicSession && t.semester === c.semester && t.courseCode === c.courseCode));
  }

  async createAnnouncement(rec: Omit<AnnouncementRec, "id" | "createdAt" | "updatedAt">) { const r = { ...rec, id: randomUUID(), createdAt: new Date(), updatedAt: new Date() }; this.announcements.push(r); return r; }
  async getAnnouncement(id: string, d: string) { return this.announcements.find((a) => a.id === id && a.departmentId === d && a.lecturerId) ?? null; } // lecturer-written only (like the Mongo store)
  async updateAnnouncement(id: string, patch: Partial<AnnouncementRec> & { image?: AnnouncementRec["image"] | null }) {
    const a = this.announcements.find((x) => x.id === id && x.lecturerId); // lecturer-written only (same guard as Mongo)
    if (!a) return null;
    const { image, ...rest } = patch;
    Object.assign(a, rest, { updatedAt: new Date() });
    if (image === null) delete a.image; else if (image) a.image = image;
    return a;
  }
  async listAnnouncements(courseIds: string[], viewer: string) {
    return this.announcements.filter((a) => a.lecturerId && courseIds.includes(a.courseId) && a.status !== "DELETED" && (a.status === "PUBLISHED" || a.lecturerId === viewer));
  }

  async createMaterial(rec: Omit<MaterialRec, "id" | "createdAt" | "updatedAt">) { const r = { ...rec, id: randomUUID(), createdAt: new Date(), updatedAt: new Date() }; this.materials.push(r); return r; }
  async getMaterial(id: string, d: string) { return this.materials.find((m) => m.id === id && m.departmentId === d) ?? null; }
  async updateMaterial(id: string, patch: Partial<MaterialRec>) {
    const m = this.materials.find((x) => x.id === id && x.type === "OFFICIAL_COURSE_MATERIAL");
    if (!m) return null;
    Object.assign(m, patch, { updatedAt: new Date() });
    return m;
  }
  async deleteMaterial(id: string) { this.materials = this.materials.filter((m) => !(m.id === id && m.type === "OFFICIAL_COURSE_MATERIAL")); }
  async listOfficialMaterials(courses: CourseRec[]) {
    return this.materials.filter((m) => m.type === "OFFICIAL_COURSE_MATERIAL" && courses.some((c) => c.departmentId === m.departmentId && c.courseCode === m.courseCode && c.academicSession === m.academicSession && c.semester === m.semester));
  }

  async createCourseWork(rec: Omit<CourseWorkRec, "id" | "createdAt" | "updatedAt">) { const r = { ...rec, id: randomUUID(), createdAt: new Date(), updatedAt: new Date() }; this.work.push(r); return r; }
  async getCourseWork(id: string, d: string) { return this.work.find((w) => w.id === id && w.departmentId === d) ?? null; }
  async updateCourseWork(id: string, patch: Record<string, unknown>) {
    const w = this.work.find((x) => x.id === id);
    if (!w) return null;
    for (const [k, v] of Object.entries(patch)) { if (k === "attachment" && v === null) delete w.attachment; else (w as unknown as Record<string, unknown>)[k] = v; }
    w.updatedAt = new Date();
    return w;
  }
  async deleteCourseWork(id: string) { this.work = this.work.filter((w) => w.id !== id); }
  async listCourseWork(courseIds: string[]) { return this.work.filter((w) => courseIds.includes(w.courseId)); }
  async countSubmissions(id: string) { return this.submissions.filter((s) => s.assignmentId === id).length; }
  async listSubmissions(id: string) { return this.submissions.filter((s) => s.assignmentId === id); }

  async createAttendanceSession(rec: Omit<LecturerSessionRec, "id" | "createdAt">) { const r = { ...rec, id: randomUUID(), createdAt: new Date() }; this.sessions.push(r); return r; }
  async getAttendanceSession(id: string, d: string) { return this.sessions.find((s) => s.id === id && s.departmentId === d) ?? null; }
  async updateAttendanceSession(id: string, patch: Partial<LecturerSessionRec>) { const s = this.sessions.find((x) => x.id === id); if (!s) return null; Object.assign(s, patch); return s; }
  async listAttendanceSessions(c: CourseRec) { return this.sessions.filter((s) => s.departmentId === c.departmentId && s.courseCode === c.courseCode && s.academicSession === c.academicSession && s.semester === c.semester); }
  async recordsForSessions(ids: string[]) { return this.records.filter((r) => ids.includes(r.sessionId)); }
  async flaggedAttempts(id: string) { return this.flagged.get(id) ?? 0; }

  async listNotifications(id: string, q: { page: number; limit: number; unread?: boolean }) {
    const mine = this.notifications.filter((n) => n.recipientId === id);
    const rows = mine.filter((n) => !q.unread || !n.read);
    return { items: rows.slice((q.page - 1) * q.limit, q.page * q.limit), total: rows.length, unread: mine.filter((n) => !n.read).length };
  }
  async markNotificationRead(id: string, nid: string) { const n = this.notifications.find((x) => x.id === nid && x.recipientId === id); if (!n) return null; n.read = true; return n; }
  async markAllNotificationsRead(id: string) { const rows = this.notifications.filter((n) => n.recipientId === id && !n.read); rows.forEach((n) => (n.read = true)); return rows.length; }
  async unreadNotificationCount(id: string) { return this.notifications.filter((n) => n.recipientId === id && !n.read).length; }

  async addAudit(rec: LecturerAuditRec) { this.audit.push(rec); }
}
