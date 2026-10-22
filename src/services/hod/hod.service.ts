import { AppError } from "../../utils/AppError";
import { sniffImage } from "../../utils/image";
import { COURSE_CODE_REGEX, normalizeCourseCode } from "../../utils/course";
import { checkLevelAppointment } from "../representative/policy";
import { slotsOverlap } from "../representative/timetable-rules";
import { checkLecturerAssignmentRules } from "../lecturer/policy";
import {
  checkComplaintAssignee, checkComplaintTransition, checkCourseSession, checkCourseStructureChange, checkLevelChange, checkStudentStatusChange,
  checkTermTransition, hasAttendanceIssue, isClosedComplaint, type ComplaintStatusName,
} from "./policy";
import { StoreDuplicateError, type HodStore } from "./store";
import type {
  ComplaintPatch, ComplaintRec, CourseRec, HodActor, HodAnnouncementRec, HodMeta, ListQuery, Page, StoredFile, TimetableRec,
} from "./types";

export interface NotifyPayload { kind: string; title: string; body: string; link?: string }
export interface HodDeps {
  store: HodStore;
  now: () => Date;
  generateToken: () => string;
  hashToken: (raw: string) => string;
  /** Sends the invitation email. A failure never rolls back account creation; the HOD can reissue the invitation. */
  sendInvite: (to: string, firstName: string, rawToken: string, hours: number) => Promise<void>;
  uploadFile: (f: { buffer: Buffer; originalName: string }) => Promise<StoredFile>;
  deleteFile: (f: StoredFile) => Promise<void>;
  /** Stores / removes an announcement picture (the service has already verified the bytes are a real image). */
  uploadAnnouncementImage: (buffer: Buffer) => Promise<{ url: string; publicId: string }>;
  deleteAnnouncementImage: (publicId: string) => Promise<void>;
  uploadAvatar: (buffer: Buffer, hodId: string) => Promise<{ url: string; publicId: string }>;
  deleteAvatar: (publicId: string) => Promise<void>;
  signPrivateFile: (f: { publicId: string; resourceType: "image" | "raw" }) => string;
  /** Notifications reuse the ONE notification system (recipientType STUDENT / LECTURER). Best-effort. */
  notifyStudent: (studentId: string, departmentId: string, n: NotifyPayload) => Promise<void>;
  notifyLecturer: (lecturerId: string, departmentId: string, n: NotifyPayload) => Promise<void>;
  notifyDepartmentStudents: (departmentId: string, levels: string[], n: NotifyPayload) => Promise<void>;
}

export const INVITE_HOURS = 72;
const fullName = (a: { firstName: string; lastName?: string }) => `${a.firstName} ${a.lastName ?? ""}`.trim();
/** Copies ONLY the listed keys that are present. Applied before every store update so extra / smuggled keys can never reach storage (HTTP schemas are strict too: defence in depth). */
function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const meta = (q: { page: number; limit: number }, total: number) => ({ page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) });
const paged = <T, U>(q: ListQuery, p: Page<T>, map: (t: T) => U) => ({ items: p.items.map(map), ...meta(q, p.total) });

/**
 * Department-admin engine. The department is ALWAYS actor.departmentId (from the authenticated HOD's own record); no method takes a
 * department id from the request, and every store lookup filters by it, so a resource of another department answers exactly like a missing one (404).
 * HOD has no way to change its own role / department / staffId, to touch attendance records, or to edit a Course Rep's class timetable.
 */
export class HodService {
  constructor(private readonly d: HodDeps) {}

  /* ------------------------------ audit / scope ------------------------------ */
  private async audit(actor: HodActor, m: HodMeta, action: string, x: { resourceType?: string; resourceId?: string; detail?: Record<string, unknown> } = {}) {
    try {
      await this.d.store.addAudit({ actorId: actor.hodId, actorName: fullName(actor), role: "HOD", action, resourceType: x.resourceType, resourceId: x.resourceId, departmentId: actor.departmentId, ip: m.ip, detail: x.detail, at: this.d.now() });
    } catch { /* an audit failure must not turn a correct decision into a 500 */ }
  }
  private async notFound(actor: HodActor, m: HodMeta, what: string, type: string, id: string): Promise<never> {
    await this.audit(actor, m, "ACCESS_DENIED", { resourceType: type, resourceId: id, detail: { reason: "OUT_OF_SCOPE" } });
    throw new AppError(404, `${what} not found.`, undefined, "NOT_FOUND");
  }
  /** Used by requireDepartmentScope: a department id in the request that isn't the HOD's own is an attack or a bug; refuse and audit it. */
  async assertScope(actor: HodActor, requestedDepartmentId: string | undefined, m: HodMeta = {}): Promise<void> {
    if (requestedDepartmentId !== undefined && String(requestedDepartmentId) !== actor.departmentId) {
      await this.audit(actor, m, "SCOPE_VIOLATION", { resourceType: "DEPARTMENT", detail: { attempted: String(requestedDepartmentId).slice(0, 40) } });
      throw new AppError(403, "You can only manage your own department.", undefined, "DEPARTMENT_SCOPE_VIOLATION");
    }
  }

  /* ------------------------------ profile ------------------------------ */
  private async profileDTO(h: NonNullable<Awaited<ReturnType<HodStore["getHod"]>>>) {
    const dept = await this.d.store.getDepartment(h.departmentId);
    return {
      id: h.id, firstName: h.firstName, lastName: h.lastName, name: fullName(h), email: h.email, phone: h.phone ?? null, staffId: h.staffId, role: h.role, status: h.status,
      profilePhoto: h.profilePhoto ?? null, department: dept ? { id: dept.id, name: dept.name, code: dept.code, faculty: dept.faculty } : null,
    };
  }
  async getProfile(actor: HodActor) {
    const h = await this.d.store.getHod(actor.hodId);
    if (!h) throw new AppError(401, "Authentication required.");
    return this.profileDTO(h);
  }
  /** Only the phone is editable. Role, department, staffId and email are unreachable (not parameters of the store call). */
  async updateProfile(actor: HodActor, patch: { phone?: string | null }, m: HodMeta = {}) {
    const h = await this.d.store.updateHodProfile(actor.hodId, { phone: patch.phone });
    if (!h) throw new AppError(401, "Authentication required.");
    await this.audit(actor, m, "PROFILE_UPDATED", { resourceType: "HOD", resourceId: actor.hodId, detail: { fields: Object.keys(patch) } });
    return this.profileDTO(h);
  }
  async setProfilePhoto(actor: HodActor, buffer: Buffer, m: HodMeta = {}) {
    const cur = await this.d.store.getHod(actor.hodId);
    if (!cur) throw new AppError(401, "Authentication required.");
    const previous = cur.profilePhotoPublicId;
    const saved = await this.d.uploadAvatar(buffer, actor.hodId);
    const h = await this.d.store.updateHodProfile(actor.hodId, { profilePhoto: saved.url, profilePhotoPublicId: saved.publicId });
    if (previous && previous !== saved.publicId) await this.d.deleteAvatar(previous).catch(() => undefined);
    await this.audit(actor, m, "PROFILE_UPDATED", { resourceType: "HOD", resourceId: actor.hodId, detail: { fields: ["profilePhoto"] } });
    return this.profileDTO(h!);
  }

  /* ------------------------------ dashboard ------------------------------ */
  async dashboard(actor: HodActor) {
    const now = this.d.now();
    const term = await this.d.store.getCurrentTerm(actor.departmentId);
    const [dept, counts, activity, notes] = await Promise.all([
      this.d.store.getDepartment(actor.departmentId), this.d.store.dashboardCounts(actor.departmentId, term, now),
      this.d.store.recentActivity(actor.departmentId, 10), this.d.store.listNotifications(actor.hodId, { page: 1, limit: 1 }),
    ]);
    return {
      department: dept ? { id: dept.id, name: dept.name, code: dept.code, faculty: dept.faculty } : null,
      currentTerm: term ? { academicSession: term.academicSession, semester: term.semester, registrationOpen: term.registrationOpen } : null,
      statistics: {
        totalStudents: counts.students.total, activeStudents: counts.students.active, studentsPendingOnboarding: counts.students.pendingOnboarding, suspendedStudents: counts.students.suspended,
        totalLecturers: counts.lecturers.total, activeLecturers: counts.lecturers.active,
        courseRepresentatives: counts.representatives.courseReps, assistantCourseRepresentatives: counts.representatives.assistantCourseReps,
        activeCourses: counts.activeCourses, activeAnnouncements: counts.activeAnnouncements, activeAttendanceSessions: counts.openAttendanceSessions,
        pendingComplaints: counts.complaints.pending, complaintsUnderReview: counts.complaints.underReview,
      },
      recentActivity: activity.map((a) => ({ source: a.source, action: a.action, actor: a.actorName ?? null, role: a.role ?? null, resourceType: a.resourceType ?? null, courseCode: a.courseCode ?? null, at: a.at })),
      unreadNotifications: notes.unread,
    };
  }

