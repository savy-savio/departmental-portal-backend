import type { FilterQuery } from "mongoose";
import { AcademicTerm } from "../../models/AcademicTerm";
import { Announcement, AnnouncementDocument } from "../../models/Announcement";
import { Course, CourseDocument } from "../../models/Course";
import { CourseEnrollment } from "../../models/CourseEnrollment";
import { CourseRepresentativeAssignment, CourseRepresentativeAssignmentDocument } from "../../models/CourseRepresentativeAssignment";
import { Material, MaterialDocument } from "../../models/Material";
import { RepresentativeAuditLog } from "../../models/RepresentativeAuditLog";
import { Student } from "../../models/Student";
import { lecturersByCourse } from "../course-lecturers";
import { TimetableEntry, TimetableEntryDocument } from "../../models/TimetableEntry";
import type { AnnouncementViewScope, RepresentativeStore } from "./store";
import type { AnnouncementRec, AssignmentRec, AuditRec, CourseRec, MemberRec, ResourceRec, TimetableRec } from "./types";

const id = (v: unknown) => String(v);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toAssignment = (a: CourseRepresentativeAssignmentDocument): AssignmentRec => ({
  id: id(a._id), studentId: id(a.student), departmentId: id(a.department), scope: a.scope ?? (a.course ? "COURSE" : "LEVEL"),
  courseId: a.course ? id(a.course) : undefined, courseCode: a.courseCode ?? undefined, level: a.level, academicSession: a.academicSession, semester: a.semester, role: a.role, status: a.status,
  assignedBy: { name: a.assignedBy.name, role: a.assignedBy.role }, assignedAt: a.assignedAt, revokedAt: a.revokedAt ?? undefined,
});
const toCourse = (c: CourseDocument): CourseRec => ({
  id: id(c._id), departmentId: id(c.department), courseCode: c.courseCode, title: c.title, units: c.units, level: c.level,
  semester: c.semester, academicSession: c.academicSession, status: c.status,
});
const stamps = (d: unknown) => d as { createdAt: Date; updatedAt: Date };
const toAnnouncement = (a: AnnouncementDocument): AnnouncementRec => ({
  id: id(a._id), departmentId: id(a.department), courseId: a.course ? id(a.course) : undefined, courseCode: a.audience.courseCodes?.[0] ?? undefined,
  level: a.level ?? "", academicSession: a.academicSession ?? "", semester: (a.semester ?? "FIRST") as "FIRST" | "SECOND",
  title: a.title, body: a.body, priority: a.priority, status: a.status as AnnouncementRec["status"],
  createdByStudentId: id(a.createdByStudent), createdByRole: a.createdByRole, createdByName: a.createdByName,
  image: a.image?.url ? { url: a.image.url, publicId: a.image.publicId ?? undefined } : undefined,
  publishedAt: a.status === "PUBLISHED" ? a.publishedAt : undefined, expiresAt: a.expiresAt ?? null,
  createdAt: stamps(a).createdAt, updatedAt: stamps(a).updatedAt,
});

/** MongoDB implementation. Department is part of every lookup; reps can only ever reach rep-authored announcements / class resources. */
export class MongoRepresentativeStore implements RepresentativeStore {
  async getCurrentTerm(departmentId: string) {
    const t = await AcademicTerm.findOne({ department: departmentId, isCurrent: true });
    return t ? { academicSession: t.academicSession, semester: t.semester } : null;
  }
  async assignmentsForStudent(studentId: string) {
    return (await CourseRepresentativeAssignment.find({ student: studentId }).sort({ assignedAt: -1 })).map(toAssignment);
  }
  async getCourse(courseId: string, departmentId: string) {
    const c = await Course.findOne({ _id: courseId, department: departmentId });
    return c ? toCourse(c) : null;
  }

  async listCoursesForLevel(departmentId: string, level: string, academicSession: string, semester: "FIRST" | "SECOND") {
    return (await Course.find({ department: departmentId, level, academicSession, semester, status: "ACTIVE" }).sort({ courseCode: 1 })).map(toCourse);
  }
  async countLevelStudents(departmentId: string, level: string, academicSession: string) {
    return Student.countDocuments({ department: departmentId, level, academicSession, status: "ACTIVE" });
  }

