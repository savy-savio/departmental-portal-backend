import { AppError } from "../../utils/AppError";
import type { ResourceType } from "../../utils/constants";
import { sniffImage } from "../../utils/image";
import { appointmentCovers, can as canIn, isAssignmentCurrent, priorityAllowed, ROLE_PERMISSIONS, type Permission, type PermissionTable, type Priority } from "./policy";
import type { RepresentativeStore } from "./store";
import { slotsOverlap, validateSlot, DAYS as DAY_ORDER, type Day } from "./timetable-rules";
import type {
  AnnouncementImage, AnnouncementRec, AnnouncementStatus, AssignmentRec, CourseRec, RepActor, ResourceRec, StoredFile, TimetableRec,
} from "./types";

export interface RepDeps {
  store: RepresentativeStore;
  /** Role -> permissions. Defaults to ROLE_PERMISSIONS; override to enable e.g. assistant timetable editing later. */
  permissions?: PermissionTable;
  now: () => Date;
  /** Notifies the students enrolled in the course (never the author). Best-effort. */
  notifyClass: (course: CourseRec, n: { kind: "ANNOUNCEMENT" | "MATERIAL" | "TIMETABLE"; title: string; body: string; link?: string }, excludeStudentId: string) => Promise<void>;
  /** Notifies every student of a level (a class-wide announcement). Best-effort, never the author. */
  notifyLevel: (c: { departmentId: string; level: string; academicSession: string }, n: { kind: "ANNOUNCEMENT"; title: string; body: string; link?: string }, excludeStudentId: string) => Promise<void>;
  unreadNotifications: (studentId: string) => Promise<number>;
  /** Stores an announcement picture (the caller has already verified it is a real image). */
  uploadAnnouncementImage: (buffer: Buffer) => Promise<AnnouncementImage>;
  deleteAnnouncementImage: (publicId: string) => Promise<void>;
  /** Validates the file's real type and stores it. Throws AppError for disallowed files. */
  uploadFile: (f: { buffer: Buffer; originalName: string }) => Promise<StoredFile>;
  deleteFile: (f: StoredFile) => Promise<void>;
}

/** `courseId` is optional: without it the announcement goes to the rep's whole level (class). */
export interface CreateAnnouncementInput { courseId?: string; title: string; body: string; priority?: Priority; status?: "DRAFT" | "PUBLISHED"; expiresAt?: Date; image?: Buffer }
export interface UpdateAnnouncementInput { title?: string; body?: string; priority?: Priority; status?: "DRAFT" | "PUBLISHED" | "UNPUBLISHED"; expiresAt?: Date | null; image?: Buffer; removeImage?: boolean }
export interface CreateResourceInput { courseId?: string; title: string; description?: string; resourceType: ResourceType; fileUrl?: string; file?: { buffer: Buffer; originalName: string } }
export interface UpdateResourceInput { title?: string; description?: string; resourceType?: ResourceType; status?: "PUBLISHED" | "HIDDEN" }

export interface CreateTimetableInput {
  courseId?: string; title?: string; type?: "LECTURE" | "PRACTICAL" | "TUTORIAL" | "OTHER"; dayOfWeek?: Day; date?: string;
  /** Optional. The lecturer is NOT an input: it comes from the lecturer(s) assigned to the selected course. */
  startTime: string; endTime: string; venue?: string | null; status?: "DRAFT" | "PUBLISHED";
}
export interface UpdateTimetableInput {
  title?: string; type?: "LECTURE" | "PRACTICAL" | "TUTORIAL" | "OTHER"; dayOfWeek?: Day; date?: string | null;
  startTime?: string; endTime?: string; venue?: string | null; status?: "DRAFT" | "PUBLISHED";
}

const fullName = (a: RepActor) => `${a.firstName} ${a.lastName ?? ""}`.trim();

/**
 * Course Rep + Assistant Course Rep engine.
 *
 * Every operation re-derives authority from the database on each call:
 *   authenticated student (JWT)  ->  ACTIVE assignment  ->  department's CURRENT term  ->  assigned course  ->  permission for the role.
 * Nothing is cached and nothing is read from the request except the target ids, which are always checked against the above.
 * Authority comes ONLY from CourseRepresentativeAssignment; the Student.role field is never consulted.
 */
export class RepresentativeService {
  constructor(private readonly d: RepDeps) {}

  private get table(): PermissionTable {
    return this.d.permissions ?? ROLE_PERMISSIONS;
  }
  private can(role: AssignmentRec["role"], permission: Permission): boolean {
    return canIn(role, permission, this.table);
  }

  /* ------------------------------ authority ------------------------------ */
  /** The caller's assignments that are valid RIGHT NOW. */
  async currentAssignments(actor: RepActor): Promise<AssignmentRec[]> {
    const term = await this.d.store.getCurrentTerm(actor.departmentId);
    if (!term) return [];
    const all = await this.d.store.assignmentsForStudent(actor.studentId);
    return all.filter((a) => isAssignmentCurrent(a, actor, term));
  }

  private async deny(actor: RepActor, code: string, status: number, message: string, extra: { courseId?: string; role?: string; attempted?: string } = {}): Promise<never> {
    await this.audit(actor, "ACCESS_DENIED", { role: extra.role, courseId: extra.courseId, resourceType: "COURSE", detail: { reason: code, attempted: extra.attempted } });
    throw new AppError(status, message, undefined, code);
  }