  /* ------------------------------ department / levels / term ------------------------------ */
  async getDepartment(actor: HodActor) {
    const [dept, term] = await Promise.all([this.d.store.getDepartment(actor.departmentId), this.d.store.getCurrentTerm(actor.departmentId)]);
    if (!dept) throw new AppError(404, "Department not found.", undefined, "NOT_FOUND");
    return {
      id: dept.id, name: dept.name, code: dept.code, faculty: dept.faculty, isActive: dept.isActive, levels: dept.levels, contact: dept.contact ?? null,
      currentTerm: term ? { academicSession: term.academicSession, semester: term.semester } : null,
      registration: term ? { open: term.registrationOpen, opensAt: term.registrationOpensAt ?? null, closesAt: term.registrationClosesAt ?? null, maxUnits: term.maxUnits } : null,
      editable: ["name", "faculty", "contact", "levels"], // code, matric code, id and active flag are system-level
    };
  }
  /** Name, faculty, contact and levels only. The department id, code, matric code and active flag are not parameters, so they can't be changed from here. */
  async updateDepartmentSettings(actor: HodActor, patch: { name?: string; faculty?: string; contact?: { email?: string; phone?: string; office?: string }; levels?: string[] }, m: HodMeta = {}) {
    const dept = await this.d.store.getDepartment(actor.departmentId);
    if (!dept) throw new AppError(404, "Department not found.", undefined, "NOT_FOUND");
    let levels: string[] | undefined;
    if (patch.levels) {
      levels = [...new Set(patch.levels)].sort();
      const problem = checkLevelChange(dept.levels, levels, await this.d.store.levelUsage(actor.departmentId));
      if (problem) throw new AppError(409, problem, undefined, "LEVEL_CHANGE_REFUSED");
    }
    try {
      await this.d.store.updateDepartment(actor.departmentId, { name: patch.name, faculty: patch.faculty, contact: patch.contact, levels });
    } catch (e) {
      if (e instanceof StoreDuplicateError) throw new AppError(409, "Another department already uses that name.", undefined, "DEPARTMENT_NAME_TAKEN");
      throw e;
    }
    await this.audit(actor, m, "DEPARTMENT_SETTINGS_CHANGED", { resourceType: "DEPARTMENT", resourceId: actor.departmentId, detail: { fields: Object.keys(patch), ...(levels ? { levels } : {}) } });
    return this.getDepartment(actor);
  }
  /** Moves the department's CURRENT term (forward only, one step, explicit confirmation). Representative and lecturer assignments belong to a term, so they stop applying until renewed: that is why it needs confirmation and is audited. */
  async setAcademicTerm(actor: HodActor, input: { academicSession: string; semester: "FIRST" | "SECOND"; confirm: boolean }, m: HodMeta = {}) {
    const current = await this.d.store.getCurrentTerm(actor.departmentId);
    const problem = checkTermTransition(current, input);
    if (problem) throw new AppError(409, problem, undefined, "TERM_TRANSITION_REFUSED");
    if (input.confirm !== true) {
      throw new AppError(422, "Changing the term makes this term's lecturer and representative assignments inactive until they are renewed, and students must be moved to the new session. Send confirm: true to proceed.", undefined, "CONFIRMATION_REQUIRED");
    }
    const term = await this.d.store.setCurrentTerm(actor.departmentId, { academicSession: input.academicSession, semester: input.semester });
    await this.audit(actor, m, "ACADEMIC_TERM_CHANGED", { resourceType: "TERM", resourceId: `${term.academicSession}/${term.semester}`, detail: { from: current ? { academicSession: current.academicSession, semester: current.semester } : null, to: { academicSession: term.academicSession, semester: term.semester } } });
    return { currentTerm: { academicSession: term.academicSession, semester: term.semester }, note: "Renew lecturer / representative assignments and update students' academic records for the new term." };
  }
  async updateRegistration(actor: HodActor, patch: { registrationOpen?: boolean; registrationOpensAt?: Date | null; registrationClosesAt?: Date | null; maxUnits?: number }, m: HodMeta = {}) {
    const term = await this.d.store.getCurrentTerm(actor.departmentId);
    if (!term) throw new AppError(409, "No academic term is active for your department.", undefined, "NO_CURRENT_TERM");
    const opens = patch.registrationOpensAt === undefined ? term.registrationOpensAt : patch.registrationOpensAt ?? undefined;
    const closes = patch.registrationClosesAt === undefined ? term.registrationClosesAt : patch.registrationClosesAt ?? undefined;
    if (opens && closes && closes <= opens) throw new AppError(422, "Registration must close after it opens.", undefined, "INVALID_WINDOW");
    const next = await this.d.store.updateRegistration(actor.departmentId, pick(patch, ["registrationOpen", "registrationOpensAt", "registrationClosesAt", "maxUnits"]));
    await this.audit(actor, m, "REGISTRATION_SETTINGS_CHANGED", { resourceType: "TERM", detail: { fields: Object.keys(patch) } });
    return { registration: { open: next?.registrationOpen, opensAt: next?.registrationOpensAt ?? null, closesAt: next?.registrationClosesAt ?? null, maxUnits: next?.maxUnits } };
  }

  /* ------------------------------ students ------------------------------ */
  private studentDTO(s: NonNullable<Awaited<ReturnType<HodStore["getStudent"]>>>) {
    return {
      id: s.id, firstName: s.firstName, lastName: s.lastName, matricNumber: s.matricNumber, email: s.email ?? null, phone: s.phone ?? null, level: s.level,
      academicSession: s.academicSession, status: s.status, onboardingCompleted: s.onboardingCompleted, profilePhoto: s.profilePhoto ?? null,
    };
  }
  async listStudents(actor: HodActor, q: Parameters<HodStore["listStudents"]>[1]) {
    return paged(q, await this.d.store.listStudents(actor.departmentId, q), (s) => this.studentDTO(s));
  }
  private async loadStudent(actor: HodActor, id: string, m: HodMeta) {
    return (await this.d.store.getStudent(actor.departmentId, id)) ?? this.notFound(actor, m, "Student", "STUDENT", id);
  }
  async getStudent(actor: HodActor, id: string, m: HodMeta = {}) {
    const s = await this.loadStudent(actor, id, m);
    const [enrollments, term] = await Promise.all([this.d.store.studentEnrollments(actor.departmentId, id), this.d.store.getCurrentTerm(actor.departmentId)]);
    return { ...this.studentDTO(s), currentCourses: enrollments.filter((e) => term && e.academicSession === term.academicSession && e.semester === term.semester && e.status === "ENROLLED").map((e) => e.courseCode) };
  }
  /** Suspends / reactivates a student's portal access. Takes effect immediately (student authentication re-checks status on every request). Identity fields can't be changed here. */
  async setStudentStatus(actor: HodActor, id: string, status: string, m: HodMeta = {}) {
    const s = await this.loadStudent(actor, id, m);
    const problem = checkStudentStatusChange({ current: s.status, next: status, onboardingCompleted: s.onboardingCompleted });
    if (problem) throw new AppError(409, problem, undefined, "STUDENT_STATUS_REFUSED");
    const next = await this.d.store.setStudentStatus(actor.departmentId, id, status as "ACTIVE" | "SUSPENDED");
    if (!next) return this.notFound(actor, m, "Student", "STUDENT", id);
    await this.audit(actor, m, "STUDENT_STATUS_CHANGED", { resourceType: "STUDENT", resourceId: id, detail: { from: s.status, to: status } });
    return this.studentDTO(next);
  }
  async studentCourses(actor: HodActor, id: string, m: HodMeta = {}) {
    await this.loadStudent(actor, id, m);
    const rows = await this.d.store.studentEnrollments(actor.departmentId, id);
    const term = await this.d.store.getCurrentTerm(actor.departmentId);
    return rows.map((e) => ({ ...e, current: Boolean(term && e.academicSession === term.academicSession && e.semester === term.semester) }));
  }
  /** Read-only attendance summary of ONE student for the current term (the HOD cannot create or edit attendance records). */
  async studentAttendance(actor: HodActor, id: string, m: HodMeta = {}) {
    await this.loadStudent(actor, id, m);
    const term = await this.d.store.getCurrentTerm(actor.departmentId);
    if (!term) return { term: null, courses: [] };
    const rows = await this.d.store.studentAttendance(actor.departmentId, id, term);
    return {
      term: { academicSession: term.academicSession, semester: term.semester },
      courses: rows.map((r) => ({ courseCode: r.courseCode, sessionsHeld: r.sessionsHeld, attended: r.attended, late: r.late, absent: Math.max(0, r.sessionsHeld - r.attended), percentage: pct(r.attended, r.sessionsHeld) })),
    };
  }
  /** Moves a student to another level / session (the department's own promotion workflow). Level must be one the department offers. Matric number, department and role are not parameters. */
  async updateStudentAcademicRecord(actor: HodActor, id: string, patch: { level?: string; academicSession?: string }, m: HodMeta = {}) {
    await this.loadStudent(actor, id, m);
    await this.validateAcademicPatch(actor, patch);
    const n = await this.d.store.updateStudentAcademic(actor.departmentId, [id], pick(patch, ["level", "academicSession"]));
    if (n !== 1) return this.notFound(actor, m, "Student", "STUDENT", id);
    await this.audit(actor, m, "STUDENT_ACADEMIC_RECORD_UPDATED", { resourceType: "STUDENT", resourceId: id, detail: { ...patch } });
    return this.studentDTO((await this.d.store.getStudent(actor.departmentId, id))!);
  }
  /** All-or-nothing: every id must belong to this department or nothing changes. */
  async bulkUpdateAcademicRecords(actor: HodActor, ids: string[], patch: { level?: string; academicSession?: string }, m: HodMeta = {}) {
    const unique = [...new Set(ids)];
    await this.validateAcademicPatch(actor, patch);
    if ((await this.d.store.countStudentsInDepartment(actor.departmentId, unique)) !== unique.length) {
      await this.audit(actor, m, "ACCESS_DENIED", { resourceType: "STUDENT", detail: { reason: "BULK_OUT_OF_SCOPE", requested: unique.length } });
      throw new AppError(404, "One or more students were not found.", undefined, "NOT_FOUND");
    }
    const updated = await this.d.store.updateStudentAcademic(actor.departmentId, unique, pick(patch, ["level", "academicSession"]));
    await this.audit(actor, m, "STUDENT_ACADEMIC_RECORD_UPDATED", { resourceType: "STUDENT", detail: { count: updated, ...patch } });
    return { updated };
  }
  private async validateAcademicPatch(actor: HodActor, patch: { level?: string; academicSession?: string }) {
    if (!patch.level && !patch.academicSession) throw new AppError(422, "Provide a level or an academicSession.", undefined, "NOTHING_TO_UPDATE");
    const dept = await this.d.store.getDepartment(actor.departmentId);
    if (patch.level && !dept?.levels.includes(patch.level)) throw new AppError(422, `Level ${patch.level} is not offered by your department.`, undefined, "INVALID_LEVEL");
    if (patch.academicSession && checkCourseSession(patch.academicSession, null)) throw new AppError(422, "academicSession must look like 2026/2027.", undefined, "INVALID_SESSION");
  }

