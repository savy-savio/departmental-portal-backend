import { groupCourseLecturers } from "../../src/services/course-lecturers-rules";
import { randomUUID } from "node:crypto";
import { StoreDuplicateError, type HodStore } from "../../src/services/hod/store";
import type {
  ActivityItem, AttendanceRecordView, ComplaintEvent, ComplaintPatch, ComplaintRec, CourseAttendanceStat, CourseRec, CourseView, DashboardCounts, DeptRec, DocumentRec,
  EnrollmentView, HodAnnouncementRec, HodAuditRec, HodRec, LecturerAssignmentRec, LecturerAssignmentView, LecturerRow, ListQuery, MaterialOverview, NotificationView, Page,
  RepAssignmentView, SessionView, StudentAttendanceRow, StudentRow, TermRec, TimetableRec,
} from "../../src/services/hod/types";

type D = { departmentId: string };
export type StudentX = StudentRow & D;
export type LecturerX = LecturerRow & D;
export type EnrollmentX = D & { studentId: string; courseCode: string; academicSession: string; semester: "FIRST" | "SECOND"; enrollmentType: "REGULAR" | "CARRYOVER"; status: string };
export type ComplaintX = ComplaintRec;
export type MaterialX = MaterialOverview & D;

function pageOf<T>(items: T[], q: ListQuery, text?: (t: T) => string, sortKey?: (t: T, k: string) => string | number): Page<T> {
  let r = items;
  if (q.search && text) { const n = q.search.toLowerCase(); r = r.filter((t) => text(t).toLowerCase().includes(n)); }
  if (q.sort && sortKey) {
    const dir = q.order === "desc" ? -1 : 1;
    r = [...r].sort((a, b) => { const x = sortKey(a, q.sort!), y = sortKey(b, q.sort!); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  }
  return { items: r.slice((q.page - 1) * q.limit, q.page * q.limit), total: r.length };
}

/** In-memory HodStore applying the same department / ownership filters as the Mongo store. */
export class HodMemoryStore implements HodStore {
  departments = new Map<string, DeptRec>();
  hods: HodRec[] = [];
  terms = new Map<string, TermRec>();
  students: StudentX[] = [];
  enrollments: EnrollmentX[] = [];
  lecturers: LecturerX[] = [];
  lecturerAssigns: (LecturerAssignmentRec & { courseTitle?: string; revokedBy?: string })[] = [];
  courses: CourseRec[] = [];
  repAssigns: (RepAssignmentView)[] = [];
  timetable: TimetableRec[] = [];
  announcements: HodAnnouncementRec[] = [];
  documents: DocumentRec[] = [];
  materials: MaterialX[] = [];
  sessions: SessionView[] = [];
  records: AttendanceRecordView[] = [];
  flagged = new Map<string, number>();
  complaints: ComplaintX[] = [];
  notifications: (NotificationView & { recipientId: string })[] = [];
  audit: HodAuditRec[] = [];
  otherActivity: (ActivityItem & D)[] = [];
  invitations = new Map<string, { hash: string; expires: Date }>();

  async getHod(id: string) { return this.hods.find((h) => h.id === id) ?? null; }
  async updateHodProfile(id: string, patch: { phone?: string | null; profilePhoto?: string | null; profilePhotoPublicId?: string | null }) {
    const h = this.hods.find((x) => x.id === id);
    if (!h) return null;
    if (patch.phone !== undefined) h.phone = patch.phone ?? undefined; // only these fields exist as parameters
    if (patch.profilePhoto !== undefined) h.profilePhoto = patch.profilePhoto ?? undefined;
    if (patch.profilePhotoPublicId !== undefined) h.profilePhotoPublicId = patch.profilePhotoPublicId ?? undefined;
    return h;
  }
  async getDepartment(id: string) { return this.departments.get(id) ?? null; }
  async updateDepartment(id: string, patch: { name?: string; faculty?: string; contact?: { email?: string; phone?: string; office?: string }; levels?: string[] }) {
    const d = this.departments.get(id);
    if (!d) return null;
    if (patch.name && [...this.departments.values()].some((x) => x.id !== id && x.name === patch.name)) throw new StoreDuplicateError("name");
    if (patch.name) d.name = patch.name;
    if (patch.faculty) d.faculty = patch.faculty;
    if (patch.contact) d.contact = { ...d.contact, ...patch.contact };
    if (patch.levels) d.levels = patch.levels;
    return d;
  }
  async levelUsage(id: string) {
    const d = this.departments.get(id)!;
    return d.levels.map((level) => ({ level, students: this.students.filter((s) => s.departmentId === id && s.level === level).length, courses: this.courses.filter((c) => c.departmentId === id && c.level === level).length }));
  }
  async getCurrentTerm(id: string) { return this.terms.get(id) ?? null; }
  async setCurrentTerm(id: string, t: { academicSession: string; semester: "FIRST" | "SECOND" }) {
    const prev = this.terms.get(id);
    const next: TermRec = { registrationOpen: true, maxUnits: 24, ...prev, ...t };
    this.terms.set(id, next);
    return next;
  }
  async updateRegistration(id: string, patch: { registrationOpen?: boolean; registrationOpensAt?: Date | null; registrationClosesAt?: Date | null; maxUnits?: number }) {
    const t = this.terms.get(id);
    if (!t) return null;
    if (patch.registrationOpen !== undefined) t.registrationOpen = patch.registrationOpen;
    if (patch.registrationOpensAt !== undefined) t.registrationOpensAt = patch.registrationOpensAt ?? undefined;
    if (patch.registrationClosesAt !== undefined) t.registrationClosesAt = patch.registrationClosesAt ?? undefined;
    if (patch.maxUnits !== undefined) t.maxUnits = patch.maxUnits;
    return t;
  }

  private strip(s: StudentX): StudentRow { const { departmentId: _d, ...rest } = s; return rest; }
  async listStudents(dept: string, q: Parameters<HodStore["listStudents"]>[1]) {
    const rows = this.students.filter((s) => s.departmentId === dept && (!q.level || s.level === q.level) && (!q.academicSession || s.academicSession === q.academicSession) && (!q.status || s.status === q.status));
    const p = pageOf(rows, q, (s) => `${s.firstName} ${s.lastName} ${s.matricNumber}`, (s, k) => (s as unknown as Record<string, string>)[k] ?? "");
    return { items: p.items.map((s) => this.strip(s)), total: p.total };
  }
  async getStudent(dept: string, id: string) { const s = this.students.find((x) => x.id === id && x.departmentId === dept); return s ? this.strip(s) : null; }
  async setStudentStatus(dept: string, id: string, status: "ACTIVE" | "SUSPENDED") { const s = this.students.find((x) => x.id === id && x.departmentId === dept); if (!s) return null; s.status = status; return this.strip(s); }
  async updateStudentAcademic(dept: string, ids: string[], patch: { level?: string; academicSession?: string }) {
    const rows = this.students.filter((s) => s.departmentId === dept && ids.includes(s.id));
    rows.forEach((s) => Object.assign(s, patch));
    return rows.length;
  }
  async countStudentsInDepartment(dept: string, ids: string[]) { return this.students.filter((s) => s.departmentId === dept && ids.includes(s.id)).length; }
  async studentEnrollments(dept: string, studentId: string): Promise<EnrollmentView[]> {
    return this.enrollments.filter((e) => e.departmentId === dept && e.studentId === studentId).map((e) => {
      const c = this.courses.find((x) => x.departmentId === dept && x.courseCode === e.courseCode && x.academicSession === e.academicSession && x.semester === e.semester);
      return { id: `${e.studentId}-${e.courseCode}`, courseId: c?.id, courseCode: e.courseCode, title: c?.title ?? e.courseCode, units: c?.units ?? 0, level: c?.level ?? "", semester: e.semester, academicSession: e.academicSession, enrollmentType: e.enrollmentType, status: e.status };
    });
  }
  async studentAttendance(dept: string, studentId: string, term: { academicSession: string; semester: string }): Promise<StudentAttendanceRow[]> {
    const codes = this.enrollments.filter((e) => e.departmentId === dept && e.studentId === studentId && e.academicSession === term.academicSession && e.semester === term.semester && e.status === "ENROLLED").map((e) => e.courseCode);
    return codes.map((courseCode) => {
      const held = this.sessions.filter((s) => s.departmentId === dept && s.courseCode === courseCode && s.academicSession === term.academicSession && s.semester === term.semester);
      const mine = this.records.filter((r) => r.studentId === studentId && held.some((s) => s.id === r.sessionId));
      return { courseCode, sessionsHeld: held.length, attended: mine.length, late: mine.filter((r) => r.status === "LATE").length };
    });
  }

  async listLecturers(dept: string, q: Parameters<HodStore["listLecturers"]>[1]) {
    const p = pageOf(this.lecturers.filter((l) => l.departmentId === dept && (!q.status || l.status === q.status)), q, (l) => `${l.firstName} ${l.lastName} ${l.email} ${l.staffId}`, (l, k) => (l as unknown as Record<string, string>)[k] ?? "");
    return { items: p.items.map(({ departmentId: _d, ...r }) => r), total: p.total };
  }
  async getLecturer(dept: string, id: string) { const l = this.lecturers.find((x) => x.id === id && x.departmentId === dept); if (!l) return null; const { departmentId: _d, ...r } = l; return r; }
  async createLecturer(rec: { departmentId: string; firstName: string; lastName: string; email: string; phone?: string; staffId: string; activationTokenHash: string; activationExpires: Date }) {
    if (this.lecturers.some((l) => l.email === rec.email || (l.departmentId === rec.departmentId && l.staffId === rec.staffId.toUpperCase()))) throw new StoreDuplicateError("lecturer");
    const l: LecturerX = { id: randomUUID(), departmentId: rec.departmentId, firstName: rec.firstName, lastName: rec.lastName, email: rec.email, phone: rec.phone, staffId: rec.staffId.toUpperCase(), status: "INVITED" };
    this.lecturers.push(l);
    this.invitations.set(l.id, { hash: rec.activationTokenHash, expires: rec.activationExpires });
    const { departmentId: _d, ...r } = l;
    return r;
  }
  async updateLecturer(dept: string, id: string, patch: { firstName?: string; lastName?: string; phone?: string | null }) {
    const l = this.lecturers.find((x) => x.id === id && x.departmentId === dept);
    if (!l) return null;
    if (patch.firstName) l.firstName = patch.firstName;
    if (patch.lastName) l.lastName = patch.lastName;
    if (patch.phone !== undefined) l.phone = patch.phone ?? undefined;
    const { departmentId: _d, ...r } = l;
    return r;
  }
  async setLecturerStatus(dept: string, id: string, status: "ACTIVE" | "SUSPENDED") { const l = this.lecturers.find((x) => x.id === id && x.departmentId === dept); if (!l) return null; l.status = status; const { departmentId: _d, ...r } = l; return r; }
  async reissueLecturerInvitation(dept: string, id: string, hash: string, expires: Date) { const l = this.lecturers.find((x) => x.id === id && x.departmentId === dept && x.status === "INVITED"); if (!l) return false; this.invitations.set(id, { hash, expires }); return true; }
  async lecturerAssignments(dept: string, id: string): Promise<LecturerAssignmentView[]> { return this.lecturerAssigns.filter((a) => a.departmentId === dept && a.lecturerId === id).map((a) => ({ ...a, courseTitle: this.courses.find((c) => c.id === a.courseId)?.title })); }
  async createLecturerAssignment(rec: Omit<LecturerAssignmentRec, "id">) {
    if (this.lecturerAssigns.some((a) => a.lecturerId === rec.lecturerId && a.courseId === rec.courseId && a.status === "ACTIVE")) throw new StoreDuplicateError("assignment");
    const a = { ...rec, id: randomUUID() };
    this.lecturerAssigns.push(a);
    return a;
  }
  async hasActiveLecturerAssignment(dept: string, lecturerId: string, courseId: string) { return this.lecturerAssigns.some((a) => a.departmentId === dept && a.lecturerId === lecturerId && a.courseId === courseId && a.status === "ACTIVE"); }
  async revokeLecturerAssignment(dept: string, lecturerId: string, courseId: string, by: { name: string; role: string }) {
    const a = this.lecturerAssigns.find((x) => x.departmentId === dept && x.lecturerId === lecturerId && x.courseId === courseId && x.status === "ACTIVE");
    if (!a) return null;
    a.status = "REVOKED"; a.revokedBy = by.name;
    return a;
  }

  private enrolledCount(c: CourseRec) { return this.enrollments.filter((e) => e.departmentId === c.departmentId && e.courseCode === c.courseCode && e.academicSession === c.academicSession && e.semester === c.semester && e.status === "ENROLLED").length; }
  async listCourses(dept: string, q: Parameters<HodStore["listCourses"]>[1]) {
    const rows = this.courses.filter((c) => c.departmentId === dept && (!q.level || c.level === q.level) && (!q.semester || c.semester === q.semester) && (!q.academicSession || c.academicSession === q.academicSession) && (!q.status || c.status === q.status));
    const p = pageOf(rows, q, (c) => `${c.courseCode} ${c.title}`, (c, k) => (c as unknown as Record<string, string>)[k] ?? "");
    const names = groupCourseLecturers(this.lecturerAssigns.filter((a) => a.status === "ACTIVE" && a.departmentId === dept).map((a) => ({ courseId: a.courseId, lecturerId: a.lecturerId })), this.lecturers.map((l) => ({ id: l.id, firstName: l.firstName, lastName: l.lastName, status: l.status })));
    return { items: p.items.map((c): CourseView => ({ ...c, enrolledCount: this.enrolledCount(c), lecturers: names.get(c.id) ?? [] })), total: p.total };
  }
  async getCourse(dept: string, id: string) { return this.courses.find((c) => c.id === id && c.departmentId === dept) ?? null; }
  async createCourse(rec: Omit<CourseRec, "id">) {
    if (this.courses.some((c) => c.departmentId === rec.departmentId && c.courseCode === rec.courseCode && c.academicSession === rec.academicSession && c.semester === rec.semester)) throw new StoreDuplicateError("course");
    const c = { ...rec, id: randomUUID() };
    this.courses.push(c);
    return c;
  }
  async updateCourse(dept: string, id: string, patch: Partial<CourseRec>) {
    const c = this.courses.find((x) => x.id === id && x.departmentId === dept);
    if (!c) return null;
    const next = { ...c, ...patch };
    if (this.courses.some((x) => x.id !== id && x.departmentId === dept && x.courseCode === next.courseCode && x.academicSession === next.academicSession && x.semester === next.semester)) throw new StoreDuplicateError("course");
    Object.assign(c, patch);
    return c;
  }
  async countEnrollments(c: CourseRec) { return this.enrolledCount(c); }
  async courseLecturers(c: CourseRec) { return this.lecturerAssigns.filter((a) => a.courseId === c.id && a.status === "ACTIVE").map((a) => ({ lecturerId: a.lecturerId, name: this.lecturers.find((l) => l.id === a.lecturerId)?.lastName ?? "" })); }
  async courseRepresentatives(c: CourseRec) { return this.repAssigns.filter((r) => r.departmentId === c.departmentId && r.status !== "REVOKED" && ((r.scope === "LEVEL" && r.level === c.level && r.academicSession === c.academicSession && r.semester === c.semester) || r.courseId === c.id)); }

  async listRepAssignments(dept: string, q: Parameters<HodStore["listRepAssignments"]>[1]) {
    const rows = this.repAssigns.filter((r) => r.departmentId === dept && (!q.courseId || r.courseId === q.courseId) && (!q.level || r.level === q.level) && (!q.academicSession || r.academicSession === q.academicSession) && (!q.semester || r.semester === q.semester) && (!q.role || r.role === q.role) && (!q.status || r.status === q.status));
    return pageOf(rows, q, (r) => `${r.student.firstName} ${r.student.lastName} ${r.student.matricNumber} ${r.courseCode}`, (r, k) => (r as unknown as Record<string, string>)[k] ?? "");
  }
  async getRepAssignment(dept: string, id: string) { return this.repAssigns.find((r) => r.id === id && r.departmentId === dept) ?? null; }
  async activeRepsOnCourse(dept: string, courseId: string) { return this.repAssigns.filter((r) => r.departmentId === dept && r.courseId === courseId && r.status === "ACTIVE").map((r) => ({ studentId: r.studentId, role: r.role })); }
  async activeRepsOnLevel(dept: string, level: string, academicSession: string, semester: "FIRST" | "SECOND") { return this.repAssigns.filter((r) => r.departmentId === dept && r.scope === "LEVEL" && r.level === level && r.academicSession === academicSession && r.semester === semester && r.status === "ACTIVE").map((r) => ({ studentId: r.studentId, role: r.role })); }
  async isEnrolled(dept: string, studentId: string, c: CourseRec) { return this.enrollments.some((e) => e.departmentId === dept && e.studentId === studentId && e.courseCode === c.courseCode && e.academicSession === c.academicSession && e.semester === c.semester && e.status === "ENROLLED"); }
  async createRepAssignment(rec: Omit<RepAssignmentView, "id" | "student" | "courseTitle">) {
    const sameClass = (r: RepAssignmentView) => (rec.scope === "LEVEL" ? r.scope === "LEVEL" && r.level === rec.level && r.academicSession === rec.academicSession && r.semester === rec.semester && r.departmentId === rec.departmentId : r.courseId === rec.courseId);
    if (this.repAssigns.some((r) => sameClass(r) && r.status === "ACTIVE" && ((r.studentId === rec.studentId) || (rec.role === "COURSE_REP" && r.role === "COURSE_REP")))) throw new StoreDuplicateError("rep");
    const s = this.students.find((x) => x.id === rec.studentId)!;
    const a: RepAssignmentView = { ...rec, id: randomUUID(), student: { firstName: s.firstName, lastName: s.lastName, matricNumber: s.matricNumber } };
    this.repAssigns.push(a);
    return a;
  }
  async setRepAssignmentStatus(dept: string, id: string, status: "ACTIVE" | "INACTIVE") { const r = this.repAssigns.find((x) => x.id === id && x.departmentId === dept); if (!r) return null; r.status = status; return r; }
  async revokeRepAssignment(dept: string, id: string, _by: { name: string; role: string }) { const r = this.repAssigns.find((x) => x.id === id && x.departmentId === dept); if (!r) return null; r.status = "REVOKED"; return r; }

  private tt(dept: string, term: { academicSession: string; semester: string }) { return this.timetable.filter((t) => t.departmentId === dept && t.academicSession === term.academicSession && t.semester === term.semester); }
  async listTimetable(dept: string, term: { academicSession: string; semester: string }, q: Parameters<HodStore["listTimetable"]>[2]) {
    const c = q.courseId ? this.courses.find((x) => x.id === q.courseId && x.departmentId === dept) : undefined;
    const rows = this.tt(dept, term).filter((t) => (!q.courseId || (c && t.courseCode === c.courseCode)) && (!q.level || t.level === q.level) && (!q.day || t.dayOfWeek === q.day) && (!q.source || t.source === q.source));
    return pageOf(rows, q, (t) => `${t.courseCode} ${t.title}`);
  }
  async allTimetable(dept: string, term: { academicSession: string; semester: string }) { return this.tt(dept, term); }

  async listAnnouncements(dept: string, hodId: string, q: Parameters<HodStore["listAnnouncements"]>[2]) {
    const rows = this.announcements.filter((a) => a.departmentId === dept && a.status !== "DELETED" && (a.status === "PUBLISHED" || a.hodId === hodId) && (!q.status || a.status === q.status) && (!q.scope || a.scope === q.scope) && (!q.mine || a.hodId === hodId));
    return pageOf(rows, q, (a) => a.title);
  }
  async getAnnouncement(dept: string, id: string) { return this.announcements.find((a) => a.id === id && a.departmentId === dept) ?? null; }
  async createAnnouncement(rec: Omit<HodAnnouncementRec, "id" | "createdAt" | "updatedAt">) { const a = { ...rec, id: randomUUID(), createdAt: new Date(), updatedAt: new Date() }; this.announcements.push(a); return a; }
  async updateAnnouncement(id: string, patch: Partial<HodAnnouncementRec> & { image?: HodAnnouncementRec["image"] | null }) { const a = this.announcements.find((x) => x.id === id && x.hodId); if (!a) return null; const { image, ...rest } = patch; Object.assign(a, rest, { updatedAt: new Date() }); if (image === null) delete a.image; else if (image) a.image = image; return a; } // HOD-written only

  async listDocuments(dept: string, q: ListQuery & { status?: string }) { return pageOf(this.documents.filter((d) => d.departmentId === dept && (!q.status || d.status === q.status)), q, (d) => d.title); }
  async getDocument(dept: string, id: string) { return this.documents.find((d) => d.id === id && d.departmentId === dept) ?? null; }
  async createDocument(rec: Omit<DocumentRec, "id" | "createdAt" | "updatedAt">) { const d = { ...rec, id: randomUUID(), createdAt: new Date(), updatedAt: new Date() }; this.documents.push(d); return d; }
  async updateDocument(dept: string, id: string, patch: Partial<DocumentRec>) { const d = this.documents.find((x) => x.id === id && x.departmentId === dept); if (!d) return null; Object.assign(d, patch, { updatedAt: new Date() }); return d; }
  async deleteDocument(dept: string, id: string) { this.documents = this.documents.filter((d) => !(d.id === id && d.departmentId === dept)); }
  async listMaterialsOverview(dept: string, q: ListQuery & { type?: string; courseCode?: string }) {
    const p = pageOf(this.materials.filter((m) => m.departmentId === dept && (!q.type || m.type === q.type) && (!q.courseCode || m.courseCode === q.courseCode)), q, (m) => m.title);
    return { items: p.items.map(({ departmentId: _d, ...r }) => r), total: p.total };
  }

  private state(s: SessionView, now: Date) { return s.status === "CLOSED" || s.status === "CANCELLED" || now > s.closesAt ? "CLOSED" : now < s.opensAt ? "UPCOMING" : "OPEN"; }
  async listSessions(dept: string, term: { academicSession: string; semester: string } | null, q: Parameters<HodStore["listSessions"]>[2], now: Date) {
    const c = q.courseId ? this.courses.find((x) => x.id === q.courseId && x.departmentId === dept) : undefined;
    const rows = this.sessions.filter((s) => s.departmentId === dept && (!term || (s.academicSession === term.academicSession && s.semester === term.semester)) && (!q.courseId || (c && s.courseCode === c.courseCode)) && (!q.lecturerId || s.lecturerId === q.lecturerId) && (!q.state || this.state(s, now) === q.state) && (!q.from || s.opensAt >= q.from) && (!q.to || s.opensAt <= q.to));
    return pageOf(rows.sort((a, b) => b.opensAt.getTime() - a.opensAt.getTime()), q, (s) => `${s.courseCode} ${s.title}`);
  }
  async getSession(dept: string, id: string) { return this.sessions.find((s) => s.id === id && s.departmentId === dept) ?? null; }
  async sessionRecordCounts(ids: string[]) { const m = new Map<string, { present: number; late: number }>(); for (const id of ids) { const r = this.records.filter((x) => x.sessionId === id); m.set(id, { present: r.filter((x) => x.status === "PRESENT").length, late: r.filter((x) => x.status === "LATE").length }); } return m; }
  async recordsForSession(id: string) { return this.records.filter((r) => r.sessionId === id); }
  async flaggedAttempts(id: string) { return this.flagged.get(id) ?? 0; }
  async enrolledCountsByCourse(dept: string, term: { academicSession: string; semester: string }) {
    const m = new Map<string, number>();
    for (const e of this.enrollments.filter((x) => x.departmentId === dept && x.academicSession === term.academicSession && x.semester === term.semester && x.status === "ENROLLED")) m.set(e.courseCode, (m.get(e.courseCode) ?? 0) + 1);
    return m;
  }
  async courseAttendanceStats(dept: string, term: { academicSession: string; semester: string }, now: Date): Promise<CourseAttendanceStat[]> {
    const enrolled = await this.enrolledCountsByCourse(dept, term);
    const out: CourseAttendanceStat[] = [];
    for (const c of this.courses.filter((x) => x.departmentId === dept && x.academicSession === term.academicSession && x.semester === term.semester)) {
      const held = this.sessions.filter((s) => s.departmentId === dept && s.courseCode === c.courseCode && s.academicSession === term.academicSession && s.semester === term.semester && s.opensAt <= now && s.status !== "CANCELLED");
      if (!held.length) continue;
      out.push({ courseId: c.id, courseCode: c.courseCode, title: c.title, sessionsHeld: held.length, enrolled: enrolled.get(c.courseCode) ?? 0, attendanceRecords: this.records.filter((r) => held.some((s) => s.id === r.sessionId)).length });
    }
    return out;
  }

  async listComplaints(dept: string, q: Parameters<HodStore["listComplaints"]>[1]) {
    const rows = this.complaints.filter((c) => c.departmentId === dept && (!q.status || c.status === q.status) && (!q.type || c.type === q.type) && (!q.courseId || c.courseId === q.courseId) && (!q.assignedLecturerId || c.assignedLecturer?.id === q.assignedLecturerId) && (!q.from || c.createdAt >= q.from) && (!q.to || c.createdAt <= q.to));
    return pageOf(rows, q, (c) => `${c.referenceNumber} ${c.title} ${c.studentName} ${c.matricNumber}`, (c, k) => (k === "createdAt" ? c.createdAt.getTime() : (c as unknown as Record<string, string>)[k] ?? ""));
  }
  async getComplaint(dept: string, id: string) { return this.complaints.find((c) => c.id === id && c.departmentId === dept) ?? null; }
  async updateComplaint(dept: string, id: string, patch: ComplaintPatch, event: ComplaintEvent) {
    const c = this.complaints.find((x) => x.id === id && x.departmentId === dept);
    if (!c) return null;
    if (patch.status) c.status = patch.status;
    if (patch.assignedLecturerId) { const l = this.lecturers.find((x) => x.id === patch.assignedLecturerId); c.assignedLecturer = { id: patch.assignedLecturerId, name: l ? `${l.firstName} ${l.lastName}` : "" }; c.assignedAt = patch.assignedAt; }
    if (patch.resolution !== undefined) { c.resolution = patch.resolution; c.resolvedAt = patch.resolvedAt; }
    c.timeline.push(event); c.updatedAt = new Date();
    return c;
  }
  async addComplaintEvent(dept: string, id: string, event: ComplaintEvent) { const c = this.complaints.find((x) => x.id === id && x.departmentId === dept); if (!c) return null; c.timeline.push(event); c.updatedAt = new Date(); return c; }

  async listNotifications(id: string, q: { page: number; limit: number; unread?: boolean }) {
    const mine = this.notifications.filter((n) => n.recipientId === id);
    const rows = mine.filter((n) => !q.unread || !n.read);
    return { items: rows.slice((q.page - 1) * q.limit, q.page * q.limit), total: rows.length, unread: mine.filter((n) => !n.read).length };
  }
  async markNotificationRead(id: string, nid: string) { const n = this.notifications.find((x) => x.id === nid && x.recipientId === id); if (!n) return null; n.read = true; return n; }
  async markAllNotificationsRead(id: string) { const r = this.notifications.filter((n) => n.recipientId === id && !n.read); r.forEach((n) => (n.read = true)); return r.length; }

  async dashboardCounts(dept: string, term: { academicSession: string; semester: string } | null, now: Date): Promise<DashboardCounts> {
    const st = this.students.filter((s) => s.departmentId === dept);
    const lec = this.lecturers.filter((l) => l.departmentId === dept);
    const reps = term ? this.repAssigns.filter((r) => r.departmentId === dept && r.status === "ACTIVE" && r.academicSession === term.academicSession && r.semester === term.semester) : [];
    const cp = this.complaints.filter((c) => c.departmentId === dept);
    return {
      students: { total: st.length, active: st.filter((s) => s.status === "ACTIVE").length, pendingOnboarding: st.filter((s) => s.status === "PENDING_ONBOARDING").length, suspended: st.filter((s) => s.status === "SUSPENDED").length },
      lecturers: { total: lec.length, active: lec.filter((l) => l.status === "ACTIVE").length },
      representatives: { courseReps: reps.filter((r) => r.role === "COURSE_REP").length, assistantCourseReps: reps.filter((r) => r.role === "ASSISTANT_COURSE_REP").length },
      activeCourses: term ? this.courses.filter((c) => c.departmentId === dept && c.status === "ACTIVE" && c.academicSession === term.academicSession && c.semester === term.semester).length : 0,
      activeAnnouncements: this.announcements.filter((a) => a.departmentId === dept && a.status === "PUBLISHED" && (!a.expiresAt || a.expiresAt > now)).length,
      openAttendanceSessions: this.sessions.filter((s) => s.departmentId === dept && this.state(s, now) === "OPEN").length,
      complaints: { pending: cp.filter((c) => c.status === "SUBMITTED" || c.status === "PENDING").length, underReview: cp.filter((c) => c.status === "UNDER_REVIEW").length },
    };
  }
  async recentActivity(dept: string, limit: number): Promise<ActivityItem[]> {
    const mine: ActivityItem[] = this.audit.filter((a) => a.departmentId === dept).map((a) => ({ source: "HOD", action: a.action, actorName: a.actorName, role: a.role, resourceType: a.resourceType, at: a.at }));
    const others = this.otherActivity.filter((a) => a.departmentId === dept).map(({ departmentId: _d, ...r }) => r);
    return [...mine, ...others].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
  }
  async addAudit(rec: HodAuditRec) { this.audit.push(rec); }
}