  /** Gate used by the middleware: the caller must hold at least one valid assignment. */
  async requireRepresentative(actor: RepActor): Promise<AssignmentRec[]> {
    const assignments = await this.currentAssignments(actor);
    if (!assignments.length) return this.deny(actor, "NOT_A_REPRESENTATIVE", 403, "You are not an active class representative.");
    return assignments;
  }

  /** Does the caller hold the permission on at least one valid assignment? (coarse gate; the fine check is per course) */
  async requirePermission(actor: RepActor, assignments: AssignmentRec[], permission: Permission): Promise<void> {
    if (!assignments.some((a) => this.can(a.role, permission))) {
      await this.deny(actor, "PERMISSION_DENIED", 403, "Your representative role doesn't allow that.", { attempted: permission });
    }
  }

  /**
   * The course must be covered by one of the caller's appointments: a LEVEL appointment covers every course of its level (same term);
   * a legacy course appointment covers its one course. An id that doesn't exist, is in another department, or is in another level
   * all look identical (403 NOT_ASSIGNED_TO_COURSE).
   */
  private async resolveCovered(actor: RepActor, assignments: AssignmentRec[], courseId: string): Promise<{ assignment: AssignmentRec; course: CourseRec }> {
    const course = await this.d.store.getCourse(courseId, actor.departmentId);
    const assignment = course ? assignments.find((x) => appointmentCovers(x, course)) : undefined;
    if (!course || !assignment) return this.deny(actor, "NOT_ASSIGNED_TO_COURSE", 403, "That course isn't part of your appointment.", { courseId });
    return { assignment, course };
  }
  async assertAssigned(actor: RepActor, assignments: AssignmentRec[], courseId: string): Promise<AssignmentRec> {
    return (await this.resolveCovered(actor, assignments, courseId)).assignment;
  }

  /** Course-level authorisation: the course is covered by an appointment AND the role holds the permission. */
  private async authorizeCourse(actor: RepActor, courseId: string, permission: Permission): Promise<{ assignment: AssignmentRec; course: CourseRec; assignments: AssignmentRec[] }> {
    const assignments = await this.requireRepresentative(actor);
    const { assignment, course } = await this.resolveCovered(actor, assignments, courseId);
    if (!this.can(assignment.role, permission)) {
      await this.deny(actor, "PERMISSION_DENIED", 403, "Your representative role doesn't allow that.", { courseId, role: assignment.role, attempted: permission });
    }
    return { assignment, course, assignments };
  }

  /** Every (appointment, course) pair the caller's appointments cover, or just the pair for one chosen course. */
  private async coveredCourses(actor: RepActor, assignments: AssignmentRec[], courseId?: string): Promise<{ assignment: AssignmentRec; course: CourseRec }[]> {
    if (courseId) return [await this.resolveCovered(actor, assignments, courseId)];
    const out: { assignment: AssignmentRec; course: CourseRec }[] = [];
    for (const a of assignments) {
      if (a.scope === "LEVEL") {
        for (const c of await this.d.store.listCoursesForLevel(actor.departmentId, a.level, a.academicSession, a.semester)) out.push({ assignment: a, course: c });
      } else if (a.courseId) {
        const c = await this.d.store.getCourse(a.courseId, actor.departmentId);
        if (c) out.push({ assignment: a, course: c });
      }
    }
    return out;
  }

  /** For create-style calls the course must be chosen. Only a rep holding a single legacy course appointment gets it filled in. */
  private async resolveCourseId(actor: RepActor, courseId?: string): Promise<string> {
    if (courseId) return courseId;
    const assignments = await this.requireRepresentative(actor);
    if (assignments.length === 1 && assignments[0].scope !== "LEVEL" && assignments[0].courseId) return assignments[0].courseId;
    throw new AppError(422, "Choose which course this is for.", undefined, "COURSE_REQUIRED");
  }

  private async audit(
    actor: RepActor, action: string,
    x: { role?: string; courseId?: string; courseCode?: string; resourceType?: "ANNOUNCEMENT" | "RESOURCE" | "ASSIGNMENT" | "COURSE"; resourceId?: string; detail?: Record<string, unknown> } = {},
  ): Promise<void> {
    try {
      await this.d.store.addAudit({
        actorId: actor.studentId, role: x.role, action, resourceType: x.resourceType, resourceId: x.resourceId,
        courseId: x.courseId, courseCode: x.courseCode, departmentId: actor.departmentId, detail: x.detail, at: this.d.now(),
      });
    } catch {
      // The audit trail must not turn a correct decision into a 500; infrastructure logging covers store failures.
    }
  }

  /* ------------------------------ profile / courses ------------------------------ */
  private assignmentDTO(a: AssignmentRec, current: boolean) {
    return {
      id: a.id, role: a.role, status: a.status, current,
      scope: a.scope === "LEVEL" ? "LEVEL" : "COURSE", level: a.level, academicSession: a.academicSession, semester: a.semester,
      course: a.courseId ? { id: a.courseId, courseCode: a.courseCode, level: a.level, academicSession: a.academicSession, semester: a.semester } : null,
      permissions: current ? [...this.table[a.role]] : [],
      assignedAt: a.assignedAt, assignedBy: a.assignedBy.name,
    };
  }

  /** Representative view of the caller: their assignments + permissions. (Their student profile stays the source of truth for identity.) */
  async getProfile(actor: RepActor) {
    const current = await this.requireRepresentative(actor);
    return { isRepresentative: true, assignments: current.map((a) => this.assignmentDTO(a, true)) };
  }