  /* ------------------------------ lecturers ------------------------------ */
  private lecturerDTO(l: NonNullable<Awaited<ReturnType<HodStore["getLecturer"]>>>) {
    return { id: l.id, firstName: l.firstName, lastName: l.lastName, name: fullName(l), email: l.email, phone: l.phone ?? null, staffId: l.staffId, status: l.status, profilePhoto: l.profilePhoto ?? null };
  }
  async listLecturers(actor: HodActor, q: Parameters<HodStore["listLecturers"]>[1]) {
    return paged(q, await this.d.store.listLecturers(actor.departmentId, q), (l) => this.lecturerDTO(l));
  }
  private async loadLecturer(actor: HodActor, id: string, m: HodMeta) {
    return (await this.d.store.getLecturer(actor.departmentId, id)) ?? this.notFound(actor, m, "Lecturer", "LECTURER", id);
  }
  async getLecturer(actor: HodActor, id: string, m: HodMeta = {}) {
    const l = await this.loadLecturer(actor, id, m);
    return { ...this.lecturerDTO(l), assignedCourses: (await this.lecturerCourses(actor, id, m)).filter((c) => c.current).map((c) => ({ courseId: c.courseId, courseCode: c.courseCode, title: c.courseTitle })) };
  }
  /** The new lecturer's department is the HOD's own: it is not an input. The raw activation token is emailed and never returned. */
  async createLecturer(actor: HodActor, input: { firstName: string; lastName: string; email: string; phone?: string; staffId: string }, m: HodMeta = {}) {
    const raw = this.d.generateToken();
    let row;
    try {
      row = await this.d.store.createLecturer({ departmentId: actor.departmentId, ...input, activationTokenHash: this.d.hashToken(raw), activationExpires: new Date(this.d.now().getTime() + INVITE_HOURS * 3_600_000) });
    } catch (e) {
      if (e instanceof StoreDuplicateError) throw new AppError(409, "A lecturer with that email or staff ID already exists.", undefined, "LECTURER_DUPLICATE");
      throw e;
    }
    let invitationSent = true;
    try { await this.d.sendInvite(row.email, row.firstName, raw, INVITE_HOURS); } catch { invitationSent = false; }
    await this.audit(actor, m, "LECTURER_CREATED", { resourceType: "LECTURER", resourceId: row.id, detail: { staffId: row.staffId, invitationSent } });
    return { ...this.lecturerDTO(row), invitationSent };
  }
  async reinviteLecturer(actor: HodActor, id: string, m: HodMeta = {}) {
    const l = await this.loadLecturer(actor, id, m);
    if (l.status !== "INVITED") throw new AppError(409, "This lecturer has already activated their account.", undefined, "ALREADY_ACTIVATED");
    const raw = this.d.generateToken();
    await this.d.store.reissueLecturerInvitation(actor.departmentId, id, this.d.hashToken(raw), new Date(this.d.now().getTime() + INVITE_HOURS * 3_600_000));
    let invitationSent = true;
    try { await this.d.sendInvite(l.email, l.firstName, raw, INVITE_HOURS); } catch { invitationSent = false; }
    await this.audit(actor, m, "LECTURER_INVITATION_REISSUED", { resourceType: "LECTURER", resourceId: id });
    return { invitationSent };
  }
  /** Name and phone only. Email, staff ID, department and role are not editable here. */
  async updateLecturer(actor: HodActor, id: string, patch: { firstName?: string; lastName?: string; phone?: string | null }, m: HodMeta = {}) {
    await this.loadLecturer(actor, id, m);
    const next = await this.d.store.updateLecturer(actor.departmentId, id, pick(patch, ["firstName", "lastName", "phone"]));
    if (!next) return this.notFound(actor, m, "Lecturer", "LECTURER", id);
    await this.audit(actor, m, "LECTURER_UPDATED", { resourceType: "LECTURER", resourceId: id, detail: { fields: Object.keys(patch) } });
    return this.lecturerDTO(next);
  }
  async setLecturerStatus(actor: HodActor, id: string, status: "ACTIVE" | "SUSPENDED", m: HodMeta = {}) {
    const l = await this.loadLecturer(actor, id, m);
    if (l.status === "INVITED") throw new AppError(409, "This lecturer hasn't activated their account yet.", undefined, "NOT_ACTIVATED");
    if (l.status === status) throw new AppError(409, `The lecturer is already ${status}.`, undefined, "LECTURER_STATUS_REFUSED");
    const next = await this.d.store.setLecturerStatus(actor.departmentId, id, status);
    if (!next) return this.notFound(actor, m, "Lecturer", "LECTURER", id);
    await this.audit(actor, m, "LECTURER_STATUS_CHANGED", { resourceType: "LECTURER", resourceId: id, detail: { from: l.status, to: status } });
    return this.lecturerDTO(next);
  }
  async lecturerCourses(actor: HodActor, id: string, m: HodMeta = {}) {
    await this.loadLecturer(actor, id, m);
    const [rows, term] = await Promise.all([this.d.store.lecturerAssignments(actor.departmentId, id), this.d.store.getCurrentTerm(actor.departmentId)]);
    return rows.map((a) => ({
      assignmentId: a.id, courseId: a.courseId, courseCode: a.courseCode, courseTitle: a.courseTitle ?? null, level: a.level, academicSession: a.academicSession, semester: a.semester,
      status: a.status, assignedAt: a.assignedAt, assignedBy: a.assignedBy.name,
      current: a.status === "ACTIVE" && Boolean(term && a.academicSession === term.academicSession && a.semester === term.semester),
    }));
  }
  /** Reuses LecturerCourseAssignment. Both the lecturer and the course must be in the HOD's department, the course must be in the CURRENT term, and duplicates are refused. */
  async assignLecturerToCourse(actor: HodActor, lecturerId: string, courseId: string, m: HodMeta = {}) {
    const lecturer = await this.loadLecturer(actor, lecturerId, m);
    const course = (await this.d.store.getCourse(actor.departmentId, courseId)) ?? (await this.notFound(actor, m, "Course", "COURSE", courseId));
    const term = await this.d.store.getCurrentTerm(actor.departmentId);
    const problem = checkLecturerAssignmentRules({
      lecturerDepartmentId: actor.departmentId, courseDepartmentId: course.departmentId, lecturerStatus: lecturer.status,
      courseIsCurrentTerm: Boolean(term && term.academicSession === course.academicSession && term.semester === course.semester),
      alreadyActiveOnCourse: await this.d.store.hasActiveLecturerAssignment(actor.departmentId, lecturerId, courseId),
    });
    if (problem) throw new AppError(422, problem, undefined, "ASSIGNMENT_RULE");
    try {
      const a = await this.d.store.createLecturerAssignment({
        lecturerId, departmentId: actor.departmentId, courseId: course.id, courseCode: course.courseCode, level: course.level, academicSession: course.academicSession,
        semester: course.semester, status: "ACTIVE", assignedBy: { name: fullName(actor), role: "HOD" }, assignedAt: this.d.now(),
      });
      await this.audit(actor, m, "LECTURER_ASSIGNED_TO_COURSE", { resourceType: "LECTURER", resourceId: lecturerId, detail: { courseCode: course.courseCode, assignmentId: a.id } });
      await this.safe(() => this.d.notifyLecturer(lecturerId, actor.departmentId, { kind: "SYSTEM", title: `Assigned to ${course.courseCode}`, body: `You have been assigned to ${course.courseCode} (${course.title}).`, link: "/lecturer/courses" }));
      return { assignmentId: a.id, courseId: course.id, courseCode: course.courseCode, academicSession: course.academicSession, semester: course.semester, status: a.status };
    } catch (e) {
      if (e instanceof StoreDuplicateError) throw new AppError(409, "This lecturer is already assigned to the course.", undefined, "ASSIGNMENT_DUPLICATE");
      throw e;
    }
  }
  async removeLecturerFromCourse(actor: HodActor, lecturerId: string, courseId: string, m: HodMeta = {}) {
    await this.loadLecturer(actor, lecturerId, m);
    const a = await this.d.store.revokeLecturerAssignment(actor.departmentId, lecturerId, courseId, { name: fullName(actor), role: "HOD" });
    if (!a) return this.notFound(actor, m, "Assignment", "LECTURER", courseId);
    await this.audit(actor, m, "LECTURER_UNASSIGNED", { resourceType: "LECTURER", resourceId: lecturerId, detail: { courseCode: a.courseCode, assignmentId: a.id } });
  }

