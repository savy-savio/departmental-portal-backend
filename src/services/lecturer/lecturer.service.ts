import { AppError } from "../../utils/AppError";
import { hashAttendanceCode } from "../../utils/crypto";
import { sniffImage } from "../../utils/image";
import { SESSION_LIMITS, validateSessionInput } from "../attendance/session-rules";
import type {
  AnnouncementRec, AttendanceRecordView, CourseRec, CourseWorkRec, LecturerActor, LecturerAssignmentRec, LecturerMeta,
  LecturerComplaintRec, LecturerComplaintQuery, LecturerSessionRec, MaterialRec, StoredFile, TimetableRec,
} from "./types";
import { checkLecturerComplaintStatus, isLecturerAssignmentCurrent, LECTURER_ACTIONABLE_COMPLAINT, LECTURER_RESPONDABLE_COMPLAINT, MAX_DASHBOARD_ITEMS } from "./policy";
import type { ComplaintStatusName } from "../hod/policy";
import type { LecturerStore } from "./store";

export interface LecturerDeps {
  store: LecturerStore;
  now: () => Date;
  /** How accurate the lecturer's own location must be to set a venue (metres). Defaults to SESSION_LIMITS.maxCreatorAccuracyMeters. */
  maxCreatorAccuracyMeters?: number;
  /** Notify the students enrolled in a course (best-effort). */
  notifyClass: (course: CourseRec, n: { kind: "ANNOUNCEMENT" | "MATERIAL" | "ASSIGNMENT"; title: string; body: string; link?: string }) => Promise<void>;
  /** Validates the real file type and stores it publicly (official materials, assignment briefs). */
  uploadFile: (f: { buffer: Buffer; originalName: string }) => Promise<StoredFile>;
  deleteFile: (f: StoredFile) => Promise<void>;
  /** Stores / removes an announcement picture (the service has already verified the bytes are a real image). */
  uploadAnnouncementImage: (buffer: Buffer) => Promise<{ url: string; publicId: string }>;
  deleteAnnouncementImage: (publicId: string) => Promise<void>;
  uploadAvatar: (buffer: Buffer, lecturerId: string) => Promise<{ url: string; publicId: string }>;
  deleteAvatar: (publicId: string) => Promise<void>;
  /** Signed, private link for a student's submission file (also used for complaint attachments). */
  signSubmissionFile: (f: { publicId: string; resourceType: "image" | "raw" }) => string;
  /** Best-effort: tell the department's HOD (who owns the final decision) about a lecturer action on a complaint. */
  notifyHod: (departmentId: string, n: ComplaintNotice & { complaintId: string }) => Promise<void>;
  notifyStudent: (studentId: string, departmentId: string, n: ComplaintNotice) => Promise<void>;
}
export interface ComplaintNotice { kind: "RESPONSE" | "STATUS_CHANGED"; title: string; body: string; link?: string }

export interface AnnouncementInput { courseId: string; title: string; content: string; priority?: "NORMAL" | "IMPORTANT" | "URGENT"; published?: boolean; expiresAt?: Date; image?: Buffer }
export interface AnnouncementPatch { title?: string; content?: string; priority?: "NORMAL" | "IMPORTANT" | "URGENT"; published?: boolean; expiresAt?: Date | null; image?: Buffer; removeImage?: boolean }
export interface MaterialInput { title: string; description?: string; published?: boolean; fileUrl?: string; file?: { buffer: Buffer; originalName: string } }
export interface MaterialPatch { title?: string; description?: string; published?: boolean }
export interface CourseWorkInput { title: string; description: string; dueDate: Date; allowLateSubmission?: boolean; published?: boolean; fileUrl?: string; file?: { buffer: Buffer; originalName: string } }
export interface CourseWorkPatch { title?: string; description?: string; dueDate?: Date; allowLateSubmission?: boolean; published?: boolean; fileUrl?: string | null }
export interface SessionInput {
  title?: string; latitude: number; longitude: number; allowedRadiusInMeters: number;
  /** `coords.accuracy` from the browser Geolocation API when the lecturer captured the venue. */
  accuracyMeters?: number;
  startTime?: Date; endTime?: Date; durationMinutes?: number; lateAfterMinutes?: number; code?: string;
}

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const fullName = (a: { firstName: string; lastName?: string }) => `${a.firstName} ${a.lastName ?? ""}`.trim();
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

/**
 * Lecturer engine. Authority is ONLY an ACTIVE LecturerCourseAssignment in the department's CURRENT term, read from the database
 * on every call (nothing cached, so a revoked assignment stops working immediately).
 * Ids from the request are only ever checked against that, never trusted:
 *   course-level routes  -> NOT_ASSIGNED_TO_COURSE (same answer for "not yours", "other department" and "doesn't exist")
 *   resource-id routes   -> 404 when outside the lecturer's courses, 403 NOT_OWNER when it is a colleague's item in the same course.
 */
export class LecturerService {
  constructor(private readonly d: LecturerDeps) {}

  /* ------------------------------ authority ------------------------------ */
  async currentAssignments(actor: LecturerActor): Promise<LecturerAssignmentRec[]> {
    const term = await this.d.store.getCurrentTerm(actor.departmentId);
    if (!term) return [];
    const all = await this.d.store.assignmentsForLecturer(actor.lecturerId);
    return all.filter((a) => isLecturerAssignmentCurrent(a, actor, term));
  }

  private async audit(actor: LecturerActor, meta: LecturerMeta, action: string, x: { courseId?: string; courseCode?: string; resourceType?: "ANNOUNCEMENT" | "MATERIAL" | "ASSIGNMENT" | "ATTENDANCE_SESSION" | "COURSE" | "LECTURER" | "COMPLAINT"; resourceId?: string; detail?: Record<string, unknown> } = {}) {
    try {
      await this.d.store.addAudit({
        actorId: actor.lecturerId, actorName: fullName(actor), role: "LECTURER", action, resourceType: x.resourceType, resourceId: x.resourceId,
        courseId: x.courseId, courseCode: x.courseCode, departmentId: actor.departmentId, ip: meta.ip, detail: x.detail, at: this.d.now(),
      });
    } catch {
      /* the audit trail must not turn a correct decision into a 500 */
    }
  }

  private async deny(actor: LecturerActor, meta: LecturerMeta, code: string, status: number, message: string, x: { courseId?: string; attempted?: string } = {}): Promise<never> {
    await this.audit(actor, meta, "ACCESS_DENIED", { courseId: x.courseId, resourceType: "COURSE", detail: { reason: code, attempted: x.attempted } });
    throw new AppError(status, message, undefined, code);
  }

  /** Steps 5-7 of the authorization chain for a course id taken from the request. */
  async authorizeCourse(actor: LecturerActor, courseId: string, meta: LecturerMeta = {}): Promise<{ assignment: LecturerAssignmentRec; course: CourseRec; assignments: LecturerAssignmentRec[] }> {
    const assignments = await this.currentAssignments(actor);
    const assignment = assignments.find((a) => a.courseId === courseId);
    if (!assignment) return this.deny(actor, meta, "NOT_ASSIGNED_TO_COURSE", 403, "You are not assigned to that course.", { courseId });
    const course = await this.d.store.getCourse(courseId, actor.departmentId); // department filter again
    if (!course) throw new AppError(404, "Course not found.", undefined, "NOT_FOUND");
    return { assignment, course, assignments };
  }

