import { randomUUID } from "node:crypto";
import type { RepresentativeStore } from "../../src/services/representative/store";
import type { AnnouncementRec, AssignmentRec, AuditRec, CourseRec, MemberRec, ResourceRec, TimetableRec } from "../../src/services/representative/types";

export interface StudentRow { id: string; departmentId: string; firstName: string; lastName: string; matricNumber: string; email: string; phone: string; level: string; profilePhoto?: string }
export interface EnrollmentRow { studentId: string; departmentId: string; courseCode: string; academicSession: string; semester: "FIRST" | "SECOND"; type: "REGULAR" | "CARRYOVER" }

/** In-memory RepresentativeStore with the same department / ownership filtering the Mongo store applies. */
export class RepMemoryStore implements RepresentativeStore {
  terms = new Map<string, { academicSession: string; semester: "FIRST" | "SECOND" }>();
  assignments: AssignmentRec[] = [];
  courses: CourseRec[] = [];
  students: StudentRow[] = [];
  enrollments: EnrollmentRow[] = [];
  timetable: TimetableRec[] = [];
  announcements: AnnouncementRec[] = [];
  resources: ResourceRec[] = [];
  audit: AuditRec[] = [];

  async getCurrentTerm(departmentId: string) { return this.terms.get(departmentId) ?? null; }
  async assignmentsForStudent(studentId: string) { return this.assignments.filter((a) => a.studentId === studentId); }
  /** Lecturers assigned to each course (id -> names): the source of "the lecturer of this course". */
  courseLecturers = new Map<string, string[]>();
  async listCoursesForLevel(departmentId: string, level: string, academicSession: string, semester: "FIRST" | "SECOND") {
    return this.courses.filter((c) => c.departmentId === departmentId && c.level === level && c.academicSession === academicSession && c.semester === semester && c.status === "ACTIVE");
  }
  async countLevelStudents(departmentId: string, level: string) { return this.students.filter((s) => s.departmentId === departmentId && s.level === level).length; }
  async getCourse(id: string, departmentId: string) { return this.courses.find((c) => c.id === id && c.departmentId === departmentId) ?? null; }

  private enrolled(course: CourseRec) {
    return this.enrollments.filter((e) => e.departmentId === course.departmentId && e.courseCode === course.courseCode && e.academicSession === course.academicSession && e.semester === course.semester);
  }
  async listMembers(course: CourseRec, q: { page: number; limit: number; search?: string }) {
    const rows: MemberRec[] = this.enrolled(course)
      .map((e) => ({ e, s: this.students.find((s) => s.id === e.studentId && s.departmentId === course.departmentId) }))
      .filter((x): x is { e: EnrollmentRow; s: StudentRow } => Boolean(x.s))
      .map(({ e, s }) => ({ studentId: s.id, firstName: s.firstName, lastName: s.lastName, matricNumber: s.matricNumber, profilePhoto: s.profilePhoto, level: s.level, enrollmentType: e.type }));
    const needle = q.search?.toLowerCase();
    const filtered = needle ? rows.filter((m) => `${m.firstName} ${m.lastName} ${m.matricNumber}`.toLowerCase().includes(needle)) : rows;
    filtered.sort((a, b) => a.lastName.localeCompare(b.lastName));
    return { items: filtered.slice((q.page - 1) * q.limit, q.page * q.limit), total: filtered.length };
  }
  async countMembers(course: CourseRec) { return this.enrolled(course).length; }
  async lecturerNames(course: CourseRec) { return [...(this.courseLecturers.get(course.id) ?? [])]; }
  async listTimetable(courses: CourseRec[], view: "course" | "class") {
    return this.timetable.filter((t) => courses.some((c) => t.departmentId === c.departmentId && t.academicSession === c.academicSession && t.semester === c.semester && (view === "class" ? t.level === c.level : t.courseCode === c.courseCode)));
  }
  async createTimetableEntry(rec: Omit<TimetableRec, "id" | "createdAt" | "updatedAt">) {
    const r = { ...rec, id: randomUUID(), createdAt: new Date(), updatedAt: new Date() };
    this.timetable.push(r);
    return r;
  }
  async getTimetableEntry(id: string, departmentId: string) { return this.timetable.find((t) => t.id === id && t.departmentId === departmentId) ?? null; }
  async updateTimetableEntry(id: string, patch: Record<string, unknown>) {
    const t = this.timetable.find((x) => x.id === id && x.source === "CLASS_REP"); // same guard as the Mongo store
    if (!t) return null;
    for (const [k, v] of Object.entries(patch)) {
      if (k === "date" && v === null) delete t.date;
      else (t as unknown as Record<string, unknown>)[k] = v;
    }
    t.updatedAt = new Date();
    return t;
  }
  async deleteTimetableEntry(id: string) { this.timetable = this.timetable.filter((t) => !(t.id === id && t.source === "CLASS_REP")); }

  async createAnnouncement(rec: Omit<AnnouncementRec, "id" | "createdAt" | "updatedAt">) {
    const r = { ...rec, id: randomUUID(), createdAt: new Date(), updatedAt: new Date() };
    this.announcements.push(r);
    return r;
  }
  async getAnnouncement(id: string, departmentId: string) { return this.announcements.find((a) => a.id === id && a.departmentId === departmentId) ?? null; }
  async updateAnnouncement(id: string, patch: Partial<AnnouncementRec> & { image?: AnnouncementRec["image"] | null }) {
    const a = this.announcements.find((x) => x.id === id);
    if (!a) return null;
    const { image, ...rest } = patch;
    Object.assign(a, rest, { updatedAt: new Date() });
    if (image === null) delete a.image; else if (image) a.image = image;
    return a;
  }
  async listAnnouncements(departmentId: string, scope: { courseIds: string[]; classes: { level: string; academicSession: string; semester: string }[] }, viewer: string) {
    const inScope = (a: AnnouncementRec) => (a.courseId ? scope.courseIds.includes(a.courseId) : scope.classes.some((c) => c.level === a.level && c.academicSession === a.academicSession && c.semester === a.semester));
    return this.announcements.filter((a) => a.departmentId === departmentId && inScope(a) && a.status !== "DELETED" && (a.status === "PUBLISHED" || a.createdByStudentId === viewer));
  }

  async createResource(rec: Omit<ResourceRec, "id" | "createdAt" | "updatedAt">) {
    const r = { ...rec, id: randomUUID(), createdAt: new Date(), updatedAt: new Date() };
    this.resources.push(r);
    return r;
  }
  async getResource(id: string, departmentId: string) { return this.resources.find((r) => r.id === id && r.departmentId === departmentId) ?? null; }
  async updateResource(id: string, patch: Partial<ResourceRec>) {
    const r = this.resources.find((x) => x.id === id);
    if (!r) return null;
    Object.assign(r, patch, { updatedAt: new Date() });
    return r;
  }
  async deleteResource(id: string) { this.resources = this.resources.filter((r) => r.id !== id); }
  async listResources(courses: CourseRec[]) {
    return this.resources.filter((r) => r.status === "PUBLISHED" && courses.some((c) => c.id === r.courseId && c.departmentId === r.departmentId));
  }
  async addAudit(rec: AuditRec) { this.audit.push(rec); }
}