  /* ------------------------------ courses (official catalogue) ------------------------------ */
  private courseDTO(c: CourseRec, extra: Record<string, unknown> = {}) {
    return { id: c.id, courseCode: c.courseCode, title: c.title, description: c.description ?? null, units: c.units, level: c.level, semester: c.semester, academicSession: c.academicSession, status: c.status, ...extra };
  }
  async listCourses(actor: HodActor, q: Parameters<HodStore["listCourses"]>[1]) {
    return paged(q, await this.d.store.listCourses(actor.departmentId, q), (c) => this.courseDTO(c, { enrolledCount: c.enrolledCount, lecturers: c.lecturers ?? [] }));
  }
  private async loadCourse(actor: HodActor, id: string, m: HodMeta) {
    return (await this.d.store.getCourse(actor.departmentId, id)) ?? this.notFound(actor, m, "Course", "COURSE", id);
  }
  async getCourse(actor: HodActor, id: string, m: HodMeta = {}) {
    const c = await this.loadCourse(actor, id, m);
    const [enrolledCount, lecturers, reps] = await Promise.all([this.d.store.countEnrollments(c), this.d.store.courseLecturers(c), this.d.store.courseRepresentatives(c)]);
    return this.courseDTO(c, {
      enrolledCount, lecturers,
      representatives: reps.map((r) => ({ assignmentId: r.id, role: r.role, status: r.status, student: r.student })),
    });
  }
  /** The department is the HOD's own (never an input). Level must be one the department offers; (code, session, semester) must be unique within the department. */
  async createCourse(actor: HodActor, input: { courseCode: string; title: string; description?: string; units: number; level: string; semester: "FIRST" | "SECOND"; academicSession?: string }, m: HodMeta = {}) {
    const code = normalizeCourseCode(input.courseCode);
    if (!COURSE_CODE_REGEX.test(code)) throw new AppError(422, "Course code must look like CSC201.", undefined, "INVALID_COURSE_CODE");
    const [dept, term] = await Promise.all([this.d.store.getDepartment(actor.departmentId), this.d.store.getCurrentTerm(actor.departmentId)]);
    if (!dept?.levels.includes(input.level)) throw new AppError(422, `Level ${input.level} is not offered by your department (${dept?.levels.join(", ")}).`, undefined, "INVALID_LEVEL");
    const session = input.academicSession ?? term?.academicSession;
    if (!session) throw new AppError(422, "academicSession is required (the department has no current term).", undefined, "INVALID_SESSION");
    const problem = checkCourseSession(session, term?.academicSession ?? null);
    if (problem) throw new AppError(422, problem, undefined, "INVALID_SESSION");
    try {
      const c = await this.d.store.createCourse({ departmentId: actor.departmentId, courseCode: code, title: input.title, description: input.description, units: input.units, level: input.level, semester: input.semester, academicSession: session, status: "ACTIVE" });
      await this.audit(actor, m, "COURSE_CREATED", { resourceType: "COURSE", resourceId: c.id, detail: { courseCode: c.courseCode, level: c.level, semester: c.semester, academicSession: c.academicSession } });
      return this.courseDTO(c, { enrolledCount: 0 });
    } catch (e) {
      if (e instanceof StoreDuplicateError) throw new AppError(409, `${code} already exists for ${session} ${input.semester.toLowerCase()} semester in your department.`, undefined, "COURSE_DUPLICATE");
      throw e;
    }
  }
  /** Code and session are fixed once created. Title / description / units can change; level and semester only while nobody is enrolled or assigned. */
  async updateCourse(actor: HodActor, id: string, patch: { title?: string; description?: string; units?: number; level?: string; semester?: "FIRST" | "SECOND" }, m: HodMeta = {}) {
    const c = await this.loadCourse(actor, id, m);
    const structural = { level: patch.level !== undefined && patch.level !== c.level, semester: patch.semester !== undefined && patch.semester !== c.semester };
    if (structural.level || structural.semester) {
      const [enrolled, lecturers, reps] = await Promise.all([this.d.store.countEnrollments(c), this.d.store.courseLecturers(c), this.d.store.courseRepresentatives(c)]);
      const problem = checkCourseStructureChange(enrolled + lecturers.length + reps.filter((r) => r.status === "ACTIVE").length, structural);
      if (problem) throw new AppError(409, problem, undefined, "COURSE_STRUCTURE_LOCKED");
      if (patch.level) {
        const dept = await this.d.store.getDepartment(actor.departmentId);
        if (!dept?.levels.includes(patch.level)) throw new AppError(422, `Level ${patch.level} is not offered by your department.`, undefined, "INVALID_LEVEL");
      }
    }
    try {
      const next = await this.d.store.updateCourse(actor.departmentId, id, pick(patch, ["title", "description", "units", "level", "semester"]));
      if (!next) return this.notFound(actor, m, "Course", "COURSE", id);
      await this.audit(actor, m, "COURSE_UPDATED", { resourceType: "COURSE", resourceId: id, detail: { courseCode: c.courseCode, fields: Object.keys(patch) } });
      return this.courseDTO(next, { enrolledCount: await this.d.store.countEnrollments(next) });
    } catch (e) {
      if (e instanceof StoreDuplicateError) throw new AppError(409, "That change would duplicate another course in your department.", undefined, "COURSE_DUPLICATE");
      throw e;
    }
  }
  async setCourseStatus(actor: HodActor, id: string, status: "ACTIVE" | "ARCHIVED", m: HodMeta = {}) {
    const c = await this.loadCourse(actor, id, m);
    if (c.status === status) throw new AppError(409, `The course is already ${status}.`, undefined, "COURSE_STATUS_REFUSED");
    const next = await this.d.store.updateCourse(actor.departmentId, id, { status });
    if (!next) return this.notFound(actor, m, "Course", "COURSE", id);
    await this.audit(actor, m, "COURSE_STATUS_CHANGED", { resourceType: "COURSE", resourceId: id, detail: { courseCode: c.courseCode, from: c.status, to: status } });
    return this.courseDTO(next);
  }