  /** For records that carry a course code + term: the lecturer must be assigned to that course in that term. */
  private assignmentFor(assignments: LecturerAssignmentRec[], rec: { courseCode?: string; academicSession: string; semester: string }) {
    return assignments.find((a) => a.courseCode === rec.courseCode && a.academicSession === rec.academicSession && a.semester === rec.semester);
  }

  private async notFound(actor: LecturerActor, meta: LecturerMeta, resourceType: "ANNOUNCEMENT" | "MATERIAL" | "ASSIGNMENT" | "ATTENDANCE_SESSION" | "COMPLAINT", id: string): Promise<never> {
    await this.audit(actor, meta, "ACCESS_DENIED", { resourceType, resourceId: id, detail: { reason: "OUT_OF_SCOPE" } });
    throw new AppError(404, `${resourceType === "ATTENDANCE_SESSION" ? "Attendance session" : resourceType[0] + resourceType.slice(1).toLowerCase()} not found.`, undefined, "NOT_FOUND");
  }

  private async requireOwner(actor: LecturerActor, meta: LecturerMeta, ownerId: string | undefined, courseId: string | undefined): Promise<void> {
    if (ownerId !== actor.lecturerId) await this.deny(actor, meta, "NOT_OWNER", 403, "You can only change items you created.", { courseId });
  }

  private async notifySafely(course: CourseRec, n: Parameters<LecturerDeps["notifyClass"]>[1]) {
    try {
      await this.d.notifyClass(course, n);
    } catch {
      /* best-effort */
    }
  }

  /* ------------------------------ profile ------------------------------ */
  private profileDTO(l: NonNullable<Awaited<ReturnType<LecturerStore["getLecturer"]>>>, dept: { id: string; name: string; code: string } | null) {
    return {
      id: l.id, firstName: l.firstName, lastName: l.lastName, name: fullName(l), email: l.email, phone: l.phone ?? null, staffId: l.staffId,
      role: l.role, status: l.status, profilePhoto: l.profilePhoto ?? null, department: dept,
    };
  }
  async getProfile(actor: LecturerActor) {
    const [l, dept] = await Promise.all([this.d.store.getLecturer(actor.lecturerId), this.d.store.getDepartment(actor.departmentId)]);
    if (!l) throw new AppError(401, "Authentication required.");
    return this.profileDTO(l, dept);
  }
  /** Only the phone can be edited here. Name, email, staff id, department and role are managed by the department (HOD) so they stay authoritative. */
  async updateProfile(actor: LecturerActor, patch: { phone?: string | null }, meta: LecturerMeta = {}) {
    const l = await this.d.store.updateLecturerProfile(actor.lecturerId, { phone: patch.phone });
    if (!l) throw new AppError(401, "Authentication required.");
    await this.audit(actor, meta, "PROFILE_UPDATED", { resourceType: "LECTURER", resourceId: actor.lecturerId, detail: { fields: Object.keys(patch) } });
    return this.profileDTO(l, await this.d.store.getDepartment(actor.departmentId));
  }
  async setProfilePhoto(actor: LecturerActor, buffer: Buffer, meta: LecturerMeta = {}) {
    const current = await this.d.store.getLecturer(actor.lecturerId);
    if (!current) throw new AppError(401, "Authentication required.");
    const previousPublicId = current.profilePhotoPublicId; // read BEFORE updating so we never delete the new image
    const saved = await this.d.uploadAvatar(buffer, actor.lecturerId);
    const l = await this.d.store.updateLecturerProfile(actor.lecturerId, { profilePhoto: saved.url, profilePhotoPublicId: saved.publicId });
    if (previousPublicId && previousPublicId !== saved.publicId) await this.d.deleteAvatar(previousPublicId).catch(() => undefined);
    await this.audit(actor, meta, "PROFILE_UPDATED", { resourceType: "LECTURER", resourceId: actor.lecturerId, detail: { fields: ["profilePhoto"] } });
    return this.profileDTO(l!, await this.d.store.getDepartment(actor.departmentId));
  }

  /* ------------------------------ courses ------------------------------ */
  private courseDTO(c: CourseRec, extra: Record<string, unknown> = {}) {
    return { id: c.id, courseCode: c.courseCode, title: c.title, units: c.units, level: c.level, semester: c.semester, academicSession: c.academicSession, ...extra };
  }
  async listCourses(actor: LecturerActor) {
    const assignments = await this.currentAssignments(actor);
    const names = await this.d.store.courseLecturers(actor.departmentId, assignments.map((a) => a.courseId));
    const out = [];
    for (const a of assignments) {
      const c = await this.d.store.getCourse(a.courseId, actor.departmentId);
      if (c) out.push(this.courseDTO(c, { lecturers: names.get(c.id) ?? [], enrolledCount: await this.d.store.countMembers(c), assignedAt: a.assignedAt }));
    }
    return out;
  }
  async getCourse(actor: LecturerActor, courseId: string, meta: LecturerMeta = {}) {
    const { course } = await this.authorizeCourse(actor, courseId, meta);
    const [enrolled, materials, work, sessions, schedule, names] = await Promise.all([
      this.d.store.countMembers(course), this.d.store.listOfficialMaterials([course]), this.d.store.listCourseWork([courseId]),
      this.d.store.listAttendanceSessions(course), this.d.store.listTimetable([course]), this.d.store.courseLecturers(actor.departmentId, [courseId]),
    ]);
    return this.courseDTO(course, {
      lecturers: names.get(course.id) ?? [], // every lecturer on this course, so co-lecturers see each other
      enrolledCount: enrolled,
      counts: { officialMaterials: materials.length, assignments: work.length, attendanceSessions: sessions.length },
      schedule: schedule.filter((t) => t.status !== "DRAFT").sort((a, b) => DAYS.indexOf(a.dayOfWeek) - DAYS.indexOf(b.dayOfWeek) || a.startTime.localeCompare(b.startTime))
        .map((t) => ({ id: t.id, dayOfWeek: t.dayOfWeek, date: t.date ?? null, startTime: t.startTime, endTime: t.endTime, venue: t.venue ?? null })),
    });
  }

