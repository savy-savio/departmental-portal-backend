import { Types, type FilterQuery } from "mongoose";
import { AcademicTerm } from "../../models/AcademicTerm";
import { Announcement, AnnouncementDocument } from "../../models/Announcement";
import { AttendanceRecord } from "../../models/AttendanceRecord";
import { AttendanceSecurityLog } from "../../models/AttendanceSecurityLog";
import { AttendanceSession, AttendanceSessionDocument } from "../../models/AttendanceSession";
import { Complaint, ComplaintDocument } from "../../models/Complaint";
import { lecturersByCourse } from "../course-lecturers";
import { Course, CourseDocument } from "../../models/Course";
import { CourseEnrollment } from "../../models/CourseEnrollment";
import { CourseRepresentativeAssignment, CourseRepresentativeAssignmentDocument } from "../../models/CourseRepresentativeAssignment";
import { Department } from "../../models/Department";
import { DepartmentDocumentModel, DepartmentDocumentDocument } from "../../models/DepartmentDocument";
import { Hod, HodDocument } from "../../models/Hod";
import { HodAuditLog } from "../../models/HodAuditLog";
import { Lecturer, LecturerDocument } from "../../models/Lecturer";
import { LecturerAuditLog } from "../../models/LecturerAuditLog";
import { LecturerCourseAssignment } from "../../models/LecturerCourseAssignment";
import { Material } from "../../models/Material";
import { Notification, NotificationDocument } from "../../models/Notification";
import { RepresentativeAuditLog } from "../../models/RepresentativeAuditLog";
import { Student, StudentDocument } from "../../models/Student";
import { TimetableEntry, TimetableEntryDocument } from "../../models/TimetableEntry";
import { StoreDuplicateError, type HodStore } from "./store";
import type {
  ActivityItem, AttendanceRecordView, ComplaintEvent, ComplaintPatch, ComplaintRec, CourseRec, CourseView, DashboardCounts, DeptRec, DocumentRec, EnrollmentView, HodAnnouncementRec,
  HodAuditRec, HodRec, LecturerAssignmentRec, LecturerAssignmentView, LecturerRow, ListQuery, MaterialOverview, NotificationView, Page, RepAssignmentView, SessionView, StudentRow,
  TermRec, TimetableRec,
} from "./types";

const id = (v: unknown) => String(v);
const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stamps = (d: unknown) => d as { createdAt: Date; updatedAt: Date };
const skipLimit = (q: ListQuery) => ({ skip: (q.page - 1) * q.limit, limit: q.limit });
/** Sort whitelist per list: an unknown `sort` falls back to the default (and HTTP validation already restricts it). */
const sortOf = (q: ListQuery, allowed: string[], fallback: Record<string, 1 | -1>): Record<string, 1 | -1> =>
  q.sort && allowed.includes(q.sort) ? { [q.sort]: q.order === "desc" ? -1 : 1 } : fallback;
type TermLike = { academicSession: string; semester: string };

const toHod = (h: HodDocument): HodRec => ({ id: id(h._id), firstName: h.firstName, lastName: h.lastName, email: h.email, phone: h.phone ?? undefined, staffId: h.staffId, departmentId: id(h.department), role: h.role, profilePhoto: h.profilePhoto ?? undefined, profilePhotoPublicId: h.profilePhotoPublicId ?? undefined, status: h.status, createdAt: stamps(h).createdAt, updatedAt: stamps(h).updatedAt });
const toStudent = (s: StudentDocument): StudentRow => ({ id: id(s._id), firstName: s.firstName, lastName: s.lastName, matricNumber: s.matricNumber, email: s.email ?? undefined, phone: s.phone ?? undefined, level: s.level, academicSession: s.academicSession, status: s.status, onboardingCompleted: s.onboardingCompleted, profilePhoto: s.profilePhoto ?? undefined, createdAt: stamps(s).createdAt });
const toLecturer = (l: LecturerDocument): LecturerRow => ({ id: id(l._id), firstName: l.firstName, lastName: l.lastName, email: l.email, phone: l.phone ?? undefined, staffId: l.staffId, status: l.status, profilePhoto: l.profilePhoto ?? undefined, createdAt: stamps(l).createdAt });
const toCourse = (c: CourseDocument): CourseRec => ({ id: id(c._id), departmentId: id(c.department), courseCode: c.courseCode, title: c.title, description: c.description ?? undefined, units: c.units, level: c.level, semester: c.semester, academicSession: c.academicSession, status: c.status });
const toRep = (a: CourseRepresentativeAssignmentDocument, student?: { firstName: string; lastName: string; matricNumber: string }, courseTitle?: string): RepAssignmentView => ({
  id: id(a._id), studentId: id(a.student), departmentId: id(a.department), scope: a.scope ?? (a.course ? "COURSE" : "LEVEL"), courseId: a.course ? id(a.course) : undefined, courseCode: a.courseCode ?? undefined, level: a.level, academicSession: a.academicSession, semester: a.semester,
  role: a.role, status: a.status, assignedBy: { name: a.assignedBy.name, role: a.assignedBy.role }, assignedAt: a.assignedAt, revokedAt: a.revokedAt ?? undefined,
  // A plain object, NOT the Mongoose document: HodService.repDTO spreads this, and spreading a document drops firstName/lastName (they are prototype getters).
  student: student ? { firstName: student.firstName, lastName: student.lastName, matricNumber: student.matricNumber } : { firstName: "", lastName: "", matricNumber: "" }, courseTitle,
});
const toTimetable = (e: TimetableEntryDocument): TimetableRec => ({
  id: id(e._id), departmentId: id(e.department), courseId: e.course ? id(e.course) : undefined, courseCode: e.courseCode ?? undefined, level: e.level, academicSession: e.academicSession, semester: e.semester,
  title: e.title, type: e.type, dayOfWeek: e.dayOfWeek, date: e.date ?? undefined, startTime: e.startTime, endTime: e.endTime, venue: e.venue ?? undefined, lecturerName: e.lecturerName ?? undefined,
  source: e.source ?? "OFFICIAL", status: e.status ?? "PUBLISHED", createdByStudentId: e.createdByStudent ? id(e.createdByStudent) : undefined, createdByRole: e.createdByRole ?? undefined,
});
const toAnnouncement = (a: AnnouncementDocument): HodAnnouncementRec => ({
  id: id(a._id), departmentId: id(a.department), title: a.title, body: a.body, priority: a.priority, status: a.status, scope: a.audience.scope, levels: a.audience.levels ?? undefined,
  courseCode: a.audience.courseCodes?.[0], hodId: a.createdByHod ? id(a.createdByHod) : undefined, lecturerId: a.createdByLecturer ? id(a.createdByLecturer) : undefined, studentId: a.createdByStudent ? id(a.createdByStudent) : undefined,
  authorName: a.createdByName, authorRole: a.createdByRole, image: a.image?.url ? { url: a.image.url, publicId: a.image.publicId ?? undefined } : undefined,
  publishedAt: a.status === "PUBLISHED" ? a.publishedAt : undefined, expiresAt: a.expiresAt ?? null, createdAt: stamps(a).createdAt, updatedAt: stamps(a).updatedAt,
});
const toDocument = (d: DepartmentDocumentDocument): DocumentRec => ({
  id: id(d._id), departmentId: id(d.department), title: d.title, description: d.description ?? undefined, levels: d.levels ?? [],
  file: { url: d.file.url, publicId: d.file.publicId ?? undefined, originalName: d.file.originalName, mimeType: d.file.mimeType, sizeBytes: d.file.sizeBytes },
  status: d.status, hodId: id(d.createdByHod), authorName: d.createdByName, createdAt: stamps(d).createdAt, updatedAt: stamps(d).updatedAt,
});
const toNotification = (n: NotificationDocument): NotificationView => ({ id: id(n._id), kind: n.kind, title: n.title, body: n.body, link: n.link ?? undefined, read: Boolean(n.readAt), createdAt: stamps(n).createdAt });