  /* ------------------------------ representatives ------------------------------ */
  private repDTO(r: NonNullable<Awaited<ReturnType<HodStore["getRepAssignment"]>>>) {
    return {
      id: r.id, role: r.role, status: r.status, scope: r.scope === "LEVEL" ? "LEVEL" : "COURSE", student: { id: r.studentId, firstName: r.student.firstName, lastName: r.student.lastName, matricNumber: r.student.matricNumber }, // explicit fields: never spread (a Mongoose document's names are prototype getters and would be lost)
      level: r.level, academicSession: r.academicSession, semester: r.semester,
      // Level appointments have no course; only older course-scoped records do.
      course: r.courseId ? { id: r.courseId, courseCode: r.courseCode, title: r.courseTitle ?? null, level: r.level, academicSession: r.academicSession, semester: r.semester } : null,
      assignedBy: r.assignedBy.name, assignedAt: r.assignedAt,
    };
  }
  async listRepresentatives(actor: HodActor, q: Parameters<HodStore["listRepAssignments"]>[1]) {
    return paged(q, await this.d.store.listRepAssignments(actor.departmentId, q), (r) => this.repDTO(r));
  }
  /**
   * Appoints a Course Rep / Assistant Course Rep for a LEVEL of the HOD's department in the department's CURRENT term (reuses CourseRepresentativeAssignment).
   * The appointment is not tied to a course: it covers the whole level (every course of that level, and the class). The student must be an ACTIVE student of
   * this department; one Course Rep and up to two Assistants per level per term. A student cannot appoint themselves: there is no student-facing way to create one.
   */
  async appointRepresentative(actor: HodActor, input: { studentId: string; level: string; role: "COURSE_REP" | "ASSISTANT_COURSE_REP" }, m: HodMeta = {}) {
    const [dept, term] = await Promise.all([this.d.store.getDepartment(actor.departmentId), this.d.store.getCurrentTerm(actor.departmentId)]);
    const student = (await this.d.store.getStudent(actor.departmentId, input.studentId)) ?? (await this.notFound(actor, m, "Student", "STUDENT", input.studentId));
    const problem = checkLevelAppointment({
      role: input.role, studentId: student.id, studentDepartmentId: actor.departmentId, departmentId: actor.departmentId, studentStatus: student.status,
      level: input.level, departmentLevels: dept?.levels ?? [], hasCurrentTerm: Boolean(term),
      activeOnLevel: term ? await this.d.store.activeRepsOnLevel(actor.departmentId, input.level, term.academicSession, term.semester) : [],
    });
    if (problem || !term) throw new AppError(422, problem ?? "Set the department's current term before appointing representatives.", undefined, "ASSIGNMENT_RULE");
    try {
      const a = await this.d.store.createRepAssignment({
        studentId: student.id, departmentId: actor.departmentId, scope: "LEVEL", level: input.level, academicSession: term.academicSession,
        semester: term.semester, role: input.role, status: "ACTIVE", assignedBy: { name: fullName(actor), role: "HOD" }, assignedAt: this.d.now(),
      });
      await this.audit(actor, m, "REPRESENTATIVE_APPOINTED", { resourceType: "REPRESENTATIVE", resourceId: a.id, detail: { studentId: student.id, level: input.level, role: input.role } });
      await this.safe(() => this.d.notifyStudent(student.id, actor.departmentId, { kind: "SYSTEM", title: `You are now ${input.role === "COURSE_REP" ? "Course Rep" : "Assistant Course Rep"} for ${input.level} Level`, body: "Your department appointed you. Your representative tools are now available.", link: "/student" }));
      return this.repDTO((await this.d.store.getRepAssignment(actor.departmentId, a.id))!);
    } catch (e) {
      if (e instanceof StoreDuplicateError) throw new AppError(409, `That representative role is already taken for ${input.level} Level.`, undefined, "ASSIGNMENT_DUPLICATE");
      throw e;
    }
  }
  private async loadRep(actor: HodActor, id: string, m: HodMeta) {
    return (await this.d.store.getRepAssignment(actor.departmentId, id)) ?? this.notFound(actor, m, "Representative assignment", "REPRESENTATIVE", id);
  }
  async setRepresentativeStatus(actor: HodActor, id: string, status: "ACTIVE" | "INACTIVE", m: HodMeta = {}) {
    const a = await this.loadRep(actor, id, m);
    if (a.status === "REVOKED") throw new AppError(409, "A revoked appointment can't be reinstated; appoint again.", undefined, "ASSIGNMENT_REVOKED");
    if (a.status === status) throw new AppError(409, `The appointment is already ${status}.`, undefined, "ASSIGNMENT_STATUS_REFUSED");
    if (status === "ACTIVE") { // reinstating must still respect "one Course Rep per level" (per course for legacy records)
      const others = a.scope === "LEVEL" || !a.courseId ? await this.d.store.activeRepsOnLevel(actor.departmentId, a.level, a.academicSession, a.semester) : await this.d.store.activeRepsOnCourse(actor.departmentId, a.courseId);
      if (others.some((x) => a.role === "COURSE_REP" && x.role === "COURSE_REP")) throw new AppError(409, `${a.scope === "LEVEL" ? `${a.level} Level` : "This course"} already has an active Course Rep.`, undefined, "ASSIGNMENT_DUPLICATE");
    }
    const next = await this.d.store.setRepAssignmentStatus(actor.departmentId, id, status);
    if (!next) return this.notFound(actor, m, "Representative assignment", "REPRESENTATIVE", id);
    await this.audit(actor, m, "REPRESENTATIVE_STATUS_CHANGED", { resourceType: "REPRESENTATIVE", resourceId: id, detail: { from: a.status, to: status, level: a.level, courseCode: a.courseCode } });
    return this.repDTO(next);
  }
  /** Ends the student's representative authority; it applies on their very next request. */
  async revokeRepresentative(actor: HodActor, id: string, m: HodMeta = {}) {
    const a = await this.loadRep(actor, id, m);
    if (a.status === "REVOKED") throw new AppError(409, "This appointment was already revoked.", undefined, "ASSIGNMENT_REVOKED");
    const next = await this.d.store.revokeRepAssignment(actor.departmentId, id, { name: fullName(actor), role: "HOD" });
    if (!next) return this.notFound(actor, m, "Representative assignment", "REPRESENTATIVE", id);
    await this.audit(actor, m, "REPRESENTATIVE_REVOKED", { resourceType: "REPRESENTATIVE", resourceId: id, detail: { studentId: a.studentId, level: a.level, courseCode: a.courseCode, role: a.role } });
    await this.safe(() => this.d.notifyStudent(a.studentId, actor.departmentId, { kind: "SYSTEM", title: `Representative role ended (${a.scope === "LEVEL" ? `${a.level} Level` : a.courseCode})`, body: "Your department has ended your representative appointment.", link: "/student" }));
  }