  /** Full assignment history (own records only), flagged by whether each currently grants anything. */
  async listAssignments(actor: RepActor) {
    const [all, current] = await Promise.all([this.d.store.assignmentsForStudent(actor.studentId), this.currentAssignments(actor)]);
    const currentIds = new Set(current.map((a) => a.id));
    return all.filter((a) => a.departmentId === actor.departmentId).map((a) => this.assignmentDTO(a, currentIds.has(a.id)));
  }

  private courseDTO(c: CourseRec, extra: Record<string, unknown> = {}) {
    return {
      id: c.id, courseCode: c.courseCode, title: c.title, units: c.units, level: c.level,
      semester: c.semester, academicSession: c.academicSession, ...extra,
    };
  }

  /** The courses the rep can choose from (for a level appointment: every course of the level this term), each with its assigned lecturer(s). */
  async listCourses(actor: RepActor) {
    const assignments = await this.requireRepresentative(actor);
    const pairs = (await this.coveredCourses(actor, assignments)).filter((p) => this.can(p.assignment.role, "course:view"));
    return Promise.all(pairs.map(async ({ assignment, course }) => this.courseDTO(course, { role: assignment.role, lecturers: await this.d.store.lecturerNames(course) })));
  }

  /** View only: no representative route can change the catalogue. */
  async getCourse(actor: RepActor, courseId: string) {
    const { assignment, course } = await this.authorizeCourse(actor, courseId, "course:view");
    const [enrolledCount, lecturers] = await Promise.all([this.d.store.countMembers(course), this.d.store.lecturerNames(course)]);
    return this.courseDTO(course, { role: assignment.role, enrolledCount, lecturers });
  }