  /** Read-only. Name, matric, photo, level and enrollment type; no email / phone, and nothing here can change a student record. */
  async listStudents(actor: LecturerActor, courseId: string, q: { page: number; limit: number; search?: string }, meta: LecturerMeta = {}) {
    const { course } = await this.authorizeCourse(actor, courseId, meta);
    const { items, total } = await this.d.store.listMembers(course, q);
    return {
      course: { id: course.id, courseCode: course.courseCode },
      items: items.map((m) => ({ studentId: m.studentId, firstName: m.firstName, lastName: m.lastName, matricNumber: m.matricNumber, profilePhoto: m.profilePhoto ?? null, level: m.level, enrollmentType: m.enrollmentType })),
      page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)),
    };
  }

  /* ------------------------------ timetable (view only) ------------------------------ */
  /** Lecturers can only VIEW schedules (official and the Course Rep's class timetable). There is no write method on purpose. */
  async getTimetable(actor: LecturerActor, q: { courseId?: string }, meta: LecturerMeta = {}) {
    const assignments = await this.currentAssignments(actor);
    const scoped = q.courseId ? [(await this.authorizeCourse(actor, q.courseId, meta)).assignment] : assignments;
    const courses: CourseRec[] = [];
    for (const a of scoped) {
      const c = await this.d.store.getCourse(a.courseId, actor.departmentId);
      if (c) courses.push(c);
    }
    const rows: TimetableRec[] = await this.d.store.listTimetable(courses);
    const entries = rows.filter((t) => t.status !== "DRAFT")
      .sort((a, b) => DAYS.indexOf(a.dayOfWeek) - DAYS.indexOf(b.dayOfWeek) || a.startTime.localeCompare(b.startTime))
      .map((t) => ({ id: t.id, courseCode: t.courseCode ?? null, title: t.title, type: t.type, dayOfWeek: t.dayOfWeek, date: t.date ?? null, startTime: t.startTime, endTime: t.endTime, venue: t.venue ?? null, lecturerName: t.lecturerName ?? null, source: t.source, status: t.status }));
    return { readOnly: true, entries };
  }

  /* ------------------------------ official materials ------------------------------ */
  private materialDTO(m: MaterialRec, actor: LecturerActor) {
    const mine = m.lecturerId === actor.lecturerId;
    return {
      id: m.id, courseId: m.courseId ?? null, courseCode: m.courseCode, academicSession: m.academicSession, semester: m.semester, title: m.title,
      description: m.description ?? null, file: { url: m.file.url, name: m.file.originalName, mimeType: m.file.mimeType, sizeBytes: m.file.sizeBytes },
      published: m.status === "PUBLISHED", uploadedBy: m.uploadedByName, mine, canEdit: mine, canDelete: mine, createdAt: m.createdAt, updatedAt: m.updatedAt,
    };
  }
  async listMaterials(actor: LecturerActor, courseId: string, meta: LecturerMeta = {}) {
    const { course } = await this.authorizeCourse(actor, courseId, meta);
    return (await this.d.store.listOfficialMaterials([course])).map((m) => this.materialDTO(m, actor));
  }
  async createMaterial(actor: LecturerActor, courseId: string, input: MaterialInput, meta: LecturerMeta = {}) {
    const { course } = await this.authorizeCourse(actor, courseId, meta);
    if (Boolean(input.file) === Boolean(input.fileUrl)) throw new AppError(422, "Provide either a file or a link, not both.", undefined, "INVALID_RESOURCE_SOURCE");
    const file = input.file ? await this.d.uploadFile(input.file) : { url: input.fileUrl as string, originalName: input.title, mimeType: "text/uri-list", sizeBytes: 0 };
    const published = input.published ?? true;
    const rec = await this.d.store.createMaterial({
      departmentId: course.departmentId, courseId: course.id, courseCode: course.courseCode, level: course.level, academicSession: course.academicSession, semester: course.semester,
      title: input.title, description: input.description, type: "OFFICIAL_COURSE_MATERIAL", file, lecturerId: actor.lecturerId,
      uploadedByName: fullName(actor), uploadedByRole: "LECTURER", status: published ? "PUBLISHED" : "HIDDEN",
    });
    await this.audit(actor, meta, "MATERIAL_UPLOADED", { courseId: course.id, courseCode: course.courseCode, resourceType: "MATERIAL", resourceId: rec.id, detail: { title: rec.title, published } });
    if (published) await this.notifySafely(course, { kind: "MATERIAL", title: `${course.courseCode}: new course material`, body: rec.title, link: "/student/materials" });
    return this.materialDTO(rec, actor);
  }
  /** Only OFFICIAL materials this lecturer published, in a course they are still assigned to. Representatives' class resources are a different record type and never reach here. */
  private async loadOwnMaterial(actor: LecturerActor, id: string, meta: LecturerMeta) {
    const assignments = await this.currentAssignments(actor);
    const rec = await this.d.store.getMaterial(id, actor.departmentId);
    const a = rec ? this.assignmentFor(assignments, rec) : undefined;
    if (!rec || !a || rec.type !== "OFFICIAL_COURSE_MATERIAL") return this.notFound(actor, meta, "MATERIAL", id);
    await this.requireOwner(actor, meta, rec.lecturerId, a.courseId);
    const course = await this.d.store.getCourse(a.courseId, actor.departmentId);
    if (!course) return this.notFound(actor, meta, "MATERIAL", id);
    return { rec, course };
  }
  async updateMaterial(actor: LecturerActor, id: string, patch: MaterialPatch, meta: LecturerMeta = {}) {
    const { rec, course } = await this.loadOwnMaterial(actor, id, meta);
    const publishing = patch.published === true && rec.status !== "PUBLISHED";
    const next = await this.d.store.updateMaterial(id, {
      ...(patch.title !== undefined && { title: patch.title }), ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.published !== undefined && { status: patch.published ? "PUBLISHED" : "HIDDEN" }),
    });
    if (!next) return this.notFound(actor, meta, "MATERIAL", id);
    await this.audit(actor, meta, "MATERIAL_UPDATED", { courseId: course.id, courseCode: course.courseCode, resourceType: "MATERIAL", resourceId: id, detail: { fields: Object.keys(patch) } });
    if (publishing) await this.notifySafely(course, { kind: "MATERIAL", title: `${course.courseCode}: new course material`, body: next.title, link: "/student/materials" });
    return this.materialDTO(next, actor);
  }
  async deleteMaterial(actor: LecturerActor, id: string, meta: LecturerMeta = {}) {
    const { rec, course } = await this.loadOwnMaterial(actor, id, meta);
    await this.d.store.deleteMaterial(id);
    if (rec.file.publicId) await this.d.deleteFile(rec.file).catch(() => undefined);
    await this.audit(actor, meta, "MATERIAL_DELETED", { courseId: course.id, courseCode: course.courseCode, resourceType: "MATERIAL", resourceId: id, detail: { title: rec.title } });
  }

  /* ------------------------------ announcements ------------------------------ */
  private announcementDTO(a: AnnouncementRec, actor: LecturerActor) {
    const mine = a.lecturerId === actor.lecturerId;
    return {
      id: a.id, courseId: a.courseId, courseCode: a.courseCode, academicSession: a.academicSession, semester: a.semester, title: a.title, content: a.body,
      priority: a.priority, published: a.status === "PUBLISHED", status: a.status, image: a.image ? { url: a.image.url } : null, author: { name: a.authorName, role: a.authorRole }, mine, canEdit: mine, canDelete: mine,
      publishedAt: a.publishedAt ?? null, expiresAt: a.expiresAt ?? null, createdAt: a.createdAt, updatedAt: a.updatedAt,
    };
  }
  async listAnnouncements(actor: LecturerActor, q: { courseId?: string }, meta: LecturerMeta = {}) {
    const assignments = await this.currentAssignments(actor);
    const scoped = q.courseId ? [(await this.authorizeCourse(actor, q.courseId, meta)).assignment] : assignments;
    // Lecturers see lecturers' announcements only (their own and colleagues' on the same course); a course representative's announcement is never shown.
    return (await this.d.store.listAnnouncements(scoped.map((a) => a.courseId), actor.lecturerId)).filter((a) => Boolean(a.lecturerId)).map((a) => this.announcementDTO(a, actor));
  }
  /** The audience is always exactly the assigned course's class: there is no system-wide or cross-course announcement. */
  async createAnnouncement(actor: LecturerActor, input: AnnouncementInput, meta: LecturerMeta = {}) {
    const { course } = await this.authorizeCourse(actor, input.courseId, meta);
    const published = input.published ?? true;
    this.checkAnnouncementImage(input.image);
    const image = input.image ? await this.d.uploadAnnouncementImage(input.image) : undefined;
    const rec = await this.d.store.createAnnouncement({
      departmentId: course.departmentId, courseId: course.id, courseCode: course.courseCode, level: course.level, academicSession: course.academicSession, semester: course.semester,
      title: input.title, body: input.content, priority: input.priority ?? "NORMAL", status: published ? "PUBLISHED" : "DRAFT", image,
      lecturerId: actor.lecturerId, authorName: fullName(actor), authorRole: "LECTURER", publishedAt: published ? this.d.now() : undefined, expiresAt: input.expiresAt,
    }).catch(async (err) => { if (image) await this.d.deleteAnnouncementImage(image.publicId).catch(() => undefined); throw err; });
    await this.audit(actor, meta, "ANNOUNCEMENT_CREATED", { courseId: course.id, courseCode: course.courseCode, resourceType: "ANNOUNCEMENT", resourceId: rec.id, detail: { title: rec.title, published, withImage: Boolean(image) } });
    if (published) await this.notifySafely(course, { kind: "ANNOUNCEMENT", title: `${course.courseCode}: ${rec.title}`, body: rec.body.slice(0, 200), link: "/student/announcements" });
    return this.announcementDTO(rec, actor);
  }
  private checkAnnouncementImage(buffer?: Buffer) {
    if (buffer && !sniffImage(buffer)) throw new AppError(415, "Only JPEG, PNG or WebP images can be attached.", undefined, "UNSUPPORTED_FILE_TYPE");
  }
  private async loadOwnAnnouncement(actor: LecturerActor, id: string, meta: LecturerMeta) {
    const assignments = await this.currentAssignments(actor);
    const rec = await this.d.store.getAnnouncement(id, actor.departmentId);
    // A rep's (student-written) announcement is invisible to lecturers: the same 404 as an id that doesn't exist.
    const a = rec && rec.status !== "DELETED" && rec.lecturerId ? this.assignmentFor(assignments, rec) : undefined;
    if (!rec || !a) return this.notFound(actor, meta, "ANNOUNCEMENT", id);
    await this.requireOwner(actor, meta, rec.lecturerId, a.courseId);
    const course = await this.d.store.getCourse(a.courseId, actor.departmentId);
    if (!course) return this.notFound(actor, meta, "ANNOUNCEMENT", id);
    return { rec, course };
  }
  async updateAnnouncement(actor: LecturerActor, id: string, patch: AnnouncementPatch, meta: LecturerMeta = {}) {
    if (!Object.values(patch).some((v) => v !== undefined)) throw new AppError(422, "Provide at least one field to update.", undefined, "NOTHING_TO_UPDATE");
    const { rec, course } = await this.loadOwnAnnouncement(actor, id, meta);
    this.checkAnnouncementImage(patch.image);
    const previousImageId = rec.image?.publicId; // read BEFORE the write: it must be the old picture that gets deleted
    const newImage = patch.image ? await this.d.uploadAnnouncementImage(patch.image) : undefined;
    const nowPublishing = patch.published === true && rec.status !== "PUBLISHED";
    const status = patch.published === undefined ? undefined : patch.published ? "PUBLISHED" : rec.status === "DRAFT" ? "DRAFT" : "UNPUBLISHED";
    const next = await this.d.store.updateAnnouncement(id, {
      ...(patch.title !== undefined && { title: patch.title }), ...(patch.content !== undefined && { body: patch.content }),
      ...(patch.priority !== undefined && { priority: patch.priority }), ...(patch.expiresAt !== undefined && { expiresAt: patch.expiresAt }),
      ...(status && { status }), ...(nowPublishing && { publishedAt: this.d.now() }),
      ...(newImage ? { image: newImage } : patch.removeImage ? { image: null } : {}),
    }).catch(async (err) => { if (newImage) await this.d.deleteAnnouncementImage(newImage.publicId).catch(() => undefined); throw err; });
    if (!next) { if (newImage) await this.d.deleteAnnouncementImage(newImage.publicId).catch(() => undefined); return this.notFound(actor, meta, "ANNOUNCEMENT", id); }
    if ((newImage || patch.removeImage) && previousImageId) await this.d.deleteAnnouncementImage(previousImageId).catch(() => undefined);
    await this.audit(actor, meta, patch.published === false ? "ANNOUNCEMENT_UNPUBLISHED" : "ANNOUNCEMENT_UPDATED", { courseId: course.id, courseCode: course.courseCode, resourceType: "ANNOUNCEMENT", resourceId: id, detail: { fields: Object.keys(patch).filter((k) => k !== "image"), image: newImage ? "replaced" : patch.removeImage ? "removed" : undefined } });
    if (nowPublishing) await this.notifySafely(course, { kind: "ANNOUNCEMENT", title: `${course.courseCode}: ${next.title}`, body: next.body.slice(0, 200), link: "/student/announcements" });
    return this.announcementDTO(next, actor);
  }
  async deleteAnnouncement(actor: LecturerActor, id: string, meta: LecturerMeta = {}) {
    const { rec, course } = await this.loadOwnAnnouncement(actor, id, meta);
    const previousImageId = rec.image?.publicId;
    await this.d.store.updateAnnouncement(id, { status: "DELETED", ...(rec.image ? { image: null } : {}) }); // soft delete: kept for the audit trail; the picture is removed from storage
    if (previousImageId) await this.d.deleteAnnouncementImage(previousImageId).catch(() => undefined);
    await this.audit(actor, meta, "ANNOUNCEMENT_DELETED", { courseId: course.id, courseCode: course.courseCode, resourceType: "ANNOUNCEMENT", resourceId: id, detail: { title: rec.title } });
  }

  /* ------------------------------ assignments (no grading in this phase) ------------------------------ */
  private async courseWorkDTO(w: CourseWorkRec, actor: LecturerActor) {
    const submissions = await this.d.store.countSubmissions(w.id);
    const mine = w.lecturerId === actor.lecturerId;
    return {
      id: w.id, courseId: w.courseId, courseCode: w.courseCode, academicSession: w.academicSession, semester: w.semester, title: w.title, description: w.description,
      dueDate: w.dueAt, allowLateSubmission: w.allowLateSubmission, published: w.status === "PUBLISHED", status: w.status,
      attachment: w.attachment ? { url: w.attachment.url, name: w.attachment.originalName } : null, submissionCount: submissions, mine, canEdit: mine, canDelete: mine,
      createdAt: w.createdAt, updatedAt: w.updatedAt,
    };
  }
  async listCourseWork(actor: LecturerActor, q: { courseId?: string }, meta: LecturerMeta = {}) {
    const assignments = await this.currentAssignments(actor);
    const scoped = q.courseId ? [(await this.authorizeCourse(actor, q.courseId, meta)).assignment] : assignments;
    const rows = await this.d.store.listCourseWork(scoped.map((a) => a.courseId));
    return Promise.all(rows.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime()).map((w) => this.courseWorkDTO(w, actor)));
  }
  async createCourseWork(actor: LecturerActor, courseId: string, input: CourseWorkInput, meta: LecturerMeta = {}) {
    const { course } = await this.authorizeCourse(actor, courseId, meta);
    if (input.dueDate.getTime() <= this.d.now().getTime()) throw new AppError(422, "The due date must be in the future.", undefined, "INVALID_DUE_DATE");
    if (input.file && input.fileUrl) throw new AppError(422, "Provide either a file or a link, not both.", undefined, "INVALID_RESOURCE_SOURCE");
    const attachment = input.file ? await this.d.uploadFile(input.file) : input.fileUrl ? { url: input.fileUrl, originalName: input.title, mimeType: "text/uri-list", sizeBytes: 0 } : undefined;
    const published = input.published ?? false;
    const rec = await this.d.store.createCourseWork({
      departmentId: course.departmentId, courseId: course.id, courseCode: course.courseCode, level: course.level, academicSession: course.academicSession, semester: course.semester,
      title: input.title, description: input.description, dueAt: input.dueDate, allowLateSubmission: input.allowLateSubmission ?? false, attachment,
      status: published ? "PUBLISHED" : "DRAFT", lecturerId: actor.lecturerId, authorName: fullName(actor),
    });
    await this.audit(actor, meta, "ASSIGNMENT_CREATED", { courseId: course.id, courseCode: course.courseCode, resourceType: "ASSIGNMENT", resourceId: rec.id, detail: { title: rec.title, published } });
    if (published) await this.notifySafely(course, { kind: "ASSIGNMENT", title: `${course.courseCode}: new assignment`, body: rec.title, link: "/student/assignments" });
    return this.courseWorkDTO(rec, actor);
  }
  private async loadCourseWork(actor: LecturerActor, id: string, meta: LecturerMeta, ownerOnly: boolean) {
    const assignments = await this.currentAssignments(actor);
    const rec = await this.d.store.getCourseWork(id, actor.departmentId);
    const a = rec ? this.assignmentFor(assignments, rec) : undefined;
    if (!rec || !a) return this.notFound(actor, meta, "ASSIGNMENT", id);
    if (ownerOnly) await this.requireOwner(actor, meta, rec.lecturerId, a.courseId);
    const course = await this.d.store.getCourse(a.courseId, actor.departmentId);
    if (!course) return this.notFound(actor, meta, "ASSIGNMENT", id);
    return { rec, course };
  }
  async updateCourseWork(actor: LecturerActor, id: string, patch: CourseWorkPatch, meta: LecturerMeta = {}) {
    const { rec, course } = await this.loadCourseWork(actor, id, meta, true);
    if (patch.dueDate && patch.dueDate.getTime() <= this.d.now().getTime()) throw new AppError(422, "The due date must be in the future.", undefined, "INVALID_DUE_DATE");
    const status = patch.published === undefined ? undefined : patch.published ? "PUBLISHED" : "DRAFT";
    const nowPublishing = status === "PUBLISHED" && rec.status !== "PUBLISHED";
    const next = await this.d.store.updateCourseWork(id, {
      ...(patch.title !== undefined && { title: patch.title }), ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.dueDate !== undefined && { dueAt: patch.dueDate }), ...(patch.allowLateSubmission !== undefined && { allowLateSubmission: patch.allowLateSubmission }),
      ...(status && { status }),
      ...(patch.fileUrl !== undefined && { attachment: patch.fileUrl ? { url: patch.fileUrl, originalName: patch.title ?? rec.title, mimeType: "text/uri-list", sizeBytes: 0 } : null }),
    });
    if (!next) return this.notFound(actor, meta, "ASSIGNMENT", id);
    const action = patch.published === true && nowPublishing ? "ASSIGNMENT_PUBLISHED" : patch.published === false ? "ASSIGNMENT_UNPUBLISHED" : "ASSIGNMENT_UPDATED";
    await this.audit(actor, meta, action, { courseId: course.id, courseCode: course.courseCode, resourceType: "ASSIGNMENT", resourceId: id, detail: { fields: Object.keys(patch) } });
    if (nowPublishing) await this.notifySafely(course, { kind: "ASSIGNMENT", title: `${course.courseCode}: new assignment`, body: next.title, link: "/student/assignments" });
    return this.courseWorkDTO(next, actor);
  }
  /** Refuses to delete an assignment that already has student submissions (unpublish it instead): student work is never silently destroyed. */
  async deleteCourseWork(actor: LecturerActor, id: string, meta: LecturerMeta = {}) {
    const { rec, course } = await this.loadCourseWork(actor, id, meta, true);
    if ((await this.d.store.countSubmissions(id)) > 0) {
      throw new AppError(409, "This assignment already has submissions. Unpublish it instead of deleting it.", undefined, "ASSIGNMENT_HAS_SUBMISSIONS");
    }
    await this.d.store.deleteCourseWork(id);
    if (rec.attachment?.publicId) await this.d.deleteFile(rec.attachment).catch(() => undefined);
    await this.audit(actor, meta, "ASSIGNMENT_DELETED", { courseId: course.id, courseCode: course.courseCode, resourceType: "ASSIGNMENT", resourceId: id, detail: { title: rec.title } });
  }
  /** Any lecturer assigned to the course may VIEW submissions. No marks, scores or feedback exist in this phase. */
  async listSubmissions(actor: LecturerActor, id: string, meta: LecturerMeta = {}) {
    const { rec, course } = await this.loadCourseWork(actor, id, meta, false);
    const [subs, enrolled] = await Promise.all([this.d.store.listSubmissions(id), this.d.store.countMembers(course)]);
    return {
      assignment: { id: rec.id, title: rec.title, dueDate: rec.dueAt, courseCode: rec.courseCode },
      summary: { submitted: subs.length, late: subs.filter((s) => s.isLate).length, enrolled, notSubmitted: Math.max(0, enrolled - subs.length) },
      items: subs.map((s) => ({
        id: s.id, student: { id: s.studentId, firstName: s.firstName, lastName: s.lastName, matricNumber: s.matricNumber }, submittedAt: s.submittedAt, isLate: s.isLate,
        content: s.content ?? null,
        file: s.file ? { name: s.file.name, mimeType: s.file.mimeType, sizeBytes: s.file.sizeBytes, url: this.d.signSubmissionFile({ publicId: s.file.publicId, resourceType: s.file.resourceType }) } : null,
      })),
    };
  }

  /* ------------------------------ attendance ------------------------------ */
  private stateOf(s: LecturerSessionRec, now: Date): "UPCOMING" | "OPEN" | "CLOSED" {
    return s.status === "CLOSED" || s.status === "CANCELLED" || now > s.closesAt ? "CLOSED" : now < s.opensAt ? "UPCOMING" : "OPEN";
  }
  private sessionDTO(s: LecturerSessionRec, actor: LecturerActor, counts?: { present: number; late: number; enrolled: number }) {
    const now = this.d.now();
    const mine = s.lecturerId === actor.lecturerId;
    return {
      id: s.id, courseId: s.courseId, courseCode: s.courseCode, level: s.level, academicSession: s.academicSession, semester: s.semester, title: s.title,
      latitude: s.location?.latitude ?? null, longitude: s.location?.longitude ?? null, allowedRadiusInMeters: s.location?.allowedRadiusInMeters ?? null,
      venueAccuracyMeters: s.location?.accuracyMeters ?? null, // how precise the venue reading was: a rough one makes students look "outside"
      startTime: s.opensAt, endTime: s.closesAt, lateAfterMinutes: s.lateAfterMinutes, requiresCode: Boolean(s.codeHash), status: s.status, state: this.stateOf(s, now),
      mine, ...(counts ? { counts: { ...counts, absent: Math.max(0, counts.enrolled - counts.present - counts.late) } } : {}),
    };
  }

  /** The lecturer sets the classroom location + radius; the student endpoint later computes the distance server-side. */
  async createAttendanceSession(actor: LecturerActor, courseId: string, input: SessionInput, meta: LecturerMeta = {}) {
    const { course } = await this.authorizeCourse(actor, courseId, meta);
    const now = this.d.now();
    const start = input.startTime ?? now;
    const end = input.endTime ?? new Date(start.getTime() + (input.durationMinutes ?? 60) * 60_000);
    const title = input.title?.trim() || `${course.courseCode} attendance`;
    const problems = validateSessionInput({
      courseCode: course.courseCode, title, opensAt: start, closesAt: end, lateAfterMinutes: input.lateAfterMinutes, code: input.code,
      location: { latitude: input.latitude, longitude: input.longitude, allowedRadiusInMeters: input.allowedRadiusInMeters },
    }, now);
    if (problems.length) throw new AppError(422, problems[0], problems, "INVALID_ATTENDANCE_SESSION");
    // The lecturer's own location fix must be accurate enough to set the venue centre (every student is measured against it).
    const maxAccuracy = this.d.maxCreatorAccuracyMeters ?? SESSION_LIMITS.maxCreatorAccuracyMeters;
    if (input.accuracyMeters !== undefined && input.accuracyMeters > maxAccuracy) {
      // A reading of several kilometres means the browser has no GPS / Wi-Fi fix and is guessing from the internet connection (typical on a laptop or desktop).
      const approximate = input.accuracyMeters > 1000;
      const shown = input.accuracyMeters >= 1000 ? `${Math.round(input.accuracyMeters / 1000)} km` : `${Math.round(input.accuracyMeters)} m`;
      throw new AppError(
        422,
        approximate
          ? `This device is only giving an approximate location (about ${shown}), probably from its internet connection. Use a phone with GPS and Location turned on, or on a computer connect to Wi-Fi and turn on Location Services, then try again.`
          : `Your location is only accurate to about ${shown}, but ${maxAccuracy} m or better is needed. Move outside or near a window, wait a few seconds for a better GPS fix, and try again.`,
        { accuracyMeters: input.accuracyMeters, maxAccuracyMeters: maxAccuracy, approximate },
        "LOCATION_ACCURACY_LOW",
      );
    }

    // One open session per course at a time: avoids two overlapping windows (and two codes) for the same class.
    const existing = await this.d.store.listAttendanceSessions(course);
    if (existing.some((s) => s.status === "ACTIVE" && s.closesAt > start && s.opensAt < end)) {
      throw new AppError(409, "This course already has an attendance session in that time window. Close it first.", undefined, "SESSION_OVERLAP");
    }
    const rec = await this.d.store.createAttendanceSession({
      departmentId: course.departmentId, courseId: course.id, courseCode: course.courseCode, level: course.level, academicSession: course.academicSession, semester: course.semester,
      title, opensAt: start, closesAt: end, lateAfterMinutes: input.lateAfterMinutes ?? 15, codeHash: input.code ? hashAttendanceCode(input.code) : undefined,
      status: "ACTIVE", location: { latitude: input.latitude, longitude: input.longitude, allowedRadiusInMeters: input.allowedRadiusInMeters, accuracyMeters: input.accuracyMeters }, lecturerId: actor.lecturerId,
    });
    await this.audit(actor, meta, "ATTENDANCE_SESSION_CREATED", { courseId: course.id, courseCode: course.courseCode, resourceType: "ATTENDANCE_SESSION", resourceId: rec.id, detail: { start, end, radius: input.allowedRadiusInMeters, accuracyMeters: input.accuracyMeters } });
    return this.sessionDTO(rec, actor);
  }

  async listAttendanceSessions(actor: LecturerActor, courseId: string, meta: LecturerMeta = {}) {
    const { course } = await this.authorizeCourse(actor, courseId, meta);
    const [sessions, enrolled] = await Promise.all([this.d.store.listAttendanceSessions(course), this.d.store.countMembers(course)]);
    const records = await this.d.store.recordsForSessions(sessions.map((s) => s.id));
    return sessions.sort((a, b) => b.opensAt.getTime() - a.opensAt.getTime()).map((s) => {
      const r = records.filter((x) => x.sessionId === s.id);
      return this.sessionDTO(s, actor, { present: r.filter((x) => x.status === "PRESENT").length, late: r.filter((x) => x.status === "LATE").length, enrolled });
    });
  }

  private async loadSession(actor: LecturerActor, sessionId: string, meta: LecturerMeta, ownerOnly: boolean) {
    const assignments = await this.currentAssignments(actor);
    const rec = await this.d.store.getAttendanceSession(sessionId, actor.departmentId);
    const a = rec ? this.assignmentFor(assignments, rec) : undefined;
    if (!rec || !a) return this.notFound(actor, meta, "ATTENDANCE_SESSION", sessionId);
    if (ownerOnly) await this.requireOwner(actor, meta, rec.lecturerId, a.courseId);
    const course = await this.d.store.getCourse(a.courseId, actor.departmentId);
    if (!course) return this.notFound(actor, meta, "ATTENDANCE_SESSION", sessionId);
    return { rec, course };
  }

  /** Live view: who has marked (and how far from the room), who hasn't, and how many suspicious attempts were flagged. */
  async getAttendanceSession(actor: LecturerActor, sessionId: string, meta: LecturerMeta = {}) {
    const { rec, course } = await this.loadSession(actor, sessionId, meta, false);
    const [records, members, flagged] = await Promise.all([
      this.d.store.recordsForSessions([rec.id]), this.d.store.listMembers(course, { page: 1, limit: 5000 }), this.d.store.flaggedAttempts(rec.id),
    ]);
    const marked = new Set(records.map((r) => r.studentId));
    const present = records.filter((r) => r.status === "PRESENT").length;
    const late = records.filter((r) => r.status === "LATE").length;
    const view = (r: AttendanceRecordView) => ({ studentId: r.studentId, firstName: r.firstName, lastName: r.lastName, matricNumber: r.matricNumber, status: r.status, markedAt: r.markedAt, distanceMeters: r.distanceMeters ?? null });
    return {
      ...this.sessionDTO(rec, actor, { present, late, enrolled: members.total }),
      flaggedAttempts: flagged,
      records: records.sort((a, b) => a.markedAt.getTime() - b.markedAt.getTime()).map(view),
      notYetMarked: members.items.filter((m) => !marked.has(m.studentId)).map((m) => ({ studentId: m.studentId, firstName: m.firstName, lastName: m.lastName, matricNumber: m.matricNumber })),
    };
  }

  /** Only the lecturer who opened the session can close it; a colleague (even on the same course) or another department's lecturer can't. */
  async closeAttendanceSession(actor: LecturerActor, sessionId: string, meta: LecturerMeta = {}) {
    const { rec, course } = await this.loadSession(actor, sessionId, meta, true);
    if (rec.status === "CLOSED") throw new AppError(409, "This session is already closed.", undefined, "ALREADY_CLOSED");
    if (rec.status === "CANCELLED") throw new AppError(409, "This session was cancelled.", undefined, "SESSION_CANCELLED");
    const now = this.d.now();
    const next = await this.d.store.updateAttendanceSession(sessionId, { status: "CLOSED", closesAt: now < rec.closesAt ? now : rec.closesAt });
    if (!next) return this.notFound(actor, meta, "ATTENDANCE_SESSION", sessionId);
    await this.audit(actor, meta, "ATTENDANCE_SESSION_CLOSED", { courseId: course.id, courseCode: course.courseCode, resourceType: "ATTENDANCE_SESSION", resourceId: sessionId });
    return this.sessionDTO(next, actor);
  }

  /** Open a scheduled session now, or reopen one that was closed / expired, for `durationMinutes` (default 30). Owner only. */
  async openAttendanceSession(actor: LecturerActor, sessionId: string, input: { durationMinutes?: number }, meta: LecturerMeta = {}) {
    const { rec, course } = await this.loadSession(actor, sessionId, meta, true);
    if (rec.status === "CANCELLED") throw new AppError(409, "This session was cancelled.", undefined, "SESSION_CANCELLED");
    const now = this.d.now();
    const duration = input.durationMinutes ?? 30;
    if (!(duration >= 1 && duration <= 180)) throw new AppError(422, "durationMinutes must be between 1 and 180.", undefined, "INVALID_ATTENDANCE_SESSION");
    const next = await this.d.store.updateAttendanceSession(sessionId, { status: "ACTIVE", opensAt: rec.opensAt > now ? now : rec.opensAt, closesAt: new Date(now.getTime() + duration * 60_000) });
    if (!next) return this.notFound(actor, meta, "ATTENDANCE_SESSION", sessionId);
    await this.audit(actor, meta, "ATTENDANCE_SESSION_OPENED", { courseId: course.id, courseCode: course.courseCode, resourceType: "ATTENDANCE_SESSION", resourceId: sessionId, detail: { durationMinutes: duration } });
    return this.sessionDTO(next, actor);
  }

  /** Per-student and per-session attendance for a course. Read-only; there is no way to edit a record from here. */
  async attendanceStatistics(actor: LecturerActor, courseId: string, meta: LecturerMeta = {}) {
    const { course } = await this.authorizeCourse(actor, courseId, meta);
    const now = this.d.now();
    const [sessions, members] = await Promise.all([this.d.store.listAttendanceSessions(course), this.d.store.listMembers(course, { page: 1, limit: 5000 })]);
    const held = sessions.filter((s) => s.opensAt <= now && s.status !== "CANCELLED");
    const records = await this.d.store.recordsForSessions(held.map((s) => s.id));
    const attendedBy = new Map<string, number>();
    for (const r of records) attendedBy.set(r.studentId, (attendedBy.get(r.studentId) ?? 0) + 1);
    const students = members.items.map((m) => ({
      studentId: m.studentId, firstName: m.firstName, lastName: m.lastName, matricNumber: m.matricNumber,
      attended: attendedBy.get(m.studentId) ?? 0, sessionsHeld: held.length, percentage: pct(attendedBy.get(m.studentId) ?? 0, held.length),
    }));
    return {
      course: { id: course.id, courseCode: course.courseCode },
      sessionsHeld: held.length, enrolled: members.total,
      averageAttendancePercentage: pct(records.length, held.length * members.total),
      sessions: held.map((s) => { const r = records.filter((x) => x.sessionId === s.id); return { id: s.id, title: s.title, startTime: s.opensAt, present: r.length, enrolled: members.total, percentage: pct(r.length, members.total) }; }),
      students: students.sort((a, b) => (a.percentage ?? 0) - (b.percentage ?? 0)),
    };
  }


  /* ------------------------------ complaints forwarded by the HOD ------------------------------ */
  /**
   * The HOD forwards a complaint by setting `assignedLecturer` on the ONE shared Complaint record, so authority here is exactly:
   * same department AND assignedLecturer === the authenticated lecturer. Anything else (another lecturer's, another department's, not
   * forwarded, or non-existent) answers the same audited 404. The lecturer can respond and move it to IN_PROGRESS or hand it back to the HOD
   * (UNDER_REVIEW) with a recommendation; resolving, rejecting, closing and re-forwarding stay with the HOD.
   */
  private async loadComplaint(actor: LecturerActor, id: string, meta: LecturerMeta): Promise<LecturerComplaintRec> {
    const c = await this.d.store.getAssignedComplaint(actor.departmentId, actor.lecturerId, id);
    return c ?? this.notFound(actor, meta, "COMPLAINT", id);
  }
  private complaintDTO(c: LecturerComplaintRec) {
    const forwarded = [...c.timeline].reverse().find((e) => e.status === "ASSIGNED" && e.byRole === "HOD");
    const actionable = LECTURER_ACTIONABLE_COMPLAINT.includes(c.status);
    return {
      id: c.id, referenceNumber: c.referenceNumber, type: c.type, category: c.type === "COURSE" ? "COURSE" : "DEPARTMENT", title: c.title, description: c.message,
      student: { name: c.studentName, matricNumber: c.matricNumber }, // no email / phone / id
      course: c.courseId ? { id: c.courseId, courseCode: c.courseCode ?? null, title: c.courseTitle ?? null } : null,
      status: c.status, submittedAt: c.createdAt, forwardedAt: c.assignedAt ?? null, hodMessage: forwarded?.note ?? null, updatedAt: c.updatedAt,
      canRespond: LECTURER_RESPONDABLE_COMPLAINT.includes(c.status), canUpdateStatus: actionable, allowedStatuses: actionable ? (c.status === "ASSIGNED" ? ["IN_PROGRESS", "UNDER_REVIEW"] : ["UNDER_REVIEW"]) : [],
    };
  }
  private complaintDetailDTO(c: LecturerComplaintRec) {
    return {
      ...this.complaintDTO(c),
      resolution: c.resolution ?? null, resolvedAt: c.resolvedAt ?? null,
      attachments: c.attachments.map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, sizeBytes: a.sizeBytes, url: this.d.signSubmissionFile({ publicId: a.publicId, resourceType: a.resourceType }) })),
      timeline: this.timelineDTO(c),
    };
  }
  private timelineDTO(c: LecturerComplaintRec) {
    return c.timeline.map((e) => ({ id: e.id ?? null, status: e.status, label: e.label, note: e.note ?? null, at: e.at, by: { role: e.byRole ?? null, name: e.byName ?? null }, internal: e.internal ?? false }));
  }
  async listComplaints(actor: LecturerActor, q: LecturerComplaintQuery) {
    const r = await this.d.store.listComplaints(actor.departmentId, actor.lecturerId, q);
    return { items: r.items.map((c) => this.complaintDTO(c)), page: q.page, limit: q.limit, total: r.total, totalPages: Math.max(1, Math.ceil(r.total / q.limit)) };
  }
  async getComplaint(actor: LecturerActor, id: string, meta: LecturerMeta = {}) {
    return this.complaintDetailDTO(await this.loadComplaint(actor, id, meta));
  }
  /** The complaint's own timeline (forwarding, lecturer and HOD replies, status changes): the existing history, not a second one. */
  async complaintHistory(actor: LecturerActor, id: string, meta: LecturerMeta = {}) {
    const c = await this.loadComplaint(actor, id, meta);
    return { complaintId: c.id, referenceNumber: c.referenceNumber, status: c.status, forwardedAt: c.assignedAt ?? null, events: this.timelineDTO(c) };
  }

  /** A reply on the complaint. The first reply to a freshly forwarded complaint acknowledges it (ASSIGNED -> IN_PROGRESS). `visibleToStudent: false` keeps it HOD-only. */
  async respondToComplaint(actor: LecturerActor, id: string, input: { message: string; visibleToStudent?: boolean }, meta: LecturerMeta = {}) {
    const c = await this.loadComplaint(actor, id, meta);
    if (!LECTURER_RESPONDABLE_COMPLAINT.includes(c.status)) throw new AppError(409, `This complaint is ${c.status.toLowerCase().replace("_", " ")} and can't take further replies.`, undefined, "COMPLAINT_CLOSED");
    const visible = input.visibleToStudent ?? true;
    const acknowledging = c.status === "ASSIGNED";
    const event = {
      status: (acknowledging ? "IN_PROGRESS" : c.status) as ComplaintStatusName, label: "Response from the lecturer", note: input.message, at: this.d.now(),
      byRole: "LECTURER", byId: actor.lecturerId, byName: fullName(actor), internal: !visible,
    };
    const next = await this.d.store.appendComplaintEvent(actor.departmentId, actor.lecturerId, id, [c.status], event, acknowledging ? "IN_PROGRESS" : undefined);
    if (!next) throw new AppError(409, "This complaint was just updated by someone else. Reload it and try again.", undefined, "COMPLAINT_CHANGED");
    await this.audit(actor, meta, "COMPLAINT_RESPONDED", { resourceType: "COMPLAINT", resourceId: id, courseCode: c.courseCode, detail: { reference: c.referenceNumber, visibleToStudent: visible } });
    await this.safely(() => this.d.notifyHod(actor.departmentId, { kind: "RESPONSE", title: `Complaint ${c.referenceNumber}: response from ${fullName(actor)}`, body: input.message.slice(0, 200), link: "/hod/complaints", complaintId: id }));
    if (visible) await this.safely(() => this.d.notifyStudent(c.studentId, actor.departmentId, { kind: "RESPONSE", title: `Complaint ${c.referenceNumber}: response from the lecturer`, body: input.message.slice(0, 200), link: "/student/complaints" }));
    return this.complaintDetailDTO(next);
  }

  /**
   * IN_PROGRESS (picked up) or UNDER_REVIEW (handed back to the HOD, with a note recommending the outcome). Never RESOLVED / REJECTED / CLOSED / ASSIGNED:
   * the HOD makes the final decision. A hand-back is HOD-only by default; the student sees the status but not the lecturer's recommendation.
   */
  async setComplaintStatus(actor: LecturerActor, id: string, input: { status: ComplaintStatusName; note?: string; visibleToStudent?: boolean }, meta: LecturerMeta = {}) {
    const c = await this.loadComplaint(actor, id, meta);
    const from = c.status; // captured before the write: later reads of `c` may already show the new status
    const verdict = checkLecturerComplaintStatus(from, input.status);
    if (!verdict.ok) {
      if (verdict.status === 403) await this.audit(actor, meta, "ACCESS_DENIED", { resourceType: "COMPLAINT", resourceId: id, detail: { reason: verdict.code, attempted: input.status } });
      throw new AppError(verdict.status, verdict.message, undefined, verdict.code);
    }
    const handBack = input.status === "UNDER_REVIEW";
    if (handBack && !input.note?.trim()) throw new AppError(422, "Add a note for the HOD explaining what you found and what you recommend.", undefined, "NOTE_REQUIRED");
    const visible = input.visibleToStudent ?? !handBack;
    const event = {
      status: input.status, label: handBack ? "Returned to the HOD for review" : "In progress (lecturer)", note: input.note, at: this.d.now(),
      byRole: "LECTURER", byId: actor.lecturerId, byName: fullName(actor), internal: !visible,
    };
    const next = await this.d.store.appendComplaintEvent(actor.departmentId, actor.lecturerId, id, [from], event, input.status);
    if (!next) throw new AppError(409, "This complaint was just updated by someone else. Reload it and try again.", undefined, "COMPLAINT_CHANGED");
    await this.audit(actor, meta, "COMPLAINT_STATUS_CHANGED", { resourceType: "COMPLAINT", resourceId: id, courseCode: c.courseCode, detail: { reference: c.referenceNumber, from, to: input.status } });
    await this.safely(() => this.d.notifyHod(actor.departmentId, {
      kind: "STATUS_CHANGED", title: `Complaint ${c.referenceNumber}: ${handBack ? "returned to you for review" : "in progress"}`, body: (input.note ?? `${fullName(actor)} updated the status.`).slice(0, 200), link: "/hod/complaints", complaintId: id,
    }));
    if (visible) await this.safely(() => this.d.notifyStudent(c.studentId, actor.departmentId, { kind: "STATUS_CHANGED", title: `Complaint ${c.referenceNumber}: ${handBack ? "back with the HOD for review" : "in progress"}`, body: input.note ?? "Your complaint is being worked on.", link: "/student/complaints" }));
    return this.complaintDetailDTO(next);
  }

  private async safely(fn: () => Promise<void>) {
    try { await fn(); } catch { /* notifications are best-effort */ }
  }

  /* ------------------------------ notifications (same system students use) ------------------------------ */
  async listNotifications(actor: LecturerActor, q: { page: number; limit: number; unread?: boolean }) {
    const r = await this.d.store.listNotifications(actor.lecturerId, q);
    return { items: r.items, unreadCount: r.unread, page: q.page, limit: q.limit, total: r.total, totalPages: Math.max(1, Math.ceil(r.total / q.limit)) };
  }
  async markNotificationRead(actor: LecturerActor, id: string) {
    const n = await this.d.store.markNotificationRead(actor.lecturerId, id); // recipient is part of the query
    if (!n) throw new AppError(404, "Notification not found.", undefined, "NOT_FOUND");
    return n;
  }
  async markAllNotificationsRead(actor: LecturerActor) {
    return { updated: await this.d.store.markAllNotificationsRead(actor.lecturerId) };
  }

  /* ------------------------------ dashboard ------------------------------ */
  async dashboard(actor: LecturerActor) {
    const now = this.d.now();
    const [profile, term, assignments, notes] = await Promise.all([
      this.getProfile(actor), this.d.store.getCurrentTerm(actor.departmentId), this.currentAssignments(actor), this.d.store.listNotifications(actor.lecturerId, { page: 1, limit: 3 }),
    ]);
    const courses: CourseRec[] = [];
    for (const a of assignments) {
      const c = await this.d.store.getCourse(a.courseId, actor.departmentId);
      if (c) courses.push(c);
    }
    const ids = courses.map((c) => c.id);
    const courseNames = await this.d.store.courseLecturers(actor.departmentId, ids);
    const [work, announcements] = await Promise.all([this.d.store.listCourseWork(ids), this.d.store.listAnnouncements(ids, actor.lecturerId)]);

    const stats = [];
    const sessionViews: ReturnType<LecturerService["sessionDTO"]>[] = [];
    for (const c of courses) {
      const [enrolled, materials, sessions] = await Promise.all([this.d.store.countMembers(c), this.d.store.listOfficialMaterials([c]), this.d.store.listAttendanceSessions(c)]);
      const held = sessions.filter((s) => s.opensAt <= now && s.status !== "CANCELLED");
      const records = await this.d.store.recordsForSessions(held.map((s) => s.id));
      stats.push({
        courseId: c.id, courseCode: c.courseCode, title: c.title, enrolled, officialMaterials: materials.length,
        publishedAssignments: work.filter((w) => w.courseId === c.id && w.status === "PUBLISHED").length, sessionsHeld: held.length,
        averageAttendancePercentage: pct(records.length, held.length * enrolled),
      });
      sessionViews.push(...sessions.map((s) => this.sessionDTO(s, actor)));
    }
    return {
      lecturer: profile,
      term: term ?? null,
      courses: courses.map((c) => this.courseDTO(c, { lecturers: courseNames.get(c.id) ?? [] })),
      upcomingAssignments: work.filter((w) => w.status === "PUBLISHED" && w.dueAt > now).sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime()).slice(0, MAX_DASHBOARD_ITEMS)
        .map((w) => ({ id: w.id, courseCode: w.courseCode, title: w.title, dueDate: w.dueAt })),
      recentAnnouncements: announcements.filter((a) => a.status === "PUBLISHED").sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0)).slice(0, MAX_DASHBOARD_ITEMS)
        .map((a) => ({ id: a.id, courseCode: a.courseCode, title: a.title, author: a.authorName, publishedAt: a.publishedAt ?? null })),
      attendanceSessions: {
        open: sessionViews.filter((s) => s.state === "OPEN"),
        recent: sessionViews.sort((a, b) => b.startTime.getTime() - a.startTime.getTime()).slice(0, MAX_DASHBOARD_ITEMS),
      },
      notifications: { unreadCount: notes.unread, latest: notes.items },
      statistics: stats,
    };
  }
}