  /* ------------------------------ timetable: read-only + conflict report ------------------------------ */
  /** The class timetable belongs to the Course Rep. The HOD can review it and see clashes; there is deliberately no edit / override here. */
  async listTimetable(actor: HodActor, q: Parameters<HodStore["listTimetable"]>[2]) {
    const term = await this.d.store.getCurrentTerm(actor.departmentId);
    if (!term) return { readOnly: true, term: null, items: [], ...meta(q, 0) };
    const p = await this.d.store.listTimetable(actor.departmentId, term, q);
    return { readOnly: true, term: { academicSession: term.academicSession, semester: term.semester }, ...paged(q, p, (t) => this.timetableDTO(t)) };
  }
  private timetableDTO(t: TimetableRec) {
    return { id: t.id, courseCode: t.courseCode ?? null, level: t.level, title: t.title, type: t.type, dayOfWeek: t.dayOfWeek, date: t.date ?? null, startTime: t.startTime, endTime: t.endTime, venue: t.venue ?? null, lecturerName: t.lecturerName ?? null, source: t.source, status: t.status };
  }
  async timetableConflicts(actor: HodActor) {
    const term = await this.d.store.getCurrentTerm(actor.departmentId);
    if (!term) return { term: null, conflicts: [] };
    const rows = (await this.d.store.allTimetable(actor.departmentId, term)).filter((t) => t.status !== "DRAFT");
    const conflicts: { type: "VENUE" | "LECTURER" | "LEVEL"; a: ReturnType<HodService["timetableDTO"]>; b: ReturnType<HodService["timetableDTO"]> }[] = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i], b = rows[j];
        if (a.courseCode === b.courseCode) continue; // clashes inside one course are blocked when the rep saves
        if (!slotsOverlap(a, b)) continue;
        const push = (type: "VENUE" | "LECTURER" | "LEVEL") => conflicts.push({ type, a: this.timetableDTO(a), b: this.timetableDTO(b) });
        if (a.venue && a.venue === b.venue) push("VENUE");
        if (a.lecturerName && a.lecturerName === b.lecturerName) push("LECTURER");
        if (a.level === b.level) push("LEVEL");
      }
    }
    return { term: { academicSession: term.academicSession, semester: term.semester }, conflicts };
  }

  /* ------------------------------ announcements (department-wide) ------------------------------ */
  private announcementDTO(a: HodAnnouncementRec, actor: HodActor) {
    const mine = a.hodId === actor.hodId;
    return {
      id: a.id, title: a.title, content: a.body, priority: a.priority, status: a.status, published: a.status === "PUBLISHED", scope: a.scope, levels: a.levels ?? [],
      courseCode: a.courseCode ?? null, image: a.image ? { url: a.image.url } : null, author: { name: a.authorName, role: a.authorRole }, mine, canEdit: mine, canDelete: mine, publishedAt: a.publishedAt ?? null, expiresAt: a.expiresAt ?? null, createdAt: a.createdAt, updatedAt: a.updatedAt,
    };
  }
  async listAnnouncements(actor: HodActor, q: Parameters<HodStore["listAnnouncements"]>[2]) {
    return paged(q, await this.d.store.listAnnouncements(actor.departmentId, actor.hodId, q), (a) => this.announcementDTO(a, actor));
  }
  private async levelsOrThrow(actor: HodActor, levels?: string[]) {
    if (!levels?.length) return [];
    const dept = await this.d.store.getDepartment(actor.departmentId);
    const bad = levels.filter((l) => !dept?.levels.includes(l));
    if (bad.length) throw new AppError(422, `Level ${bad[0]} is not offered by your department.`, undefined, "INVALID_LEVEL");
    return [...new Set(levels)];
  }
  /** Scope is the HOD's own department (every level, or the chosen levels). There is no university-wide announcement. */
  async createAnnouncement(actor: HodActor, input: { title: string; content: string; priority?: "NORMAL" | "IMPORTANT" | "URGENT"; published?: boolean; levels?: string[]; expiresAt?: Date; image?: Buffer }, m: HodMeta = {}) {
    const levels = await this.levelsOrThrow(actor, input.levels);
    const published = input.published ?? true;
    this.checkAnnouncementImage(input.image);
    const image = input.image ? await this.d.uploadAnnouncementImage(input.image) : undefined;
    const rec = await this.d.store.createAnnouncement({
      departmentId: actor.departmentId, title: input.title, body: input.content, priority: input.priority ?? "NORMAL", status: published ? "PUBLISHED" : "DRAFT",
      scope: levels.length ? "LEVEL" : "DEPARTMENT", levels, hodId: actor.hodId, authorName: fullName(actor), authorRole: "HOD", image, publishedAt: published ? this.d.now() : undefined, expiresAt: input.expiresAt,
    }).catch(async (err) => { if (image) await this.d.deleteAnnouncementImage(image.publicId).catch(() => undefined); throw err; });
    await this.audit(actor, m, "ANNOUNCEMENT_CREATED", { resourceType: "ANNOUNCEMENT", resourceId: rec.id, detail: { title: rec.title, scope: rec.scope, levels, published, withImage: Boolean(image) } });
    if (published) await this.safe(() => this.d.notifyDepartmentStudents(actor.departmentId, levels, { kind: "ANNOUNCEMENT", title: rec.title, body: rec.body.slice(0, 200), link: "/student/announcements" }));
    return this.announcementDTO(rec, actor);
  }
  private checkAnnouncementImage(buffer?: Buffer) {
    if (buffer && !sniffImage(buffer)) throw new AppError(415, "Only JPEG, PNG or WebP images can be attached.", undefined, "UNSUPPORTED_FILE_TYPE");
  }
  private async loadOwnAnnouncement(actor: HodActor, id: string, m: HodMeta) {
    const rec = await this.d.store.getAnnouncement(actor.departmentId, id);
    if (!rec || rec.status === "DELETED") return this.notFound(actor, m, "Announcement", "ANNOUNCEMENT", id);
    if (rec.hodId !== actor.hodId) throw new AppError(403, "Only the author can change this announcement.", undefined, "NOT_OWNER"); // lecturers' and reps' announcements stay theirs
    return rec;
  }
  async updateAnnouncement(actor: HodActor, id: string, patch: { title?: string; content?: string; priority?: "NORMAL" | "IMPORTANT" | "URGENT"; published?: boolean; levels?: string[]; expiresAt?: Date | null; image?: Buffer; removeImage?: boolean }, m: HodMeta = {}) {
    if (!Object.values(patch).some((v) => v !== undefined)) throw new AppError(422, "Provide at least one field to update.", undefined, "NOTHING_TO_UPDATE");
    const rec = await this.loadOwnAnnouncement(actor, id, m);
    this.checkAnnouncementImage(patch.image);
    const previousImageId = rec.image?.publicId; // read BEFORE the write: it must be the old picture that gets deleted
    const newImage = patch.image ? await this.d.uploadAnnouncementImage(patch.image) : undefined;
    const levels = patch.levels ? await this.levelsOrThrow(actor, patch.levels) : undefined;
    const status = patch.published === undefined ? undefined : patch.published ? "PUBLISHED" : rec.status === "DRAFT" ? "DRAFT" : "UNPUBLISHED";
    const nowPublishing = patch.published === true && rec.status !== "PUBLISHED";
    const next = await this.d.store.updateAnnouncement(id, {
      ...(patch.title !== undefined && { title: patch.title }), ...(patch.content !== undefined && { body: patch.content }), ...(patch.priority !== undefined && { priority: patch.priority }),
      ...(patch.expiresAt !== undefined && { expiresAt: patch.expiresAt }), ...(levels && { levels, scope: levels.length ? "LEVEL" : "DEPARTMENT" }),
      ...(status && { status }), ...(nowPublishing && { publishedAt: this.d.now() }),
      ...(newImage ? { image: newImage } : patch.removeImage ? { image: null } : {}),
    }).catch(async (err) => { if (newImage) await this.d.deleteAnnouncementImage(newImage.publicId).catch(() => undefined); throw err; });
    if (!next) { if (newImage) await this.d.deleteAnnouncementImage(newImage.publicId).catch(() => undefined); return this.notFound(actor, m, "Announcement", "ANNOUNCEMENT", id); }
    if ((newImage || patch.removeImage) && previousImageId) await this.d.deleteAnnouncementImage(previousImageId).catch(() => undefined);
    await this.audit(actor, m, patch.published === false ? "ANNOUNCEMENT_UNPUBLISHED" : "ANNOUNCEMENT_UPDATED", { resourceType: "ANNOUNCEMENT", resourceId: id, detail: { fields: Object.keys(patch).filter((k) => k !== "image"), image: newImage ? "replaced" : patch.removeImage ? "removed" : undefined } });
    if (nowPublishing) await this.safe(() => this.d.notifyDepartmentStudents(actor.departmentId, next.levels ?? [], { kind: "ANNOUNCEMENT", title: next.title, body: next.body.slice(0, 200), link: "/student/announcements" }));
    return this.announcementDTO(next, actor);
  }
  async deleteAnnouncement(actor: HodActor, id: string, m: HodMeta = {}) {
    const rec = await this.loadOwnAnnouncement(actor, id, m);
    const previousImageId = rec.image?.publicId;
    await this.d.store.updateAnnouncement(id, { status: "DELETED", ...(rec.image ? { image: null } : {}) }); // soft delete for the audit trail; the picture itself is removed from storage
    if (previousImageId) await this.d.deleteAnnouncementImage(previousImageId).catch(() => undefined);
    await this.audit(actor, m, "ANNOUNCEMENT_DELETED", { resourceType: "ANNOUNCEMENT", resourceId: id, detail: { title: rec.title } });
  }

  /* ------------------------------ department documents + materials overview ------------------------------ */
  private documentDTO(d: NonNullable<Awaited<ReturnType<HodStore["getDocument"]>>>) {
    return { id: d.id, title: d.title, description: d.description ?? null, levels: d.levels, published: d.status === "PUBLISHED", file: { url: d.file.url, name: d.file.originalName, mimeType: d.file.mimeType, sizeBytes: d.file.sizeBytes }, author: d.authorName, createdAt: d.createdAt, updatedAt: d.updatedAt };
  }
  async listDocuments(actor: HodActor, q: Parameters<HodStore["listDocuments"]>[1]) {
    return paged(q, await this.d.store.listDocuments(actor.departmentId, q), (d) => this.documentDTO(d));
  }
  /** Department-level administrative documents: a separate record type from lecturers' official materials and reps' class resources. */
  async createDocument(actor: HodActor, input: { title: string; description?: string; levels?: string[]; published?: boolean; fileUrl?: string; file?: { buffer: Buffer; originalName: string } }, m: HodMeta = {}) {
    if (Boolean(input.file) === Boolean(input.fileUrl)) throw new AppError(422, "Provide either a file or a link, not both.", undefined, "INVALID_RESOURCE_SOURCE");
    const levels = await this.levelsOrThrow(actor, input.levels);
    const file = input.file ? await this.d.uploadFile(input.file) : { url: input.fileUrl as string, originalName: input.title, mimeType: "text/uri-list", sizeBytes: 0 };
    const rec = await this.d.store.createDocument({ departmentId: actor.departmentId, title: input.title, description: input.description, levels, file, status: input.published === false ? "HIDDEN" : "PUBLISHED", hodId: actor.hodId, authorName: fullName(actor) });
    await this.audit(actor, m, "DOCUMENT_CREATED", { resourceType: "DOCUMENT", resourceId: rec.id, detail: { title: rec.title } });
    return this.documentDTO(rec);
  }
  async updateDocument(actor: HodActor, id: string, patch: { title?: string; description?: string; levels?: string[]; published?: boolean }, m: HodMeta = {}) {
    const cur = (await this.d.store.getDocument(actor.departmentId, id)) ?? (await this.notFound(actor, m, "Document", "DOCUMENT", id));
    const levels = patch.levels ? await this.levelsOrThrow(actor, patch.levels) : undefined;
    const next = await this.d.store.updateDocument(actor.departmentId, cur.id, { ...(patch.title !== undefined && { title: patch.title }), ...(patch.description !== undefined && { description: patch.description }), ...(levels && { levels }), ...(patch.published !== undefined && { status: patch.published ? "PUBLISHED" : "HIDDEN" }) });
    if (!next) return this.notFound(actor, m, "Document", "DOCUMENT", id);
    await this.audit(actor, m, "DOCUMENT_UPDATED", { resourceType: "DOCUMENT", resourceId: id, detail: { fields: Object.keys(patch) } });
    return this.documentDTO(next);
  }
  async deleteDocument(actor: HodActor, id: string, m: HodMeta = {}) {
    const cur = (await this.d.store.getDocument(actor.departmentId, id)) ?? (await this.notFound(actor, m, "Document", "DOCUMENT", id));
    await this.d.store.deleteDocument(actor.departmentId, id);
    if (cur.file.publicId) await this.d.deleteFile(cur.file).catch(() => undefined);
    await this.audit(actor, m, "DOCUMENT_DELETED", { resourceType: "DOCUMENT", resourceId: id, detail: { title: cur.title } });
  }
  /** READ-ONLY view of lecturers' official materials and reps' class resources, with their real owners. The HOD never becomes their owner. */
  async materialsOverview(actor: HodActor, q: Parameters<HodStore["listMaterialsOverview"]>[1]) {
    return paged(q, await this.d.store.listMaterialsOverview(actor.departmentId, q), (x) => ({ id: x.id, courseCode: x.courseCode ?? null, title: x.title, type: x.type, owner: { name: x.ownerName, role: x.ownerRole }, status: x.status, createdAt: x.createdAt, readOnly: true }));
  }

  /* ------------------------------ attendance oversight (read-only) ------------------------------ */
  private sessionState(s: { opensAt: Date; closesAt: Date; status: string }) {
    const now = this.d.now();
    return s.status === "CLOSED" || s.status === "CANCELLED" || now > s.closesAt ? "CLOSED" : now < s.opensAt ? "UPCOMING" : "OPEN";
  }
  async listAttendanceSessions(actor: HodActor, q: Parameters<HodStore["listSessions"]>[2]) {
    const term = await this.d.store.getCurrentTerm(actor.departmentId);
    const page = await this.d.store.listSessions(actor.departmentId, term, q, this.d.now());
    const [counts, enrolled] = await Promise.all([
      this.d.store.sessionRecordCounts(page.items.map((s) => s.id)),
      term ? this.d.store.enrolledCountsByCourse(actor.departmentId, term) : Promise.resolve(new Map<string, number>()),
    ]);
    return paged(q, page, (s) => {
      const c = counts.get(s.id) ?? { present: 0, late: 0 };
      const en = enrolled.get(s.courseCode) ?? 0;
      return {
        id: s.id, courseCode: s.courseCode, level: s.level, title: s.title, lecturer: s.lecturerName ?? null, startTime: s.opensAt, endTime: s.closesAt, state: this.sessionState(s),
        allowedRadiusInMeters: s.location?.allowedRadiusInMeters ?? null, present: c.present, late: c.late, enrolled: en, attendancePercentage: pct(c.present + c.late, en),
      };
    });
  }
  /** Read-only: who marked, how far from the room, how many suspicious attempts. There is no method to create / edit / delete a record. */
  async getAttendanceSession(actor: HodActor, id: string, m: HodMeta = {}) {
    const s = (await this.d.store.getSession(actor.departmentId, id)) ?? (await this.notFound(actor, m, "Attendance session", "COURSE", id));
    const term = await this.d.store.getCurrentTerm(actor.departmentId);
    const [records, flagged, enrolledMap] = await Promise.all([
      this.d.store.recordsForSession(s.id), this.d.store.flaggedAttempts(s.id),
      this.d.store.enrolledCountsByCourse(actor.departmentId, { academicSession: s.academicSession, semester: s.semester }),
    ]);
    void term;
    const enrolled = enrolledMap.get(s.courseCode) ?? 0;
    const present = records.filter((r) => r.status === "PRESENT").length;
    const late = records.filter((r) => r.status === "LATE").length;
    return {
      id: s.id, courseCode: s.courseCode, level: s.level, title: s.title, lecturer: s.lecturerName ?? null, academicSession: s.academicSession, semester: s.semester,
      startTime: s.opensAt, endTime: s.closesAt, state: this.sessionState(s), allowedRadiusInMeters: s.location?.allowedRadiusInMeters ?? null,
      counts: { present, late, enrolled, absent: Math.max(0, enrolled - present - late) }, attendancePercentage: pct(present + late, enrolled), flaggedAttempts: flagged,
      records: records.sort((a, b) => a.markedAt.getTime() - b.markedAt.getTime()).map((r) => ({ studentId: r.studentId, firstName: r.firstName, lastName: r.lastName, matricNumber: r.matricNumber, status: r.status, markedAt: r.markedAt, distanceMeters: r.distanceMeters ?? null })),
      readOnly: true,
    };
  }
  async attendanceStatistics(actor: HodActor) {
    const term = await this.d.store.getCurrentTerm(actor.departmentId);
    if (!term) return { term: null, overallAttendancePercentage: null, courses: [], coursesWithIssues: 0 };
    const rows = await this.d.store.courseAttendanceStats(actor.departmentId, term, this.d.now());
    const courses = rows.map((r) => {
      const percentage = pct(r.attendanceRecords, r.sessionsHeld * r.enrolled);
      return { courseId: r.courseId, courseCode: r.courseCode, title: r.title, sessionsHeld: r.sessionsHeld, enrolled: r.enrolled, attendancePercentage: percentage, attendanceIssue: hasAttendanceIssue(percentage, r.sessionsHeld) };
    }).sort((a, b) => (a.attendancePercentage ?? 101) - (b.attendancePercentage ?? 101));
    const totalPossible = rows.reduce((a, r) => a + r.sessionsHeld * r.enrolled, 0);
    return {
      term: { academicSession: term.academicSession, semester: term.semester }, overallAttendancePercentage: pct(rows.reduce((a, r) => a + r.attendanceRecords, 0), totalPossible),
      courses, coursesWithIssues: courses.filter((c) => c.attendanceIssue).length,
    };
  }

  /* ------------------------------ complaints ------------------------------ */
  private complaintDTO(c: ComplaintRec, detail = false) {
    return {
      id: c.id, referenceNumber: c.referenceNumber, type: c.type, category: c.type === "COURSE" ? "COURSE" : "DEPARTMENT", title: c.title, ...(detail ? { description: c.message } : {}),
      student: { id: c.studentId, name: c.studentName, matricNumber: c.matricNumber }, course: c.courseId ? { id: c.courseId, courseCode: c.courseCode, title: c.courseTitle ?? null } : null,
      status: c.status, assignedTo: c.assignedLecturer ?? null, assignedAt: c.assignedAt ?? null, resolution: c.resolution ?? null, resolvedAt: c.resolvedAt ?? null, createdAt: c.createdAt, updatedAt: c.updatedAt,
      ...(detail ? { timeline: c.timeline.map((e) => ({ status: e.status, label: e.label, note: e.note ?? null, at: e.at, by: e.byRole ?? null, byName: e.byName ?? null, internal: e.internal ?? false })), attachments: c.attachments.map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, sizeBytes: a.sizeBytes, url: this.d.signPrivateFile({ publicId: a.publicId, resourceType: a.resourceType }) })) } : {}),
    };
  }
  async listComplaints(actor: HodActor, q: Parameters<HodStore["listComplaints"]>[1]) {
    return paged(q, await this.d.store.listComplaints(actor.departmentId, q), (c) => this.complaintDTO(c));
  }
  private async loadComplaint(actor: HodActor, id: string, m: HodMeta) {
    return (await this.d.store.getComplaint(actor.departmentId, id)) ?? this.notFound(actor, m, "Complaint", "COMPLAINT", id);
  }
  async getComplaint(actor: HodActor, id: string, m: HodMeta = {}) { return this.complaintDTO(await this.loadComplaint(actor, id, m), true); }

  private label(s: ComplaintStatusName) {
    return ({ SUBMITTED: "Complaint submitted", PENDING: "Pending", UNDER_REVIEW: "Under review by the HOD", ASSIGNED: "Forwarded to a lecturer", IN_PROGRESS: "In progress", RESOLVED: "Resolved", REJECTED: "Rejected", CLOSED: "Closed" } as const)[s];
  }
  /** Review / progress / resolve / reject / close. Resolve needs a resolution text and reject needs a reason; the student sees both on the timeline. */
  async setComplaintStatus(actor: HodActor, id: string, input: { status: ComplaintStatusName; note?: string; resolution?: string }, m: HodMeta = {}) {
    const c = await this.loadComplaint(actor, id, m);
    const problem = checkComplaintTransition(c.status, input.status, "status");
    if (problem) throw new AppError(409, problem, undefined, "COMPLAINT_TRANSITION_REFUSED");
    if (input.status === "RESOLVED" && !input.resolution?.trim()) throw new AppError(422, "A resolution message is required to resolve a complaint.", undefined, "RESOLUTION_REQUIRED");
    if (input.status === "REJECTED" && !input.note?.trim()) throw new AppError(422, "Give the student a reason when rejecting a complaint.", undefined, "REASON_REQUIRED");
    const now = this.d.now();
    const patch: ComplaintPatch = { status: input.status, reviewedByHodId: actor.hodId, ...(input.status === "RESOLVED" ? { resolution: input.resolution, resolvedAt: now } : {}) };
    const next = await this.d.store.updateComplaint(actor.departmentId, id, patch, { status: input.status, label: this.label(input.status), note: input.status === "RESOLVED" ? input.resolution : input.note, at: now, byRole: "HOD" });
    if (!next) return this.notFound(actor, m, "Complaint", "COMPLAINT", id);
    await this.audit(actor, m, input.status === "RESOLVED" ? "COMPLAINT_RESOLVED" : "COMPLAINT_STATUS_CHANGED", { resourceType: "COMPLAINT", resourceId: id, detail: { reference: c.referenceNumber, from: c.status, to: input.status } });
    await this.safe(() => this.d.notifyStudent(c.studentId, actor.departmentId, {
      kind: input.status === "RESOLVED" ? "RESOLVED" : "STATUS_CHANGED", title: `Complaint ${c.referenceNumber}: ${this.label(input.status)}`,
      body: (input.status === "RESOLVED" ? input.resolution : input.note) ?? "Your complaint status was updated.", link: "/student/complaints",
    }));
    return this.complaintDTO(next, true);
  }
  /** Forwards the complaint to a lecturer of this department (for a course complaint, one assigned to that course this term). */
  async assignComplaint(actor: HodActor, id: string, input: { lecturerId: string; note?: string }, m: HodMeta = {}) {
    const c = await this.loadComplaint(actor, id, m);
    const transition = checkComplaintTransition(c.status, "ASSIGNED", "assign");
    if (transition) throw new AppError(409, transition, undefined, "COMPLAINT_TRANSITION_REFUSED");
    const lecturer = await this.d.store.getLecturer(actor.departmentId, input.lecturerId); // department filter: another department's lecturer is "not found"
    const problem = checkComplaintAssignee({
      lecturerFound: Boolean(lecturer), lecturerStatus: lecturer?.status, hasCourse: Boolean(c.courseId),
      lecturerOnCourse: lecturer && c.courseId ? await this.d.store.hasActiveLecturerAssignment(actor.departmentId, lecturer.id, c.courseId) : false,
    });
    if (problem) throw new AppError(422, problem, undefined, "ASSIGNEE_REFUSED");
    const now = this.d.now();
    const next = await this.d.store.updateComplaint(actor.departmentId, id, { status: "ASSIGNED", assignedLecturerId: input.lecturerId, assignedAt: now, reviewedByHodId: actor.hodId }, { status: "ASSIGNED", label: this.label("ASSIGNED"), note: input.note, at: now, byRole: "HOD" });
    if (!next) return this.notFound(actor, m, "Complaint", "COMPLAINT", id);
    await this.audit(actor, m, "COMPLAINT_ASSIGNED", { resourceType: "COMPLAINT", resourceId: id, detail: { reference: c.referenceNumber, lecturerId: input.lecturerId } });
    await this.safe(() => this.d.notifyLecturer(input.lecturerId, actor.departmentId, { kind: "SYSTEM", title: `Complaint ${c.referenceNumber} forwarded to you`, body: c.title, link: "/lecturer/complaints" }));
    await this.safe(() => this.d.notifyStudent(c.studentId, actor.departmentId, { kind: "ASSIGNED", title: `Complaint ${c.referenceNumber}: forwarded to a lecturer`, body: input.note ?? "Your complaint was forwarded for action.", link: "/student/complaints" }));
    return this.complaintDTO(next, true);
  }
  /** Writes a reply the student can read. A first reply moves a new complaint to UNDER_REVIEW. */
  async respondToComplaint(actor: HodActor, id: string, input: { message: string }, m: HodMeta = {}) {
    const c = await this.loadComplaint(actor, id, m);
    if (isClosedComplaint(c.status)) throw new AppError(409, "This complaint is closed.", undefined, "COMPLAINT_CLOSED");
    const now = this.d.now();
    const moveToReview = c.status === "SUBMITTED" || c.status === "PENDING";
    const event = { status: (moveToReview ? "UNDER_REVIEW" : c.status) as ComplaintStatusName, label: "Response from the HOD", note: input.message, at: now, byRole: "HOD" };
    const next = moveToReview
      ? await this.d.store.updateComplaint(actor.departmentId, id, { status: "UNDER_REVIEW", reviewedByHodId: actor.hodId }, event)
      : await this.d.store.addComplaintEvent(actor.departmentId, id, event);
    if (!next) return this.notFound(actor, m, "Complaint", "COMPLAINT", id);
    await this.audit(actor, m, "COMPLAINT_RESPONDED", { resourceType: "COMPLAINT", resourceId: id, detail: { reference: c.referenceNumber } });
    await this.safe(() => this.d.notifyStudent(c.studentId, actor.departmentId, { kind: "RESPONSE", title: `Complaint ${c.referenceNumber}: response from the HOD`, body: input.message.slice(0, 200), link: "/student/complaints" }));
    return this.complaintDTO(next, true);
  }

  /* ------------------------------ notifications ------------------------------ */
  async listNotifications(actor: HodActor, q: { page: number; limit: number; unread?: boolean }) {
    const r = await this.d.store.listNotifications(actor.hodId, q);
    return { items: r.items, unreadCount: r.unread, ...meta(q, r.total) };
  }
  async markNotificationRead(actor: HodActor, id: string) {
    const n = await this.d.store.markNotificationRead(actor.hodId, id); // the HOD is part of the query: someone else's id is just "not found"
    if (!n) throw new AppError(404, "Notification not found.", undefined, "NOT_FOUND");
    return n;
  }
  async markAllNotificationsRead(actor: HodActor) { return { updated: await this.d.store.markAllNotificationsRead(actor.hodId) }; }

  private async safe(fn: () => Promise<unknown>) { try { await fn(); } catch { /* notifications are best-effort */ } }
}