/** MongoDB implementation of the HOD store. EVERY query includes the department, so another department's ids behave like missing ones. */
export class MongoHodStore implements HodStore {
  /* ---- identity / department / term ---- */
  async getHod(hodId: string) { const h = await Hod.findById(hodId).select("+profilePhotoPublicId"); return h ? toHod(h) : null; }
  async updateHodProfile(hodId: string, patch: { phone?: string | null; profilePhoto?: string | null; profilePhotoPublicId?: string | null }) {
    const $set: Record<string, unknown> = {}; const $unset: Record<string, ""> = {};
    for (const k of ["phone", "profilePhoto", "profilePhotoPublicId"] as const) { if (patch[k] === undefined) continue; if (patch[k] === null) $unset[k] = ""; else $set[k] = patch[k]; }
    const h = await Hod.findByIdAndUpdate(hodId, { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) }, { new: true, runValidators: true }).select("+profilePhotoPublicId");
    return h ? toHod(h) : null;
  }
  private toDept(d: InstanceType<typeof Department>): DeptRec { return { id: id(d._id), name: d.name, code: d.code, faculty: d.faculty, isActive: d.isActive, levels: d.levels, contact: d.contact ? { email: d.contact.email ?? undefined, phone: d.contact.phone ?? undefined, office: d.contact.office ?? undefined } : undefined }; }
  async getDepartment(departmentId: string) { const d = await Department.findById(departmentId); return d ? this.toDept(d) : null; }
  async updateDepartment(departmentId: string, patch: { name?: string; faculty?: string; contact?: { email?: string; phone?: string; office?: string }; levels?: string[] }) {
    const $set: Record<string, unknown> = {};
    if (patch.name) $set.name = patch.name;
    if (patch.faculty) $set.faculty = patch.faculty;
    if (patch.levels) $set.levels = patch.levels;
    for (const [k, v] of Object.entries(patch.contact ?? {})) if (v !== undefined) $set[`contact.${k}`] = v;
    try {
      // `code`, `matricCode`, `isActive` are never part of $set: they can't be changed through this method.
      const d = await Department.findByIdAndUpdate(departmentId, { $set }, { new: true, runValidators: true });
      return d ? this.toDept(d) : null;
    } catch (e) { if (isDup(e)) throw new StoreDuplicateError("department name"); throw e; }
  }
  async levelUsage(departmentId: string) {
    const dept = await Department.findById(departmentId);
    const [st, co] = await Promise.all([
      Student.aggregate<{ _id: string; n: number }>([{ $match: { department: dept?._id } }, { $group: { _id: "$level", n: { $sum: 1 } } }]),
      Course.aggregate<{ _id: string; n: number }>([{ $match: { department: dept?._id } }, { $group: { _id: "$level", n: { $sum: 1 } } }]),
    ]);
    return (dept?.levels ?? []).map((level) => ({ level, students: st.find((x) => x._id === level)?.n ?? 0, courses: co.find((x) => x._id === level)?.n ?? 0 }));
  }
  private toTerm(t: InstanceType<typeof AcademicTerm>): TermRec { return { academicSession: t.academicSession, semester: t.semester, registrationOpen: t.registrationOpen, registrationOpensAt: t.registrationOpensAt ?? undefined, registrationClosesAt: t.registrationClosesAt ?? undefined, maxUnits: t.maxUnits }; }
  async getCurrentTerm(departmentId: string) { const t = await AcademicTerm.findOne({ department: departmentId, isCurrent: true }); return t ? this.toTerm(t) : null; }
  async setCurrentTerm(departmentId: string, term: { academicSession: string; semester: "FIRST" | "SECOND" }) {
    // Un-mark the old one FIRST so the partial unique index (one current term per department) is never violated.
    await AcademicTerm.updateMany({ department: departmentId, isCurrent: true }, { $set: { isCurrent: false } });
    const t = await AcademicTerm.findOneAndUpdate({ department: departmentId, academicSession: term.academicSession, semester: term.semester }, { $set: { isCurrent: true } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    return this.toTerm(t);
  }
  async updateRegistration(departmentId: string, patch: { registrationOpen?: boolean; registrationOpensAt?: Date | null; registrationClosesAt?: Date | null; maxUnits?: number }) {
    const $set: Record<string, unknown> = {}; const $unset: Record<string, ""> = {};
    if (patch.registrationOpen !== undefined) $set.registrationOpen = patch.registrationOpen;
    if (patch.maxUnits !== undefined) $set.maxUnits = patch.maxUnits;
    for (const k of ["registrationOpensAt", "registrationClosesAt"] as const) { if (patch[k] === undefined) continue; if (patch[k] === null) $unset[k] = ""; else $set[k] = patch[k]; }
    const t = await AcademicTerm.findOneAndUpdate({ department: departmentId, isCurrent: true }, { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) }, { new: true, runValidators: true });
    return t ? this.toTerm(t) : null;
  }

  /* ---- students ---- */
  async listStudents(departmentId: string, q: Parameters<HodStore["listStudents"]>[1]): Promise<Page<StudentRow>> {
    const f: FilterQuery<unknown> = { department: departmentId };
    if (q.level) f.level = q.level; if (q.academicSession) f.academicSession = q.academicSession; if (q.status) f.status = q.status;
    if (q.search) { const rx = new RegExp(esc(q.search), "i"); f.$or = [{ firstName: rx }, { lastName: rx }, { matricNumber: rx }, { email: rx }]; }
    const [total, rows] = await Promise.all([Student.countDocuments(f), Student.find(f).sort(sortOf(q, ["lastName", "firstName", "matricNumber", "level", "createdAt", "status"], { lastName: 1, firstName: 1 })).skip(skipLimit(q).skip).limit(skipLimit(q).limit)]);
    return { items: rows.map(toStudent), total };
  }
  async getStudent(departmentId: string, studentId: string) { const s = await Student.findOne({ _id: studentId, department: departmentId }); return s ? toStudent(s) : null; }
  async setStudentStatus(departmentId: string, studentId: string, status: "ACTIVE" | "SUSPENDED") {
    const s = await Student.findOneAndUpdate({ _id: studentId, department: departmentId, onboardingCompleted: true }, { $set: { status } }, { new: true });
    return s ? toStudent(s) : null;
  }
  async updateStudentAcademic(departmentId: string, studentIds: string[], patch: { level?: string; academicSession?: string }) {
    // matric number, department, role and names are not even representable in `patch`.
    const r = await Student.updateMany({ _id: { $in: studentIds }, department: departmentId }, { $set: { ...(patch.level ? { level: patch.level } : {}), ...(patch.academicSession ? { academicSession: patch.academicSession } : {}) } });
    return r.modifiedCount;
  }
  countStudentsInDepartment(departmentId: string, studentIds: string[]) { return Student.countDocuments({ _id: { $in: studentIds }, department: departmentId }); }
  async studentEnrollments(departmentId: string, studentId: string): Promise<EnrollmentView[]> {
    const rows = await CourseEnrollment.find({ student: studentId, department: departmentId }).sort({ academicSession: -1, semester: 1 });
    const courses = await Course.find({ _id: { $in: rows.map((r) => r.course) }, department: departmentId });
    const byId = new Map(courses.map((c) => [id(c._id), c]));
    return rows.map((e) => { const c = byId.get(id(e.course)); return { id: id(e._id), courseId: c ? id(c._id) : undefined, courseCode: e.courseCode, title: c?.title ?? e.courseCode, units: c?.units ?? 0, level: c?.level ?? "", semester: e.semester, academicSession: e.academicSession, enrollmentType: e.enrollmentType, status: e.status }; });
  }
  async studentAttendance(departmentId: string, studentId: string, term: TermLike) {
    const enr = await CourseEnrollment.find({ student: studentId, department: departmentId, academicSession: term.academicSession, semester: term.semester, status: "ENROLLED" }).select("courseCode");
    const codes = enr.map((e) => e.courseCode);
    const sessions = await AttendanceSession.find({ department: departmentId, academicSession: term.academicSession, semester: term.semester, courseCode: { $in: codes }, opensAt: { $lte: new Date() }, status: { $ne: "CANCELLED" } }).select("_id courseCode");
    const recs = await AttendanceRecord.find({ student: studentId, session: { $in: sessions.map((s) => s._id) } });
    return codes.map((courseCode) => {
      const held = sessions.filter((s) => s.courseCode === courseCode);
      const mine = recs.filter((r) => held.some((s) => id(s._id) === id(r.session)));
      return { courseCode, sessionsHeld: held.length, attended: mine.length, late: mine.filter((r) => r.status === "LATE").length };
    });
  }

  /* ---- lecturers ---- */
  async listLecturers(departmentId: string, q: Parameters<HodStore["listLecturers"]>[1]): Promise<Page<LecturerRow>> {
    const f: FilterQuery<unknown> = { department: departmentId };
    if (q.status) f.status = q.status;
    if (q.search) { const rx = new RegExp(esc(q.search), "i"); f.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { staffId: rx }]; }
    const [total, rows] = await Promise.all([Lecturer.countDocuments(f), Lecturer.find(f).sort(sortOf(q, ["lastName", "firstName", "staffId", "status", "createdAt"], { lastName: 1, firstName: 1 })).skip(skipLimit(q).skip).limit(skipLimit(q).limit)]);
    return { items: rows.map(toLecturer), total };
  }
  async getLecturer(departmentId: string, lecturerId: string) { const l = await Lecturer.findOne({ _id: lecturerId, department: departmentId }); return l ? toLecturer(l) : null; }
  async createLecturer(rec: Parameters<HodStore["createLecturer"]>[0]) {
    try {
      const l = await Lecturer.create({ firstName: rec.firstName, lastName: rec.lastName, email: rec.email, phone: rec.phone, staffId: rec.staffId, department: rec.departmentId, status: "INVITED", activationTokenHash: rec.activationTokenHash, activationExpires: rec.activationExpires });
      return toLecturer(l);
    } catch (e) { if (isDup(e)) throw new StoreDuplicateError("lecturer"); throw e; }
  }
  async updateLecturer(departmentId: string, lecturerId: string, patch: { firstName?: string; lastName?: string; phone?: string | null }) {
    const $set: Record<string, unknown> = {}; const $unset: Record<string, ""> = {};
    if (patch.firstName) $set.firstName = patch.firstName; if (patch.lastName) $set.lastName = patch.lastName;
    if (patch.phone === null) $unset.phone = ""; else if (patch.phone !== undefined) $set.phone = patch.phone;
    const l = await Lecturer.findOneAndUpdate({ _id: lecturerId, department: departmentId }, { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) }, { new: true, runValidators: true });
    return l ? toLecturer(l) : null;
  }
  async setLecturerStatus(departmentId: string, lecturerId: string, status: "ACTIVE" | "SUSPENDED") {
    const l = await Lecturer.findOneAndUpdate({ _id: lecturerId, department: departmentId, status: { $ne: "INVITED" } }, { $set: { status } }, { new: true });
    return l ? toLecturer(l) : null;
  }
  async reissueLecturerInvitation(departmentId: string, lecturerId: string, tokenHash: string, expires: Date) {
    const r = await Lecturer.updateOne({ _id: lecturerId, department: departmentId, status: "INVITED" }, { $set: { activationTokenHash: tokenHash, activationExpires: expires } });
    return r.modifiedCount === 1;
  }
  async lecturerAssignments(departmentId: string, lecturerId: string): Promise<LecturerAssignmentView[]> {
    const rows = await LecturerCourseAssignment.find({ lecturer: lecturerId, department: departmentId }).sort({ assignedAt: -1 });
    const courses = await Course.find({ _id: { $in: rows.map((r) => r.course) } }).select("title");
    const t = new Map(courses.map((c) => [id(c._id), c.title]));
    return rows.map((a) => ({ id: id(a._id), lecturerId: id(a.lecturer), departmentId: id(a.department), courseId: id(a.course), courseCode: a.courseCode, level: a.level, academicSession: a.academicSession, semester: a.semester, status: a.status, assignedBy: { name: a.assignedBy.name, role: a.assignedBy.role }, assignedAt: a.assignedAt, courseTitle: t.get(id(a.course)) }));
  }
  async createLecturerAssignment(rec: Omit<LecturerAssignmentRec, "id">): Promise<LecturerAssignmentRec> {
    try {
      const a = await LecturerCourseAssignment.create({ lecturer: rec.lecturerId, department: rec.departmentId, course: rec.courseId, courseCode: rec.courseCode, level: rec.level, academicSession: rec.academicSession, semester: rec.semester, status: rec.status, assignedBy: rec.assignedBy, assignedAt: rec.assignedAt });
      return { ...rec, id: id(a._id) };
    } catch (e) { if (isDup(e)) throw new StoreDuplicateError("lecturer assignment"); throw e; }
  }
  async hasActiveLecturerAssignment(departmentId: string, lecturerId: string, courseId: string) { return Boolean(await LecturerCourseAssignment.exists({ lecturer: lecturerId, department: departmentId, course: courseId, status: "ACTIVE" })); }
  async revokeLecturerAssignment(departmentId: string, lecturerId: string, courseId: string, by: { name: string; role: string }) {
    const a = await LecturerCourseAssignment.findOneAndUpdate({ lecturer: lecturerId, department: departmentId, course: courseId, status: "ACTIVE" }, { $set: { status: "REVOKED", revokedAt: new Date(), revokedBy: by } }, { new: true });
    return a ? { id: id(a._id), lecturerId: id(a.lecturer), departmentId: id(a.department), courseId: id(a.course), courseCode: a.courseCode, level: a.level, academicSession: a.academicSession, semester: a.semester, status: a.status, assignedBy: { name: a.assignedBy.name, role: a.assignedBy.role }, assignedAt: a.assignedAt } : null;
  }

  /* ---- courses ---- */
  countEnrollments(c: CourseRec) { return CourseEnrollment.countDocuments({ department: c.departmentId, courseCode: c.courseCode, academicSession: c.academicSession, semester: c.semester, status: "ENROLLED" }); }
  async listCourses(departmentId: string, q: Parameters<HodStore["listCourses"]>[1]): Promise<Page<CourseView>> {
    const f: FilterQuery<unknown> = { department: departmentId };
    if (q.level) f.level = q.level; if (q.semester) f.semester = q.semester; if (q.academicSession) f.academicSession = q.academicSession; if (q.status) f.status = q.status;
    if (q.search) { const rx = new RegExp(esc(q.search), "i"); f.$or = [{ courseCode: rx }, { title: rx }]; }
    const [total, rows] = await Promise.all([Course.countDocuments(f), Course.find(f).sort(sortOf(q, ["courseCode", "title", "level", "units", "createdAt", "status"], { level: 1, courseCode: 1 })).skip(skipLimit(q).skip).limit(skipLimit(q).limit)]);
    const [names, items] = await Promise.all([
      lecturersByCourse(departmentId, rows.map((c) => c._id)),
      Promise.all(rows.map(async (c) => { const rec = toCourse(c); return { ...rec, enrolledCount: await this.countEnrollments(rec) }; })),
    ]);
    return { items: items.map((c) => ({ ...c, lecturers: names.get(c.id) ?? [] })), total };
  }
  async getCourse(departmentId: string, courseId: string) { const c = await Course.findOne({ _id: courseId, department: departmentId }); return c ? toCourse(c) : null; }
  async createCourse(rec: Omit<CourseRec, "id">) {
    try {
      const c = await Course.create({ department: rec.departmentId, courseCode: rec.courseCode, title: rec.title, description: rec.description, units: rec.units, level: rec.level, semester: rec.semester, academicSession: rec.academicSession, status: rec.status });
      return toCourse(c);
    } catch (e) { if (isDup(e)) throw new StoreDuplicateError("course"); throw e; }
  }
  async updateCourse(departmentId: string, courseId: string, patch: Partial<Pick<CourseRec, "title" | "description" | "units" | "level" | "semester" | "status">>) {
    try {
      const c = await Course.findOneAndUpdate({ _id: courseId, department: departmentId }, { $set: patch }, { new: true, runValidators: true });
      return c ? toCourse(c) : null;
    } catch (e) { if (isDup(e)) throw new StoreDuplicateError("course"); throw e; }
  }
  async courseLecturers(c: CourseRec) {
    const rows = await LecturerCourseAssignment.find({ course: c.id, department: c.departmentId, status: "ACTIVE" });
    const ls = await Lecturer.find({ _id: { $in: rows.map((r) => r.lecturer) } }).select("firstName lastName");
    return rows.map((r) => { const l = ls.find((x) => id(x._id) === id(r.lecturer)); return { lecturerId: id(r.lecturer), name: l ? `${l.firstName} ${l.lastName}` : "" }; });
  }
  async courseRepresentatives(c: CourseRec) {
    // The level's appointments (they cover every course of the level this term) plus any legacy appointment on this very course.
    const rows = await CourseRepresentativeAssignment.find({
      department: c.departmentId, status: { $ne: "REVOKED" },
      $or: [{ scope: "LEVEL", level: c.level, academicSession: c.academicSession, semester: c.semester }, { course: c.id }],
    });
    const sts = await Student.find({ _id: { $in: rows.map((r) => r.student) } }).select("firstName lastName matricNumber");
    return rows.map((r) => toRep(r, sts.find((s) => id(s._id) === id(r.student)), c.title));
  }

  /* ---- representatives ---- */
  private async repViews(rows: CourseRepresentativeAssignmentDocument[]) {
    const [sts, cs] = await Promise.all([Student.find({ _id: { $in: rows.map((r) => r.student) } }).select("firstName lastName matricNumber"), Course.find({ _id: { $in: rows.map((r) => r.course) } }).select("title")]);
    return rows.map((r) => toRep(r, sts.find((s) => id(s._id) === id(r.student)), cs.find((c) => id(c._id) === id(r.course))?.title));
  }
  async listRepAssignments(departmentId: string, q: Parameters<HodStore["listRepAssignments"]>[1]): Promise<Page<RepAssignmentView>> {
    const f: FilterQuery<unknown> = { department: departmentId };
    if (q.courseId) f.course = q.courseId; if (q.level) f.level = q.level; if (q.academicSession) f.academicSession = q.academicSession; if (q.semester) f.semester = q.semester; if (q.role) f.role = q.role; if (q.status) f.status = q.status;
    if (q.search) {
      const rx = new RegExp(esc(q.search), "i");
      const sts = await Student.find({ department: departmentId, $or: [{ firstName: rx }, { lastName: rx }, { matricNumber: rx }] }).select("_id");
      f.$or = [{ student: { $in: sts.map((s) => s._id) } }, { courseCode: rx }];
    }
    const [total, rows] = await Promise.all([CourseRepresentativeAssignment.countDocuments(f), CourseRepresentativeAssignment.find(f).sort(sortOf(q, ["assignedAt", "courseCode", "role", "status", "level"], { assignedAt: -1 })).skip(skipLimit(q).skip).limit(skipLimit(q).limit)]);
    return { items: await this.repViews(rows), total };
  }
  async getRepAssignment(departmentId: string, assignmentId: string) { const a = await CourseRepresentativeAssignment.findOne({ _id: assignmentId, department: departmentId }); return a ? (await this.repViews([a]))[0] : null; }
  async activeRepsOnCourse(departmentId: string, courseId: string) { return (await CourseRepresentativeAssignment.find({ course: courseId, department: departmentId, status: "ACTIVE" })).map((a) => ({ studentId: id(a.student), role: a.role })); }
  async activeRepsOnLevel(departmentId: string, level: string, academicSession: string, semester: "FIRST" | "SECOND") {
    return (await CourseRepresentativeAssignment.find({ department: departmentId, scope: "LEVEL", level, academicSession, semester, status: "ACTIVE" })).map((a) => ({ studentId: id(a.student), role: a.role }));
  }
  async isEnrolled(departmentId: string, studentId: string, c: CourseRec) { return Boolean(await CourseEnrollment.exists({ student: studentId, department: departmentId, courseCode: c.courseCode, academicSession: c.academicSession, semester: c.semester, status: "ENROLLED" })); }
  async createRepAssignment(rec: Parameters<HodStore["createRepAssignment"]>[0]) {
    try {
      const a = await CourseRepresentativeAssignment.create({ student: rec.studentId, department: rec.departmentId, scope: rec.scope ?? "LEVEL", ...(rec.courseId ? { course: rec.courseId, courseCode: rec.courseCode } : {}), level: rec.level, academicSession: rec.academicSession, semester: rec.semester, role: rec.role, status: rec.status, assignedBy: rec.assignedBy, assignedAt: rec.assignedAt });
      return { ...rec, id: id(a._id) };
    } catch (e) { if (isDup(e)) throw new StoreDuplicateError("representative assignment"); throw e; } // the partial unique indexes are the final guard
  }
  async setRepAssignmentStatus(departmentId: string, assignmentId: string, status: "ACTIVE" | "INACTIVE") {
    const a = await CourseRepresentativeAssignment.findOneAndUpdate({ _id: assignmentId, department: departmentId, status: { $ne: "REVOKED" } }, { $set: { status } }, { new: true });
    return a ? (await this.repViews([a]))[0] : null;
  }
  async revokeRepAssignment(departmentId: string, assignmentId: string, by: { name: string; role: string }) {
    const a = await CourseRepresentativeAssignment.findOneAndUpdate({ _id: assignmentId, department: departmentId, status: { $ne: "REVOKED" } }, { $set: { status: "REVOKED", revokedAt: new Date(), revokedBy: by } }, { new: true });
    return a ? (await this.repViews([a]))[0] : null;
  }

  /* ---- timetable (read-only) ---- */
  async listTimetable(departmentId: string, term: TermLike, q: Parameters<HodStore["listTimetable"]>[2]): Promise<Page<TimetableRec>> {
    const f: FilterQuery<unknown> = { department: departmentId, academicSession: term.academicSession, semester: term.semester };
    if (q.courseId) { const c = await Course.findOne({ _id: q.courseId, department: departmentId }).select("courseCode"); f.courseCode = c?.courseCode ?? "__none__"; }
    if (q.level) f.level = q.level; if (q.day) f.dayOfWeek = q.day;
    if (q.source === "CLASS_REP") f.source = "CLASS_REP"; else if (q.source === "OFFICIAL") f.source = { $ne: "CLASS_REP" };
    if (q.search) { const rx = new RegExp(esc(q.search), "i"); f.$or = [{ courseCode: rx }, { title: rx }]; }
    const [total, rows] = await Promise.all([TimetableEntry.countDocuments(f), TimetableEntry.find(f).sort({ dayOfWeek: 1, startTime: 1 }).skip(skipLimit(q).skip).limit(skipLimit(q).limit)]);
    return { items: rows.map(toTimetable), total };
  }
  async allTimetable(departmentId: string, term: TermLike) { return (await TimetableEntry.find({ department: departmentId, academicSession: term.academicSession, semester: term.semester }).limit(5000)).map(toTimetable); }

  /* ---- announcements ---- */
  async listAnnouncements(departmentId: string, hodId: string, q: Parameters<HodStore["listAnnouncements"]>[2]): Promise<Page<HodAnnouncementRec>> {
    const and: FilterQuery<unknown>[] = [{ department: departmentId }, { status: { $ne: "DELETED" } }, { $or: [{ status: "PUBLISHED" }, { createdByHod: hodId }] }];
    if (q.status) and.push({ status: q.status }); if (q.scope) and.push({ "audience.scope": q.scope }); if (q.mine) and.push({ createdByHod: hodId });
    if (q.search) and.push({ title: new RegExp(esc(q.search), "i") });
    const f = { $and: and };
    const [total, rows] = await Promise.all([Announcement.countDocuments(f), Announcement.find(f).select("+image.publicId").sort(sortOf(q, ["createdAt", "publishedAt", "title", "priority"], { createdAt: -1 })).skip(skipLimit(q).skip).limit(skipLimit(q).limit)]);
    return { items: rows.map(toAnnouncement), total };
  }
  async getAnnouncement(departmentId: string, announcementId: string) { const a = await Announcement.findOne({ _id: announcementId, department: departmentId }).select("+image.publicId"); return a ? toAnnouncement(a) : null; }
  async createAnnouncement(rec: Omit<HodAnnouncementRec, "id" | "createdAt" | "updatedAt">) {
    const a = await Announcement.create({
      department: rec.departmentId, title: rec.title, body: rec.body, priority: rec.priority, status: rec.status,
      audience: { scope: rec.scope, levels: rec.levels?.length ? rec.levels : undefined }, // the audience is the HOD's own department (optionally levels), never request data
      createdByName: rec.authorName, createdByRole: "HOD", createdByHod: rec.hodId, ...(rec.image ? { image: { url: rec.image.url, publicId: rec.image.publicId } } : {}), publishedAt: rec.publishedAt ?? new Date(), expiresAt: rec.expiresAt ?? undefined,
    });
    return toAnnouncement(a);
  }
  async updateAnnouncement(announcementId: string, patch: Partial<Pick<HodAnnouncementRec, "title" | "body" | "priority" | "status" | "expiresAt" | "publishedAt" | "levels" | "scope">> & { image?: { url: string; publicId?: string } | null }) {
    const { expiresAt, levels, scope, image, ...rest } = patch;
    const $set: Record<string, unknown> = { ...rest, ...(expiresAt ? { expiresAt } : {}), ...(scope ? { "audience.scope": scope } : {}) };
    const update: Record<string, unknown> = {};
    const $unset: Record<string, ""> = {};
    if (expiresAt === null) $unset.expiresAt = "";
    if (image === null) $unset.image = ""; else if (image) $set.image = { url: image.url, publicId: image.publicId };
    if (levels) { if (levels.length) $set["audience.levels"] = levels; else $unset["audience.levels"] = ""; }
    if (Object.keys($set).length) update.$set = $set; if (Object.keys($unset).length) update.$unset = $unset;
    // Defence in depth: only HOD-written announcements can be modified here (never a lecturer's or a rep's).
    const a = await Announcement.findOneAndUpdate({ _id: announcementId, createdByHod: { $exists: true } }, update, { new: true, runValidators: true }).select("+image.publicId");
    return a ? toAnnouncement(a) : null;
  }

  /* ---- documents + materials overview ---- */
  async listDocuments(departmentId: string, q: ListQuery & { status?: string }): Promise<Page<DocumentRec>> {
    const f: FilterQuery<unknown> = { department: departmentId };
    if (q.status) f.status = q.status; if (q.search) f.title = new RegExp(esc(q.search), "i");
    const [total, rows] = await Promise.all([DepartmentDocumentModel.countDocuments(f), DepartmentDocumentModel.find(f).sort(sortOf(q, ["createdAt", "title"], { createdAt: -1 })).skip(skipLimit(q).skip).limit(skipLimit(q).limit)]);
    return { items: rows.map(toDocument), total };
  }
  async getDocument(departmentId: string, documentId: string) { const d = await DepartmentDocumentModel.findOne({ _id: documentId, department: departmentId }); return d ? toDocument(d) : null; }
  async createDocument(rec: Omit<DocumentRec, "id" | "createdAt" | "updatedAt">) {
    const d = await DepartmentDocumentModel.create({ department: rec.departmentId, title: rec.title, description: rec.description, levels: rec.levels, file: rec.file, status: rec.status, createdByHod: rec.hodId, createdByName: rec.authorName });
    return toDocument(d);
  }
  async updateDocument(departmentId: string, documentId: string, patch: Partial<Pick<DocumentRec, "title" | "description" | "levels" | "status">>) {
    const d = await DepartmentDocumentModel.findOneAndUpdate({ _id: documentId, department: departmentId }, { $set: patch }, { new: true, runValidators: true });
    return d ? toDocument(d) : null;
  }
  async deleteDocument(departmentId: string, documentId: string) { await DepartmentDocumentModel.deleteOne({ _id: documentId, department: departmentId }); }
  async listMaterialsOverview(departmentId: string, q: ListQuery & { type?: string; courseCode?: string }): Promise<Page<MaterialOverview>> {
    const f: FilterQuery<unknown> = { department: departmentId };
    if (q.type) f.type = q.type; if (q.courseCode) f.courseCode = q.courseCode; if (q.search) f.title = new RegExp(esc(q.search), "i");
    const [total, rows] = await Promise.all([Material.countDocuments(f), Material.find(f).sort({ createdAt: -1 }).skip(skipLimit(q).skip).limit(skipLimit(q).limit)]);
    return { items: rows.map((m) => ({ id: id(m._id), courseCode: m.courseCode ?? undefined, title: m.title, type: m.type, ownerName: m.uploadedByName, ownerRole: m.uploadedByRole, status: m.status, createdAt: stamps(m).createdAt })), total };
  }

  /* ---- attendance (read-only) ---- */
  private async toSessions(rows: AttendanceSessionDocument[]): Promise<SessionView[]> {
    const ls = await Lecturer.find({ _id: { $in: rows.map((r) => r.lecturer).filter(Boolean) } }).select("firstName lastName");
    return rows.map((s) => {
      const loc = s.location; const radius = loc?.allowedRadiusInMeters ?? loc?.radiusMeters; const l = s.lecturer ? ls.find((x) => id(x._id) === id(s.lecturer)) : undefined;
      return {
        id: id(s._id), departmentId: id(s.department), courseId: s.course ? id(s.course) : "", lecturerId: s.lecturer ? id(s.lecturer) : "", courseCode: s.courseCode, level: s.level, academicSession: s.academicSession,
        semester: s.semester, title: s.title, opensAt: s.opensAt, closesAt: s.closesAt, lateAfterMinutes: s.lateAfterMinutes, status: s.status, createdAt: stamps(s).createdAt,
        location: loc?.latitude != null && loc?.longitude != null && radius != null ? { latitude: loc.latitude, longitude: loc.longitude, allowedRadiusInMeters: radius } : undefined,
        lecturerName: l ? `${l.firstName} ${l.lastName}` : s.createdByName,
      };
    });
  }
  async listSessions(departmentId: string, term: TermLike | null, q: Parameters<HodStore["listSessions"]>[2], now: Date): Promise<Page<SessionView>> {
    const and: FilterQuery<unknown>[] = [{ department: departmentId }];
    if (term) and.push({ academicSession: term.academicSession, semester: term.semester });
    if (q.courseId) { const c = await Course.findOne({ _id: q.courseId, department: departmentId }).select("courseCode"); and.push({ courseCode: c?.courseCode ?? "__none__" }); }
    if (q.lecturerId) and.push({ lecturer: q.lecturerId });
    if (q.from) and.push({ opensAt: { $gte: q.from } }); if (q.to) and.push({ opensAt: { $lte: q.to } });
    if (q.state === "OPEN") and.push({ status: "ACTIVE", opensAt: { $lte: now }, closesAt: { $gte: now } });
    if (q.state === "UPCOMING") and.push({ status: "ACTIVE", opensAt: { $gt: now } });
    if (q.state === "CLOSED") and.push({ $or: [{ status: { $in: ["CLOSED", "CANCELLED"] } }, { closesAt: { $lt: now } }] });
    if (q.search) and.push({ $or: [{ courseCode: new RegExp(esc(q.search), "i") }, { title: new RegExp(esc(q.search), "i") }] });
    const f = { $and: and };
    const [total, rows] = await Promise.all([AttendanceSession.countDocuments(f), AttendanceSession.find(f).sort({ opensAt: -1 }).skip(skipLimit(q).skip).limit(skipLimit(q).limit)]);
    return { items: await this.toSessions(rows), total };
  }
  async getSession(departmentId: string, sessionId: string) { const s = await AttendanceSession.findOne({ _id: sessionId, department: departmentId }); return s ? (await this.toSessions([s]))[0] : null; }
  async sessionRecordCounts(sessionIds: string[]) {
    const rows = await AttendanceRecord.aggregate<{ _id: { s: unknown; st: string }; n: number }>([{ $match: { session: { $in: sessionIds.map((s) => new Types.ObjectId(s)) } } }, { $group: { _id: { s: "$session", st: "$status" }, n: { $sum: 1 } } }]);
    const m = new Map<string, { present: number; late: number }>();
    for (const r of rows) { const k = id(r._id.s); const cur = m.get(k) ?? { present: 0, late: 0 }; if (r._id.st === "LATE") cur.late += r.n; else cur.present += r.n; m.set(k, cur); }
    return m;
  }
  async recordsForSession(sessionId: string): Promise<AttendanceRecordView[]> {
    const recs = await AttendanceRecord.find({ session: sessionId });
    const sts = await Student.find({ _id: { $in: recs.map((r) => r.student) } }).select("firstName lastName matricNumber");
    return recs.map((r) => { const s = sts.find((x) => id(x._id) === id(r.student)); return { sessionId: id(r.session), studentId: id(r.student), firstName: s?.firstName ?? "", lastName: s?.lastName ?? "", matricNumber: s?.matricNumber ?? "", status: r.status, markedAt: r.markedAt, distanceMeters: r.location?.distanceMeters ?? undefined }; });
  }
  flaggedAttempts(sessionId: string) { return AttendanceSecurityLog.countDocuments({ session: sessionId, flagged: true }); }
  async enrolledCountsByCourse(departmentId: string, term: TermLike) {
    const dept = await Department.findById(departmentId).select("_id");
    const rows = await CourseEnrollment.aggregate<{ _id: string; n: number }>([{ $match: { department: dept?._id, academicSession: term.academicSession, semester: term.semester, status: "ENROLLED" } }, { $group: { _id: "$courseCode", n: { $sum: 1 } } }]);
    return new Map<string, number>(rows.map((r) => [r._id, r.n]));
  }
  async courseAttendanceStats(departmentId: string, term: TermLike, now: Date) {
    const [courses, held, enrolled] = await Promise.all([
      Course.find({ department: departmentId, academicSession: term.academicSession, semester: term.semester }),
      AttendanceSession.find({ department: departmentId, academicSession: term.academicSession, semester: term.semester, opensAt: { $lte: now }, status: { $ne: "CANCELLED" } }).select("_id courseCode"),
      this.enrolledCountsByCourse(departmentId, term),
    ]);
    const recs = await AttendanceRecord.find({ session: { $in: held.map((s) => s._id) } }).select("courseCode");
    const out: CourseAttendanceStatLike[] = [];
    for (const c of courses) {
      const h = held.filter((s) => s.courseCode === c.courseCode).length;
      if (!h) continue;
      out.push({ courseId: id(c._id), courseCode: c.courseCode, title: c.title, sessionsHeld: h, enrolled: enrolled.get(c.courseCode) ?? 0, attendanceRecords: recs.filter((r) => r.courseCode === c.courseCode).length });
    }
    return out;
  }

  /* ---- complaints ---- */
  private async toComplaints(rows: ComplaintDocument[]): Promise<ComplaintRec[]> {
    const [sts, ls] = await Promise.all([Student.find({ _id: { $in: rows.map((r) => r.student) } }).select("firstName lastName matricNumber"), Lecturer.find({ _id: { $in: rows.map((r) => r.assignedLecturer).filter(Boolean) } }).select("firstName lastName")]);
    return rows.map((c) => {
      const s = sts.find((x) => id(x._id) === id(c.student)); const l = c.assignedLecturer ? ls.find((x) => id(x._id) === id(c.assignedLecturer)) : undefined;
      return {
        id: id(c._id), referenceNumber: c.referenceNumber, departmentId: id(c.department), studentId: id(c.student), studentName: s ? `${s.firstName} ${s.lastName}` : "", matricNumber: s?.matricNumber ?? "", type: c.type, title: c.title, message: c.message,
        courseId: c.course ? id(c.course) : undefined, courseCode: c.courseCode ?? undefined, courseTitle: c.courseTitle ?? undefined, status: c.status,
        assignedLecturer: c.assignedLecturer ? { id: id(c.assignedLecturer), name: l ? `${l.firstName} ${l.lastName}` : "" } : undefined, assignedAt: c.assignedAt ?? undefined, resolution: c.resolution ?? undefined, resolvedAt: c.resolvedAt ?? undefined,
        attachments: c.attachments.map((a) => ({ id: id(a._id), name: a.originalName, mimeType: a.mimeType, sizeBytes: a.sizeBytes, publicId: a.publicId, resourceType: a.resourceType })),
        timeline: c.timeline.map((e) => ({ id: id(e._id), status: e.status, label: e.label, note: e.note ?? undefined, at: e.at, byRole: e.byRole ?? undefined, byId: e.byId ? id(e.byId) : undefined, byName: e.byName ?? undefined, internal: e.internal ? true : undefined })), createdAt: stamps(c).createdAt, updatedAt: stamps(c).updatedAt,
      };
    });
  }
  async listComplaints(departmentId: string, q: Parameters<HodStore["listComplaints"]>[1]): Promise<Page<ComplaintRec>> {
    const and: FilterQuery<unknown>[] = [{ department: departmentId }];
    if (q.status) and.push({ status: q.status }); if (q.type) and.push({ type: q.type }); if (q.courseId) and.push({ course: q.courseId }); if (q.assignedLecturerId) and.push({ assignedLecturer: q.assignedLecturerId });
    if (q.from) and.push({ createdAt: { $gte: q.from } }); if (q.to) and.push({ createdAt: { $lte: q.to } });
    if (q.search) {
      const rx = new RegExp(esc(q.search), "i");
      const sts = await Student.find({ department: departmentId, $or: [{ firstName: rx }, { lastName: rx }, { matricNumber: rx }] }).select("_id");
      and.push({ $or: [{ referenceNumber: rx }, { title: rx }, { courseCode: rx }, { student: { $in: sts.map((s) => s._id) } }] });
    }
    const f = { $and: and };
    const [total, rows] = await Promise.all([Complaint.countDocuments(f), Complaint.find(f).sort(sortOf(q, ["createdAt", "updatedAt", "status", "referenceNumber"], { createdAt: -1 })).skip(skipLimit(q).skip).limit(skipLimit(q).limit)]);
    return { items: await this.toComplaints(rows), total };
  }
  async getComplaint(departmentId: string, complaintId: string) { const c = await Complaint.findOne({ _id: complaintId, department: departmentId }); return c ? (await this.toComplaints([c]))[0] : null; }
  async updateComplaint(departmentId: string, complaintId: string, patch: ComplaintPatch, event: ComplaintEvent) {
    const $set: Record<string, unknown> = {};
    if (patch.status) $set.status = patch.status; if (patch.assignedLecturerId) { $set.assignedLecturer = patch.assignedLecturerId; $set.assignedAt = patch.assignedAt; }
    if (patch.resolution !== undefined) { $set.resolution = patch.resolution; $set.resolvedAt = patch.resolvedAt; } if (patch.reviewedByHodId) $set.reviewedBy = patch.reviewedByHodId;
    const c = await Complaint.findOneAndUpdate({ _id: complaintId, department: departmentId }, { $set, $push: { timeline: { status: event.status, label: event.label, note: event.note, at: event.at, byRole: event.byRole, byId: event.byId, byName: event.byName, internal: event.internal } } }, { new: true, runValidators: true });
    return c ? (await this.toComplaints([c]))[0] : null;
  }
  async addComplaintEvent(departmentId: string, complaintId: string, event: ComplaintEvent) {
    const c = await Complaint.findOneAndUpdate({ _id: complaintId, department: departmentId }, { $push: { timeline: { status: event.status, label: event.label, note: event.note, at: event.at, byRole: event.byRole, byId: event.byId, byName: event.byName, internal: event.internal } } }, { new: true });
    return c ? (await this.toComplaints([c]))[0] : null;
  }

  /* ---- notifications ---- */
  async listNotifications(hodId: string, q: { page: number; limit: number; unread?: boolean }) {
    const base = { recipient: hodId, recipientType: "HOD" as const };
    const f = { ...base, ...(q.unread ? { readAt: { $exists: false } } : {}) };
    const [rows, total, unread] = await Promise.all([Notification.find(f).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit), Notification.countDocuments(f), Notification.countDocuments({ ...base, readAt: { $exists: false } })]);
    return { items: rows.map(toNotification), total, unread };
  }
  async markNotificationRead(hodId: string, notificationId: string) { const n = await Notification.findOneAndUpdate({ _id: notificationId, recipient: hodId, recipientType: "HOD" }, { $set: { readAt: new Date() } }, { new: true }); return n ? toNotification(n) : null; }
  async markAllNotificationsRead(hodId: string) { return (await Notification.updateMany({ recipient: hodId, recipientType: "HOD", readAt: { $exists: false } }, { $set: { readAt: new Date() } })).modifiedCount; }

  /* ---- dashboard / audit ---- */
  async dashboardCounts(departmentId: string, term: TermLike | null, now: Date): Promise<DashboardCounts> {
    const d = { department: departmentId };
    const cur = term ? { academicSession: term.academicSession, semester: term.semester } : null;
    const [total, active, pending, suspended, lecTotal, lecActive, crs, acrs, courses, anns, open, cPending, cReview] = await Promise.all([
      Student.countDocuments(d), Student.countDocuments({ ...d, status: "ACTIVE" }), Student.countDocuments({ ...d, status: "PENDING_ONBOARDING" }), Student.countDocuments({ ...d, status: "SUSPENDED" }),
      Lecturer.countDocuments(d), Lecturer.countDocuments({ ...d, status: "ACTIVE" }),
      cur ? CourseRepresentativeAssignment.countDocuments({ ...d, ...cur, status: "ACTIVE", role: "COURSE_REP" }) : 0,
      cur ? CourseRepresentativeAssignment.countDocuments({ ...d, ...cur, status: "ACTIVE", role: "ASSISTANT_COURSE_REP" }) : 0,
      cur ? Course.countDocuments({ ...d, ...cur, status: "ACTIVE" }) : 0,
      Announcement.countDocuments({ ...d, status: "PUBLISHED", $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }] }),
      AttendanceSession.countDocuments({ ...d, status: "ACTIVE", opensAt: { $lte: now }, closesAt: { $gte: now } }),
      Complaint.countDocuments({ ...d, status: { $in: ["SUBMITTED", "PENDING"] } }), Complaint.countDocuments({ ...d, status: "UNDER_REVIEW" }),
    ]);
    return { students: { total, active, pendingOnboarding: pending, suspended }, lecturers: { total: lecTotal, active: lecActive }, representatives: { courseReps: crs, assistantCourseReps: acrs }, activeCourses: courses, activeAnnouncements: anns, openAttendanceSessions: open, complaints: { pending: cPending, underReview: cReview } };
  }
  async recentActivity(departmentId: string, limit: number): Promise<ActivityItem[]> {
    const [h, l, r] = await Promise.all([
      HodAuditLog.find({ department: departmentId, action: { $nin: ["ACCESS_DENIED", "SCOPE_VIOLATION"] } }).sort({ at: -1 }).limit(limit),
      LecturerAuditLog.find({ department: departmentId, action: { $ne: "ACCESS_DENIED" } }).sort({ at: -1 }).limit(limit),
      RepresentativeAuditLog.find({ department: departmentId, action: { $ne: "ACCESS_DENIED" } }).sort({ at: -1 }).limit(limit),
    ]);
    const items: ActivityItem[] = [
      ...h.map((x): ActivityItem => ({ source: "HOD", action: x.action, actorName: x.actorName ?? undefined, role: x.role, resourceType: x.resourceType ?? undefined, at: x.at })),
      ...l.map((x): ActivityItem => ({ source: "LECTURER", action: x.action, actorName: x.actorName ?? undefined, role: x.role, resourceType: x.resourceType ?? undefined, courseCode: x.courseCode ?? undefined, at: x.at })),
      ...r.map((x): ActivityItem => ({ source: "REPRESENTATIVE", action: x.action, actorName: x.actorName ?? undefined, role: x.role ?? undefined, resourceType: x.resourceType ?? undefined, courseCode: x.courseCode ?? undefined, at: x.at })),
    ];
    return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
  }
  async addAudit(rec: HodAuditRec) {
    await HodAuditLog.create({ actor: rec.actorId, actorName: rec.actorName, role: rec.role, action: rec.action, resourceType: rec.resourceType, resourceId: rec.resourceId, department: rec.departmentId, ip: rec.ip, detail: rec.detail, at: rec.at });
  }
}
type CourseAttendanceStatLike = { courseId: string; courseCode: string; title: string; sessionsHeld: number; enrolled: number; attendanceRecords: number };