  /** Name, matric, photo, level and enrollment type only: no email, phone or other private data. */
  async listMembers(actor: RepActor, courseId: string, q: { page: number; limit: number; search?: string }) {
    const { course } = await this.authorizeCourse(actor, courseId, "members:view");
    const { items, total } = await this.d.store.listMembers(course, q);
    return {
      course: { id: course.id, courseCode: course.courseCode },
      items: items.map((m) => ({
        studentId: m.studentId, firstName: m.firstName, lastName: m.lastName, matricNumber: m.matricNumber,
        profilePhoto: m.profilePhoto ?? null, level: m.level, enrollmentType: m.enrollmentType,
      })),
      page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)),
    };
  }

  /* ------------------------------ class timetable ------------------------------ */
  /**
   * The CLASS timetable of the assigned course: the Course Rep creates / edits / deletes it; an Assistant can only view it
   * (unless "timetable:*" permissions are later added to that role). The OFFICIAL departmental timetable stays read-only for everyone here.
   */
  private timetableDTO(t: TimetableRec, role: AssignmentRec["role"]) {
    const managed = t.source === "CLASS_REP";
    return {
      id: t.id, courseId: t.courseId ?? null, courseCode: t.courseCode ?? null, level: t.level, academicSession: t.academicSession, semester: t.semester,
      title: t.title, type: t.type, dayOfWeek: t.dayOfWeek, date: t.date ?? null, startTime: t.startTime, endTime: t.endTime,
      venue: t.venue ?? null, lecturerName: t.lecturerName ?? null, source: t.source, status: t.status,
      createdBy: t.createdByRole ?? null, createdAt: t.createdAt ?? null, updatedAt: t.updatedAt ?? null,
      // Official entries are never editable from the representative API, whatever the role.
      canEdit: managed && this.can(role, "timetable:update"), canDelete: managed && this.can(role, "timetable:delete"),
    };
  }

  async getTimetable(actor: RepActor, q: { courseId?: string; view: "course" | "class" }) {
    const assignments = await this.requireRepresentative(actor);
    await this.requirePermission(actor, assignments, "timetable:view");
    const pairs = (await this.coveredCourses(actor, assignments, q.courseId)).filter((p) => this.can(p.assignment.role, "timetable:view"));
    const rows = await this.d.store.listTimetable(pairs.map((p) => p.course), q.view);
    const roleOf = (t: TimetableRec) =>
      (pairs.find((p) => p.course.courseCode === t.courseCode && p.course.academicSession === t.academicSession && p.course.semester === t.semester)
        ?? pairs.find((p) => p.course.level === t.level && p.course.academicSession === t.academicSession && p.course.semester === t.semester) ?? pairs[0])?.assignment.role;
    const entries = rows
      // Drafts are visible only to people who can manage that class's timetable; everyone else sees what students see.
      .filter((t) => t.status !== "DRAFT" || (roleOf(t) ? this.can(roleOf(t) as AssignmentRec["role"], "timetable:update") : false))
      .sort((a, b) => DAY_ORDER.indexOf(a.dayOfWeek) - DAY_ORDER.indexOf(b.dayOfWeek) || a.startTime.localeCompare(b.startTime))
      .map((t) => this.timetableDTO(t, (roleOf(t) ?? pairs[0]?.assignment.role) as AssignmentRec["role"]));
    return { view: q.view, officialTimetableReadOnly: true, entries };
  }

  private async assertNoClash(course: CourseRec, slot: { dayOfWeek: Day; date?: string | null; startTime: string; endTime: string }, ignoreId?: string) {
    const existing = await this.d.store.listTimetable([course], "course");
    const clash = existing.find((e) => e.id !== ignoreId && e.courseCode === course.courseCode && slotsOverlap({ ...slot, date: slot.date ?? undefined }, { dayOfWeek: e.dayOfWeek, date: e.date, startTime: e.startTime, endTime: e.endTime }));
    if (clash) throw new AppError(409, `That clashes with another ${course.courseCode} slot (${clash.dayOfWeek} ${clash.startTime}-${clash.endTime}).`, undefined, "TIMETABLE_CLASH");
  }

  /**
   * The rep SELECTS the course (courseId); everything else about the class (level, term, department) comes from the course, and the lecturer(s) come
   * from the lecturer assignments of that course: neither the title nor the lecturer has to be typed. The venue is optional.
   */
  async createTimetableEntry(actor: RepActor, input: CreateTimetableInput) {
    const courseId = await this.resolveCourseId(actor, input.courseId);
    const { assignment, course } = await this.authorizeCourse(actor, courseId, "timetable:create");
    const { errors, dayOfWeek } = validateSlot(input);
    if (errors.length || !dayOfWeek) throw new AppError(422, errors[0] ?? "Invalid timetable slot.", errors, "INVALID_TIMETABLE");
    await this.assertNoClash(course, { dayOfWeek, date: input.date, startTime: input.startTime, endTime: input.endTime });

    const status = input.status ?? "PUBLISHED";
    const lecturers = await this.d.store.lecturerNames(course);
    const rec = await this.d.store.createTimetableEntry({
      departmentId: course.departmentId, courseId: course.id, courseCode: course.courseCode, level: course.level,
      academicSession: course.academicSession, semester: course.semester,
      title: input.title?.trim() || `${course.courseCode} ${((input.type ?? "LECTURE").charAt(0) + (input.type ?? "LECTURE").slice(1).toLowerCase())}`, // e.g. "CSC201 Lecture": comes from the selected course, nothing to type
      type: input.type ?? "LECTURE", dayOfWeek, date: input.date, startTime: input.startTime, endTime: input.endTime,
      venue: input.venue?.trim() || undefined, lecturerName: lecturers.length ? lecturers.join(", ") : undefined,
      source: "CLASS_REP", status, createdByStudentId: actor.studentId, createdByRole: assignment.role,
    });
    await this.audit(actor, "TIMETABLE_CREATED", { role: assignment.role, courseId: course.id, courseCode: course.courseCode, resourceType: "COURSE", resourceId: rec.id, detail: { day: rec.dayOfWeek, start: rec.startTime, end: rec.endTime, status } });
    if (status === "PUBLISHED") await this.notifySafely(course, { kind: "TIMETABLE", title: `${course.courseCode}: timetable updated`, body: `${rec.dayOfWeek} ${rec.startTime}-${rec.endTime}${rec.venue ? ` at ${rec.venue}` : ""}`, link: "/student/timetable" }, actor.studentId);
    return this.timetableDTO(rec, assignment.role);
  }

  /** Finds the entry inside the caller's department and requires it to belong to a class they are STILL assigned to. */
  private async loadManagedTimetableEntry(actor: RepActor, id: string, permission: Permission) {
    const assignments = await this.requireRepresentative(actor);
    const rec = await this.d.store.getTimetableEntry(id, actor.departmentId);
    const assignment = rec ? assignments.find((a) => appointmentCovers(a, rec)) : undefined;
    if (!rec || !assignment) {
      // Another class, another department, a revoked assignment, or no such id: all look the same.
      await this.audit(actor, "ACCESS_DENIED", { resourceType: "COURSE", resourceId: id, detail: { reason: "OUT_OF_SCOPE", attempted: permission } });
      throw new AppError(404, "Timetable entry not found.", undefined, "NOT_FOUND");
    }
    if (rec.source !== "CLASS_REP") {
      await this.deny(actor, "OFFICIAL_TIMETABLE_PROTECTED", 403, "The official departmental timetable can't be changed from here.", { courseId: rec.courseId, role: assignment.role, attempted: permission });
    }
    if (!this.can(assignment.role, permission)) {
      await this.deny(actor, "PERMISSION_DENIED", 403, "Your representative role doesn't allow that.", { courseId: rec.courseId, role: assignment.role, attempted: permission });
    }
    const course = rec.courseId ? await this.d.store.getCourse(rec.courseId, actor.departmentId) : null;
    if (!course) throw new AppError(404, "Timetable entry not found.", undefined, "NOT_FOUND");
    return { rec, assignment, course };
  }

  async updateTimetableEntry(actor: RepActor, id: string, patch: UpdateTimetableInput) {
    const { rec, assignment, course } = await this.loadManagedTimetableEntry(actor, id, "timetable:update");
    // Merge with the stored slot so partial updates are validated as a whole. Only these fields can change.
    const date = patch.date === undefined ? rec.date : patch.date ?? undefined;
    const merged = {
      dayOfWeek: (patch.dayOfWeek ?? (patch.date ? undefined : rec.dayOfWeek)) as Day | undefined, date,
      startTime: patch.startTime ?? rec.startTime, endTime: patch.endTime ?? rec.endTime,
    };
    const { errors, dayOfWeek } = validateSlot(merged);
    if (errors.length || !dayOfWeek) throw new AppError(422, errors[0] ?? "Invalid timetable slot.", errors, "INVALID_TIMETABLE");
    await this.assertNoClash(course, { dayOfWeek, date, startTime: merged.startTime, endTime: merged.endTime }, rec.id);

    const next = await this.d.store.updateTimetableEntry(id, {
      ...(patch.title !== undefined && { title: patch.title }), ...(patch.type !== undefined && { type: patch.type }),
      dayOfWeek, date: date ?? null, startTime: merged.startTime, endTime: merged.endTime,
      // Clearing the venue (empty / null) is allowed: it is optional.
      ...(patch.venue !== undefined && { venue: patch.venue?.trim() || undefined }),
      ...(patch.status !== undefined && { status: patch.status }),
    });
    if (!next) throw new AppError(404, "Timetable entry not found.", undefined, "NOT_FOUND");
    await this.audit(actor, "TIMETABLE_UPDATED", { role: assignment.role, courseId: course.id, courseCode: course.courseCode, resourceType: "COURSE", resourceId: id, detail: { fields: Object.keys(patch) } });
    if (next.status === "PUBLISHED") await this.notifySafely(course, { kind: "TIMETABLE", title: `${course.courseCode}: timetable updated`, body: `${next.dayOfWeek} ${next.startTime}-${next.endTime}${next.venue ? ` at ${next.venue}` : ""}`, link: "/student/timetable" }, actor.studentId);
    return this.timetableDTO(next, assignment.role);
  }

  async deleteTimetableEntry(actor: RepActor, id: string) {
    const { rec, assignment, course } = await this.loadManagedTimetableEntry(actor, id, "timetable:delete");
    await this.d.store.deleteTimetableEntry(id);
    await this.audit(actor, "TIMETABLE_DELETED", { role: assignment.role, courseId: course.id, courseCode: course.courseCode, resourceType: "COURSE", resourceId: id, detail: { day: rec.dayOfWeek, start: rec.startTime, end: rec.endTime } });
    if (rec.status === "PUBLISHED") await this.notifySafely(course, { kind: "TIMETABLE", title: `${course.courseCode}: timetable updated`, body: `A ${rec.dayOfWeek} ${rec.startTime} slot was removed`, link: "/student/timetable" }, actor.studentId);
  }

  /* ------------------------------ announcements ------------------------------ */
  private announcementDTO(a: AnnouncementRec, viewerId: string, role: AssignmentRec["role"]) {
    const mine = a.createdByStudentId === viewerId;
    return {
      id: a.id, courseId: a.courseId ?? null, courseCode: a.courseCode ?? null, audience: a.courseId ? "COURSE" : "LEVEL", level: a.level, academicSession: a.academicSession, semester: a.semester,
      title: a.title, message: a.body, priority: a.priority, status: a.status, image: a.image ? { url: a.image.url } : null,
      author: { name: a.createdByName, role: a.createdByRole }, mine,
      publishedAt: a.publishedAt ?? null, expiresAt: a.expiresAt ?? null, createdAt: a.createdAt, updatedAt: a.updatedAt,
      canEdit: mine && this.can(role, "announcement:update:own"),
      canUnpublish: mine && this.can(role, "announcement:unpublish:own"),
      canDelete: mine && this.can(role, "announcement:delete:own"),
    };
  }

  async listAnnouncements(actor: RepActor, q: { courseId?: string }) {
    const assignments = await this.requireRepresentative(actor);
    await this.requirePermission(actor, assignments, "announcement:view");
    const pairs = await this.coveredCourses(actor, assignments, q.courseId);
    const scoped = [...new Map(pairs.map((p) => [p.assignment.id, p.assignment])).values()];
    // Course-targeted announcements for the covered courses, plus class-wide (level) announcements of the levels the rep is appointed to.
    const rows = await this.d.store.listAnnouncements(actor.departmentId, {
      courseIds: pairs.map((p) => p.course.id),
      classes: scoped.filter((a) => a.scope === "LEVEL").map((a) => ({ level: a.level, academicSession: a.academicSession, semester: a.semester })),
    }, actor.studentId);
    return rows.map((r) => this.announcementDTO(r, actor.studentId, (scoped.find((a) => appointmentCovers(a, r)) ?? scoped[0]).role));
  }

  private async checkImage(buffer: Buffer | undefined) {
    if (buffer && !sniffImage(buffer)) throw new AppError(415, "Only JPEG, PNG or WebP images can be attached.", undefined, "UNSUPPORTED_FILE_TYPE");
  }

  /** Tells the audience: the enrolled students of one course, or every student of the level for a class-wide announcement. */
  private async notifyAudience(rec: { courseId?: string; level: string; academicSession: string; title: string; body: string }, course: CourseRec | undefined, departmentId: string, authorId: string) {
    try {
      if (course) await this.d.notifyClass(course, { kind: "ANNOUNCEMENT", title: `${course.courseCode}: ${rec.title}`, body: rec.body.slice(0, 200), link: "/student/announcements" }, authorId);
      else await this.d.notifyLevel({ departmentId, level: rec.level, academicSession: rec.academicSession }, { kind: "ANNOUNCEMENT", title: `${rec.level} Level: ${rec.title}`, body: rec.body.slice(0, 200), link: "/student/announcements" }, authorId);
    } catch {
      /* best-effort */
    }
  }

  /**
   * The audience is ALWAYS derived from the appointment, never from the request: with a `courseId` (which must be inside the rep's level) it is that
   * course's class; without one it is the rep's whole level. A rep appointed for a level never needs to name a course to announce to their class.
   */
  async createAnnouncement(actor: RepActor, input: CreateAnnouncementInput) {
    await this.checkImage(input.image);
    let assignment: AssignmentRec; let course: CourseRec | undefined;
    if (input.courseId) {
      ({ assignment, course } = await this.authorizeCourse(actor, input.courseId, "announcement:create"));
    } else {
      const assignments = await this.requireRepresentative(actor);
      const levels = assignments.filter((a) => a.scope === "LEVEL");
      if (levels.length === 1) assignment = levels[0];
      else if (!levels.length && assignments.length === 1 && assignments[0].courseId) ({ assignment, course } = await this.authorizeCourse(actor, assignments[0].courseId, "announcement:create"));
      else throw new AppError(422, "Choose which course this is for.", undefined, "COURSE_REQUIRED");
      if (!this.can(assignment.role, "announcement:create")) await this.deny(actor, "PERMISSION_DENIED", 403, "Your representative role doesn't allow that.", { role: assignment.role, attempted: "announcement:create" });
    }
    const priority = input.priority ?? "NORMAL";
    if (!priorityAllowed(assignment.role, priority)) {
      await this.deny(actor, "PRIORITY_NOT_ALLOWED", 403, `Your role can't send ${priority.toLowerCase()} announcements.`, { courseId: course?.id, role: assignment.role, attempted: `priority:${priority}` });
    }
    const status: AnnouncementStatus = input.status ?? "PUBLISHED";
    const now = this.d.now();
    const image = input.image ? await this.d.uploadAnnouncementImage(input.image) : undefined;
    const rec = await this.d.store.createAnnouncement({
      departmentId: actor.departmentId, courseId: course?.id, courseCode: course?.courseCode, level: course?.level ?? assignment.level,
      academicSession: course?.academicSession ?? assignment.academicSession, semester: course?.semester ?? assignment.semester,
      title: input.title, body: input.body, priority, status, image,
      createdByStudentId: actor.studentId, createdByRole: assignment.role, createdByName: fullName(actor),
      publishedAt: status === "PUBLISHED" ? now : undefined, expiresAt: input.expiresAt,
    }).catch(async (err) => { if (image?.publicId) await this.d.deleteAnnouncementImage(image.publicId).catch(() => undefined); throw err; });
    await this.audit(actor, "ANNOUNCEMENT_CREATED", { role: assignment.role, courseId: course?.id, courseCode: course?.courseCode, resourceType: "ANNOUNCEMENT", resourceId: rec.id, detail: { title: rec.title, status, priority, level: rec.level, withImage: Boolean(image) } });
    if (status === "PUBLISHED") await this.notifyAudience(rec, course, actor.departmentId, actor.studentId);
    return this.announcementDTO(rec, actor.studentId, assignment.role);
  }

  /** Looks the announcement up inside the caller's department, then requires it to be inside an appointment they STILL hold (its level / course). */
  private async loadOwnAnnouncement(actor: RepActor, id: string): Promise<{ rec: AnnouncementRec; assignment: AssignmentRec; course?: CourseRec }> {
    const assignments = await this.requireRepresentative(actor);
    const rec = await this.d.store.getAnnouncement(id, actor.departmentId);
    const assignment = rec && rec.status !== "DELETED" ? assignments.find((a) => appointmentCovers(a, rec)) : undefined;
    if (!rec || !assignment) {
      // Wrong department, other class, deleted, or an appointment that has since been revoked: all look the same.
      await this.audit(actor, "ACCESS_DENIED", { resourceType: "ANNOUNCEMENT", resourceId: id, detail: { reason: "OUT_OF_SCOPE" } });
      throw new AppError(404, "Announcement not found.", undefined, "NOT_FOUND");
    }
    const course = rec.courseId ? (await this.d.store.getCourse(rec.courseId, actor.departmentId)) ?? undefined : undefined;
    if (rec.courseId && !course) throw new AppError(404, "Announcement not found.", undefined, "NOT_FOUND");
    return { rec, assignment, course };
  }

  private async requireOwn(actor: RepActor, rec: { createdByStudentId?: string }, assignment: AssignmentRec, permission: Permission, courseId?: string) {
    if (!this.can(assignment.role, permission)) {
      await this.deny(actor, "PERMISSION_DENIED", 403, "Your representative role doesn't allow that.", { courseId, role: assignment.role, attempted: permission });
    }
    if (rec.createdByStudentId !== actor.studentId) {
      await this.deny(actor, "NOT_OWNER", 403, "You can only change items you created.", { courseId, role: assignment.role, attempted: permission });
    }
  }

  async updateAnnouncement(actor: RepActor, id: string, patch: UpdateAnnouncementInput) {
    if (!Object.values(patch).some((v) => v !== undefined)) throw new AppError(422, "Provide at least one field to update.", undefined, "NOTHING_TO_UPDATE");
    const { rec, assignment, course } = await this.loadOwnAnnouncement(actor, id);
    const unpublishing = patch.status === "UNPUBLISHED";
    await this.requireOwn(actor, rec, assignment, unpublishing ? "announcement:unpublish:own" : "announcement:update:own", rec.courseId);
    if (patch.priority && !priorityAllowed(assignment.role, patch.priority)) {
      await this.deny(actor, "PRIORITY_NOT_ALLOWED", 403, `Your role can't send ${patch.priority.toLowerCase()} announcements.`, { courseId: rec.courseId, role: assignment.role, attempted: `priority:${patch.priority}` });
    }
    await this.checkImage(patch.image);
    const previousImageId = rec.image?.publicId; // read BEFORE the write: it must be the old picture that gets deleted
    const wasPublished = rec.status === "PUBLISHED";
    const nowPublishing = patch.status === "PUBLISHED" && !wasPublished;
    const newImage = patch.image ? await this.d.uploadAnnouncementImage(patch.image) : undefined;
    // Only editable fields are ever copied across: course, department, level, term and author can't be changed.
    const next = await this.d.store.updateAnnouncement(id, {
      ...(patch.title !== undefined && { title: patch.title }), ...(patch.body !== undefined && { body: patch.body }),
      ...(patch.priority !== undefined && { priority: patch.priority }), ...(patch.expiresAt !== undefined && { expiresAt: patch.expiresAt }),
      ...(patch.status !== undefined && { status: patch.status }), ...(nowPublishing && { publishedAt: this.d.now() }),
      ...(newImage ? { image: newImage } : patch.removeImage ? { image: null } : {}),
    }).catch(async (err) => { if (newImage?.publicId) await this.d.deleteAnnouncementImage(newImage.publicId).catch(() => undefined); throw err; });
    if (!next) { if (newImage?.publicId) await this.d.deleteAnnouncementImage(newImage.publicId).catch(() => undefined); throw new AppError(404, "Announcement not found.", undefined, "NOT_FOUND"); }
    if ((newImage || patch.removeImage) && previousImageId && previousImageId !== newImage?.publicId) await this.d.deleteAnnouncementImage(previousImageId).catch(() => undefined);
    await this.audit(actor, unpublishing ? "ANNOUNCEMENT_UNPUBLISHED" : "ANNOUNCEMENT_UPDATED", {
      role: assignment.role, courseId: rec.courseId, courseCode: rec.courseCode, resourceType: "ANNOUNCEMENT", resourceId: id, detail: { fields: Object.keys(patch).filter((k) => k !== "image"), image: newImage ? "replaced" : patch.removeImage ? "removed" : undefined },
    });
    if (nowPublishing) await this.notifyAudience(next, course, actor.departmentId, actor.studentId);
    return this.announcementDTO(next, actor.studentId, assignment.role);
  }

  /** Soft delete: the row is kept (status DELETED) for the audit trail; it disappears for everyone, and its picture is removed from storage. */
  async deleteAnnouncement(actor: RepActor, id: string) {
    const { rec, assignment } = await this.loadOwnAnnouncement(actor, id);
    await this.requireOwn(actor, rec, assignment, "announcement:delete:own", rec.courseId);
    const previousImageId = rec.image?.publicId;
    await this.d.store.updateAnnouncement(id, { status: "DELETED", ...(rec.image ? { image: null } : {}) });
    if (previousImageId) await this.d.deleteAnnouncementImage(previousImageId).catch(() => undefined);
    await this.audit(actor, "ANNOUNCEMENT_DELETED", { role: assignment.role, courseId: rec.courseId, courseCode: rec.courseCode, resourceType: "ANNOUNCEMENT", resourceId: id, detail: { title: rec.title } });
  }

  /* ------------------------------ class resources ------------------------------ */
  private resourceDTO(r: ResourceRec, viewerId: string, role: AssignmentRec["role"]) {
    const mine = r.type === "CLASS_RESOURCE" && r.createdByStudentId === viewerId;
    return {
      id: r.id, courseId: r.courseId ?? null, courseCode: r.courseCode ?? null, level: r.level, academicSession: r.academicSession, semester: r.semester,
      title: r.title, description: r.description ?? null, type: r.type, resourceType: r.resourceType ?? null,
      file: { url: r.file.url, name: r.file.originalName, mimeType: r.file.mimeType, sizeBytes: r.file.sizeBytes },
      uploadedBy: { name: r.uploadedByName, role: r.uploadedByRole }, status: r.status, mine, createdAt: r.createdAt, updatedAt: r.updatedAt,
      // Official lecturer material is never editable from here, whoever is asking.
      canEdit: mine && this.can(role, "resource:update:own"), canDelete: mine && this.can(role, "resource:delete:own"),
    };
  }

  async listResources(actor: RepActor, q: { courseId?: string }) {
    const assignments = await this.requireRepresentative(actor);
    await this.requirePermission(actor, assignments, "resource:view");
    const pairs = (await this.coveredCourses(actor, assignments, q.courseId)).filter((p) => this.can(p.assignment.role, "resource:view"));
    const roleOf = new Map(pairs.map((p) => [p.course.id, p.assignment.role]));
    const rows = await this.d.store.listResources(pairs.map((p) => p.course));
    return rows.map((r) => this.resourceDTO(r, actor.studentId, roleOf.get(r.courseId ?? "") ?? pairs[0].assignment.role));
  }

  async createResource(actor: RepActor, input: CreateResourceInput) {
    const courseId = await this.resolveCourseId(actor, input.courseId);
    const { assignment, course } = await this.authorizeCourse(actor, courseId, "resource:create");

    // Exactly one source: an uploaded file OR an https link.
    if (Boolean(input.file) === Boolean(input.fileUrl)) {
      throw new AppError(422, "Provide either a file or a link, not both.", undefined, "INVALID_RESOURCE_SOURCE");
    }
    let file: StoredFile;
    if (input.file) file = await this.d.uploadFile(input.file);
    else file = { url: input.fileUrl as string, originalName: input.title, mimeType: "text/uri-list", sizeBytes: 0 };

    const rec = await this.d.store.createResource({
      departmentId: course.departmentId, courseId: course.id, courseCode: course.courseCode, level: course.level,
      academicSession: course.academicSession, semester: course.semester, title: input.title, description: input.description,
      type: "CLASS_RESOURCE", // reps can never create OFFICIAL_COURSE_MATERIAL
      resourceType: input.resourceType, file, createdByStudentId: actor.studentId,
      uploadedByName: fullName(actor), uploadedByRole: assignment.role, status: "PUBLISHED",
    });
    await this.audit(actor, "RESOURCE_UPLOADED", { role: assignment.role, courseId: course.id, courseCode: course.courseCode, resourceType: "RESOURCE", resourceId: rec.id, detail: { title: rec.title, resourceType: input.resourceType } });
    await this.notifySafely(course, { kind: "MATERIAL", title: `${course.courseCode}: new class resource`, body: rec.title, link: "/student/materials" }, actor.studentId);
    return this.resourceDTO(rec, actor.studentId, assignment.role);
  }

  private async loadOwnResource(actor: RepActor, id: string, permission: Permission) {
    const assignments = await this.requireRepresentative(actor);
    const rec = await this.d.store.getResource(id, actor.departmentId);
    const assignment = rec?.courseId ? assignments.find((a) => appointmentCovers(a, rec)) : undefined;
    if (!rec || !assignment) {
      await this.audit(actor, "ACCESS_DENIED", { resourceType: "RESOURCE", resourceId: id, detail: { reason: "OUT_OF_SCOPE" } });
      throw new AppError(404, "Resource not found.", undefined, "NOT_FOUND");
    }
    if (rec.type !== "CLASS_RESOURCE") {
      await this.deny(actor, "OFFICIAL_MATERIAL_PROTECTED", 403, "Official course materials can only be managed by the lecturer.", { courseId: rec.courseId, role: assignment.role, attempted: permission });
    }
    await this.requireOwn(actor, { createdByStudentId: rec.createdByStudentId }, assignment, permission, rec.courseId as string);
    const course = await this.d.store.getCourse(rec.courseId as string, actor.departmentId);
    if (!course) throw new AppError(404, "Resource not found.", undefined, "NOT_FOUND");
    return { rec, assignment, course };
  }

  async updateResource(actor: RepActor, id: string, patch: UpdateResourceInput) {
    const { assignment, course } = await this.loadOwnResource(actor, id, "resource:update:own");
    const next = await this.d.store.updateResource(id, {
      ...(patch.title !== undefined && { title: patch.title }), ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.resourceType !== undefined && { resourceType: patch.resourceType }), ...(patch.status !== undefined && { status: patch.status }),
    });
    if (!next) throw new AppError(404, "Resource not found.", undefined, "NOT_FOUND");
    await this.audit(actor, "RESOURCE_UPDATED", { role: assignment.role, courseId: course.id, courseCode: course.courseCode, resourceType: "RESOURCE", resourceId: id, detail: { fields: Object.keys(patch) } });
    return this.resourceDTO(next, actor.studentId, assignment.role);
  }

  async deleteResource(actor: RepActor, id: string) {
    const { rec, assignment, course } = await this.loadOwnResource(actor, id, "resource:delete:own");
    await this.d.store.deleteResource(id);
    if (rec.file.publicId) await this.d.deleteFile(rec.file).catch(() => undefined);
    await this.audit(actor, "RESOURCE_DELETED", { role: assignment.role, courseId: course.id, courseCode: course.courseCode, resourceType: "RESOURCE", resourceId: id, detail: { title: rec.title } });
  }

  /* ------------------------------ overview / notifications ------------------------------ */
  async overview(actor: RepActor) {
    const assignments = await this.requireRepresentative(actor);
    const classes = [];
    for (const a of assignments) {
      if (!this.can(a.role, "overview:view")) continue;
      const level = a.scope === "LEVEL";
      const courses = level
        ? await this.d.store.listCoursesForLevel(actor.departmentId, a.level, a.academicSession, a.semester)
        : [await this.d.store.getCourse(a.courseId as string, actor.departmentId)].filter((c): c is CourseRec => Boolean(c));
      if (!courses.length && !level) continue;
      const [members, announcements, resources, timetable] = await Promise.all([
        level ? this.d.store.countLevelStudents(actor.departmentId, a.level, a.academicSession) : this.d.store.countMembers(courses[0]),
        this.d.store.listAnnouncements(actor.departmentId, { courseIds: courses.map((c) => c.id), classes: level ? [{ level: a.level, academicSession: a.academicSession, semester: a.semester }] : [] }, actor.studentId),
        this.d.store.listResources(courses),
        this.d.store.listTimetable(courses, "course"),
      ]);
      classes.push({
        role: a.role, scope: level ? "LEVEL" : "COURSE", level: a.level, academicSession: a.academicSession, semester: a.semester,
        course: level ? null : this.courseDTO(courses[0]), courses: courses.map((c) => this.courseDTO(c)), memberCount: members,
        announcements: { published: announcements.filter((x) => x.status === "PUBLISHED").length, mine: announcements.filter((x) => x.createdByStudentId === actor.studentId).length },
        resources: { total: resources.length, classResources: resources.filter((x) => x.type === "CLASS_RESOURCE").length, mine: resources.filter((x) => x.createdByStudentId === actor.studentId).length },
        timetableSlots: timetable.length,
        permissions: [...this.table[a.role]],
      });
    }
    return { classes, unreadNotifications: await this.d.unreadNotifications(actor.studentId) };
  }

  private async notifySafely(course: CourseRec, n: Parameters<RepDeps["notifyClass"]>[1], excludeStudentId: string) {
    try {
      await this.d.notifyClass(course, n, excludeStudentId);
    } catch {
      /* best-effort */
    }
  }
}