  private enrollmentFilter(course: CourseRec) {
    return { department: course.departmentId, courseCode: course.courseCode, academicSession: course.academicSession, semester: course.semester, status: "ENROLLED" as const };
  }
  async listMembers(course: CourseRec, q: { page: number; limit: number; search?: string }) {
    const enr = await CourseEnrollment.find(this.enrollmentFilter(course)).select("student enrollmentType");
    const typeOf = new Map(enr.map((e) => [id(e.student), e.enrollmentType]));
    const filter: FilterQuery<unknown> = { _id: { $in: enr.map((e) => e.student) }, department: course.departmentId };
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), "i");
      filter.$or = [{ firstName: rx }, { lastName: rx }, { matricNumber: rx }];
    }
    const [total, rows] = await Promise.all([
      Student.countDocuments(filter),
      // Only the fields a class list needs: never email, phone, password data.
      Student.find(filter).select("firstName lastName matricNumber profilePhoto level").sort({ lastName: 1, firstName: 1 }).skip((q.page - 1) * q.limit).limit(q.limit),
    ]);
    const items: MemberRec[] = rows.map((s) => ({
      studentId: id(s._id), firstName: s.firstName, lastName: s.lastName, matricNumber: s.matricNumber,
      profilePhoto: s.profilePhoto ?? undefined, level: s.level, enrollmentType: typeOf.get(id(s._id)) ?? "REGULAR",
    }));
    return { items, total };
  }
  async countMembers(course: CourseRec) {
    return CourseEnrollment.countDocuments(this.enrollmentFilter(course));
  }
  /** The lecturers actually ASSIGNED to the course (active assignment), not names typed into timetable entries. */
  async lecturerNames(course: CourseRec) {
    const m = await lecturersByCourse(course.departmentId, [course.id]);
    return (m.get(course.id) ?? []).map((l) => l.name);
  }
  private toTimetable(e: TimetableEntryDocument): TimetableRec {
    return {
      id: id(e._id), departmentId: id(e.department), courseId: e.course ? id(e.course) : undefined, courseCode: e.courseCode ?? undefined,
      level: e.level, academicSession: e.academicSession, semester: e.semester, title: e.title, type: e.type, dayOfWeek: e.dayOfWeek,
      date: e.date ?? undefined, startTime: e.startTime, endTime: e.endTime, venue: e.venue ?? undefined, lecturerName: e.lecturerName ?? undefined,
      // Entries created before the class-timetable feature have no source/status: they are official and published.
      source: e.source ?? "OFFICIAL", status: e.status ?? "PUBLISHED",
      createdByStudentId: e.createdByStudent ? id(e.createdByStudent) : undefined, createdByRole: e.createdByRole ?? undefined,
      createdAt: stamps(e).createdAt, updatedAt: stamps(e).updatedAt,
    };
  }
  async listTimetable(courses: CourseRec[], view: "course" | "class"): Promise<TimetableRec[]> {
    if (!courses.length) return [];
    const rows = await TimetableEntry.find({
      $or: courses.map((c) => ({
        department: c.departmentId, academicSession: c.academicSession, semester: c.semester,
        ...(view === "class" ? { level: c.level } : { courseCode: c.courseCode }),
      })),
    });
    return rows.map((e) => this.toTimetable(e));
  }
  async createTimetableEntry(rec: Omit<TimetableRec, "id" | "createdAt" | "updatedAt">) {
    const e = await TimetableEntry.create({
      department: rec.departmentId, course: rec.courseId, courseCode: rec.courseCode, level: rec.level, academicSession: rec.academicSession,
      semester: rec.semester, title: rec.title, type: rec.type, dayOfWeek: rec.dayOfWeek, date: rec.date, startTime: rec.startTime,
      endTime: rec.endTime, venue: rec.venue, lecturerName: rec.lecturerName, source: "CLASS_REP", status: rec.status,
      createdByStudent: rec.createdByStudentId, createdByRole: rec.createdByRole,
    });
    return this.toTimetable(e);
  }
  async getTimetableEntry(entryId: string, departmentId: string) {
    const e = await TimetableEntry.findOne({ _id: entryId, department: departmentId });
    return e ? this.toTimetable(e) : null;
  }
  async updateTimetableEntry(entryId: string, patch: Parameters<RepresentativeStore["updateTimetableEntry"]>[1]) {
    const { date, ...rest } = patch;
    const update: Record<string, unknown> = { $set: { ...rest, ...(date ? { date } : {}) } };
    if (date === null) update.$unset = { date: "" };
    // Defence in depth: only class-rep entries can ever be modified through this store method.
    const e = await TimetableEntry.findOneAndUpdate({ _id: entryId, source: "CLASS_REP" }, update, { new: true, runValidators: true });
    return e ? this.toTimetable(e) : null;
  }
  async deleteTimetableEntry(entryId: string) {
    await TimetableEntry.deleteOne({ _id: entryId, source: "CLASS_REP" });
  }

  async createAnnouncement(rec: Omit<AnnouncementRec, "id" | "createdAt" | "updatedAt">) {
    const a = await Announcement.create({
      department: rec.departmentId, title: rec.title, body: rec.body, priority: rec.priority, status: rec.status,
      // The audience is built here from the appointment / chosen course; it is never copied from request data.
      // One course -> its enrolled class; no course -> the rep's whole level (students of that level in that session).
      audience: rec.courseId ? { scope: "COURSE", courseCodes: [rec.courseCode] } : { scope: "CLASS", levels: [rec.level], academicSession: rec.academicSession },
      createdByName: rec.createdByName, createdByRole: rec.createdByRole, createdByStudent: rec.createdByStudentId,
      ...(rec.courseId ? { course: rec.courseId } : {}), level: rec.level, academicSession: rec.academicSession, semester: rec.semester,
      ...(rec.image ? { image: { url: rec.image.url, publicId: rec.image.publicId } } : {}),
      publishedAt: rec.publishedAt ?? new Date(), expiresAt: rec.expiresAt ?? undefined,
    });
    return toAnnouncement(a);
  }
  async getAnnouncement(announcementId: string, departmentId: string) {
    // Only student-written (rep) announcements are reachable from here: staff-written ones are not.
    const a = await Announcement.findOne({ _id: announcementId, department: departmentId, createdByStudent: { $exists: true } }).select("+image.publicId");
    return a ? toAnnouncement(a) : null;
  }
  async updateAnnouncement(announcementId: string, patch: Parameters<RepresentativeStore["updateAnnouncement"]>[1]) {
    const { expiresAt, image, ...rest } = patch;
    const $set: Record<string, unknown> = { ...rest, ...(expiresAt ? { expiresAt } : {}) };
    const $unset: Record<string, ""> = {};
    if (expiresAt === null) $unset.expiresAt = "";
    if (image === null) $unset.image = ""; else if (image) $set.image = { url: image.url, publicId: image.publicId };
    const a = await Announcement.findOneAndUpdate({ _id: announcementId, createdByStudent: { $exists: true } }, { $set, ...(Object.keys($unset).length ? { $unset } : {}) }, { new: true, runValidators: true }).select("+image.publicId");
    return a ? toAnnouncement(a) : null;
  }
  async listAnnouncements(departmentId: string, scope: AnnouncementViewScope, viewerStudentId: string) {
    const where: FilterQuery<unknown>[] = [];
    if (scope.courseIds.length) where.push({ course: { $in: scope.courseIds } });
    for (const c of scope.classes) where.push({ course: { $exists: false }, level: c.level, academicSession: c.academicSession, semester: c.semester });
    if (!where.length) return [];
    const rows = await Announcement.find({
      department: departmentId,
      createdByStudent: { $exists: true }, // only representative-written announcements; staff announcements never appear in this view
      $and: [{ $or: where }, { $or: [{ status: "PUBLISHED" }, { createdByStudent: viewerStudentId, status: { $in: ["DRAFT", "UNPUBLISHED"] } }] }],
    }).select("+image.publicId").sort({ createdAt: -1 }).limit(300);
    return rows.map(toAnnouncement);
  }

  private async toResource(m: MaterialDocument, courseIdByKey?: Map<string, string>): Promise<ResourceRec> {
    let courseId = m.course ? id(m.course) : undefined;
    if (!courseId && m.courseCode) {
      const key = `${id(m.department)}|${m.courseCode}|${m.academicSession}|${m.semester}`;
      courseId = courseIdByKey?.get(key) ?? (await Course.findOne({ department: m.department, courseCode: m.courseCode, academicSession: m.academicSession, semester: m.semester }).select("_id"))?._id?.toString();
    }
    return {
      id: id(m._id), departmentId: id(m.department), courseId, courseCode: m.courseCode ?? undefined, level: m.level,
      academicSession: m.academicSession, semester: m.semester, title: m.title, description: m.description ?? undefined,
      type: m.type, resourceType: (m.resourceType ?? undefined) as ResourceRec["resourceType"],
      file: { url: m.file.url, publicId: m.file.publicId ?? undefined, originalName: m.file.originalName, mimeType: m.file.mimeType, sizeBytes: m.file.sizeBytes },
      createdByStudentId: m.createdByStudent ? id(m.createdByStudent) : undefined, uploadedByName: m.uploadedByName, uploadedByRole: m.uploadedByRole,
      status: m.status, createdAt: stamps(m).createdAt, updatedAt: stamps(m).updatedAt,
    };
  }
  async createResource(rec: Omit<ResourceRec, "id" | "createdAt" | "updatedAt">) {
    const m = await Material.create({
      department: rec.departmentId, title: rec.title, description: rec.description, type: "CLASS_RESOURCE",
      courseCode: rec.courseCode, level: rec.level, semester: rec.semester, academicSession: rec.academicSession,
      file: { url: rec.file.url, publicId: rec.file.publicId, originalName: rec.file.originalName, mimeType: rec.file.mimeType, sizeBytes: rec.file.sizeBytes },
      uploadedByName: rec.uploadedByName, uploadedByRole: rec.uploadedByRole, status: rec.status,
      course: rec.courseId, createdByStudent: rec.createdByStudentId, resourceType: rec.resourceType,
    });
    return this.toResource(m);
  }
  async getResource(resourceId: string, departmentId: string) {
    // Includes OFFICIAL materials on purpose so the engine can answer "protected" instead of pretending they don't exist.
    const m = await Material.findOne({ _id: resourceId, department: departmentId });
    return m ? this.toResource(m) : null;
  }
  async updateResource(resourceId: string, patch: Partial<Pick<ResourceRec, "title" | "description" | "resourceType" | "status">>) {
    // Defence in depth: even a bug upstream can't make this touch an official material.
    const m = await Material.findOneAndUpdate({ _id: resourceId, type: "CLASS_RESOURCE" }, { $set: patch }, { new: true, runValidators: true });
    return m ? this.toResource(m) : null;
  }
  async deleteResource(resourceId: string) {
    await Material.deleteOne({ _id: resourceId, type: "CLASS_RESOURCE" });
  }
  async listResources(courses: CourseRec[]) {
    if (!courses.length) return [];
    const byKey = new Map(courses.map((c) => [`${c.departmentId}|${c.courseCode}|${c.academicSession}|${c.semester}`, c.id]));
    const rows = await Material.find({
      status: "PUBLISHED",
      $or: courses.map((c) => ({ department: c.departmentId, courseCode: c.courseCode, academicSession: c.academicSession, semester: c.semester })),
    }).sort({ createdAt: -1 }).limit(500);
    return Promise.all(rows.map((m) => this.toResource(m, byKey)));
  }

  async addAudit(rec: AuditRec) {
    await RepresentativeAuditLog.create({
      actor: rec.actorId, role: rec.role, action: rec.action, resourceType: rec.resourceType, resourceId: rec.resourceId,
      course: rec.courseId, courseCode: rec.courseCode, department: rec.departmentId, detail: rec.detail, at: rec.at,
    });
  }
}
