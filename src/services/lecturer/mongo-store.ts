import { AcademicTerm } from "../../models/AcademicTerm";
import { Announcement, AnnouncementDocument } from "../../models/Announcement";
import { Assignment, AssignmentDocument } from "../../models/Assignment";
import { AssignmentSubmission } from "../../models/AssignmentSubmission";
import { AttendanceRecord } from "../../models/AttendanceRecord";
import { AttendanceSecurityLog } from "../../models/AttendanceSecurityLog";
import { AttendanceSession, AttendanceSessionDocument } from "../../models/AttendanceSession";
import { Complaint } from "../../models/Complaint";
import { Course, CourseDocument } from "../../models/Course";
import { Department } from "../../models/Department";
import { Lecturer, LecturerDocument } from "../../models/Lecturer";
import { LecturerAuditLog } from "../../models/LecturerAuditLog";
import { LecturerCourseAssignment, LecturerCourseAssignmentDocument } from "../../models/LecturerCourseAssignment";
import { Material, MaterialDocument } from "../../models/Material";
import { Notification, NotificationDocument } from "../../models/Notification";
import { Student } from "../../models/Student";
import { lecturersByCourse } from "../course-lecturers";
import { MongoHodStore } from "../hod/mongo-store";
import type { ComplaintStatusName } from "../hod/policy";
import { MongoRepresentativeStore } from "../representative/mongo-store";
import type { LecturerStore } from "./store";
import type {
  AnnouncementRec, AttendanceRecordView, CourseRec, CourseWorkRec, LecturerAssignmentRec, LecturerAuditRec, LecturerRec, LecturerSessionRec,
  MaterialRec, NotificationView, SubmissionView, LecturerComplaintEvent, LecturerComplaintQuery, LecturerComplaintRec,
} from "./types";

const id = (v: unknown) => String(v);
const stamps = (d: unknown) => d as { createdAt: Date; updatedAt: Date };

const toLecturer = (l: LecturerDocument): LecturerRec => ({
  id: id(l._id), firstName: l.firstName, lastName: l.lastName, email: l.email, phone: l.phone ?? undefined, staffId: l.staffId, departmentId: id(l.department),
  role: l.role, profilePhoto: l.profilePhoto ?? undefined, profilePhotoPublicId: l.profilePhotoPublicId ?? undefined, status: l.status, createdAt: stamps(l).createdAt, updatedAt: stamps(l).updatedAt,
});
const toAssignment = (a: LecturerCourseAssignmentDocument): LecturerAssignmentRec => ({
  id: id(a._id), lecturerId: id(a.lecturer), departmentId: id(a.department), courseId: id(a.course), courseCode: a.courseCode, level: a.level,
  academicSession: a.academicSession, semester: a.semester, status: a.status, assignedBy: { name: a.assignedBy.name, role: a.assignedBy.role }, assignedAt: a.assignedAt,
});
const toCourse = (c: CourseDocument): CourseRec => ({
  id: id(c._id), departmentId: id(c.department), courseCode: c.courseCode, title: c.title, units: c.units, level: c.level, semester: c.semester, academicSession: c.academicSession, status: c.status,
});
const toAnnouncement = (a: AnnouncementDocument): AnnouncementRec => ({
  id: id(a._id), departmentId: id(a.department), courseId: id(a.course), courseCode: a.audience.courseCodes?.[0] ?? "", level: a.level ?? "", academicSession: a.academicSession ?? "",
  semester: (a.semester ?? "FIRST") as "FIRST" | "SECOND", title: a.title, body: a.body, priority: a.priority, status: a.status as AnnouncementRec["status"],
  lecturerId: a.createdByLecturer ? id(a.createdByLecturer) : undefined, studentId: a.createdByStudent ? id(a.createdByStudent) : undefined,
  authorName: a.createdByName, authorRole: a.createdByRole, image: a.image?.url ? { url: a.image.url, publicId: a.image.publicId ?? undefined } : undefined,
  publishedAt: a.status === "PUBLISHED" ? a.publishedAt : undefined, expiresAt: a.expiresAt ?? null,
  createdAt: stamps(a).createdAt, updatedAt: stamps(a).updatedAt,
});
const toWork = (a: AssignmentDocument): CourseWorkRec => ({
  id: id(a._id), departmentId: id(a.department), courseId: id(a.course), courseCode: a.courseCode, level: a.level, academicSession: a.academicSession, semester: a.semester,
  title: a.title, description: a.instructions, dueAt: a.dueAt, allowLateSubmission: a.allowLateSubmission,
  attachment: a.attachment?.url ? { url: a.attachment.url, publicId: a.attachment.publicId ?? undefined, originalName: a.attachment.originalName ?? a.title, mimeType: a.attachment.mimeType ?? "application/octet-stream", sizeBytes: a.attachment.sizeBytes ?? 0 } : undefined,
  status: a.status, lecturerId: a.lecturer ? id(a.lecturer) : undefined, authorName: a.createdByName, createdAt: stamps(a).createdAt, updatedAt: stamps(a).updatedAt,
});
const toSession = (s: AttendanceSessionDocument): LecturerSessionRec => {
  const loc = s.location;
  const radius = loc?.allowedRadiusInMeters ?? loc?.radiusMeters; // legacy field name still read
  return {
    id: id(s._id), departmentId: id(s.department), courseId: s.course ? id(s.course) : "", lecturerId: s.lecturer ? id(s.lecturer) : "", courseCode: s.courseCode, level: s.level,
    academicSession: s.academicSession, semester: s.semester, title: s.title, opensAt: s.opensAt, closesAt: s.closesAt, lateAfterMinutes: s.lateAfterMinutes,
    codeHash: s.codeHash ?? undefined, status: s.status, createdAt: stamps(s).createdAt,
    location: loc?.latitude != null && loc?.longitude != null && radius != null ? { latitude: loc.latitude, longitude: loc.longitude, allowedRadiusInMeters: radius, accuracyMeters: loc.accuracyMeters ?? undefined } : undefined,
  };
};
const toNotification = (n: NotificationDocument): NotificationView => ({
  id: id(n._id), kind: n.kind, title: n.title, body: n.body, link: n.link ?? undefined, read: Boolean(n.readAt), createdAt: stamps(n).createdAt,
});

/** MongoDB implementation. Department is part of every lookup; lecturers only ever reach lecturer-owned announcements / official materials / their own assignments. */
export class MongoLecturerStore implements LecturerStore {
  private readonly shared = new MongoRepresentativeStore(); // class lists + timetable reads are identical, so reuse them
  private readonly hod = new MongoHodStore(); // complaint reads reuse the HOD store's mapping: one Complaint collection, one shape

  listComplaints(departmentId: string, lecturerId: string, q: LecturerComplaintQuery) {
    return this.hod.listComplaints(departmentId, { ...q, assignedLecturerId: lecturerId }); // the assignee filter is set here, never taken from the request
  }
  async getAssignedComplaint(departmentId: string, lecturerId: string, complaintId: string) {
    const c = await this.hod.getComplaint(departmentId, complaintId);
    return c && c.assignedLecturer?.id === lecturerId ? c : null;
  }
  async appendComplaintEvent(departmentId: string, lecturerId: string, complaintId: string, expected: readonly ComplaintStatusName[], event: LecturerComplaintEvent, newStatus?: ComplaintStatusName): Promise<LecturerComplaintRec | null> {
    const hit = await Complaint.findOneAndUpdate(
      { _id: complaintId, department: departmentId, assignedLecturer: lecturerId, status: { $in: expected } },
      { ...(newStatus ? { $set: { status: newStatus } } : {}), $push: { timeline: { status: event.status, label: event.label, note: event.note, at: event.at, byRole: event.byRole, byId: event.byId, byName: event.byName, internal: event.internal } } },
      { new: true, runValidators: true },
    ).select("_id");
    return hit ? this.hod.getComplaint(departmentId, complaintId) : null;
  }

  async getCurrentTerm(departmentId: string) {
    const t = await AcademicTerm.findOne({ department: departmentId, isCurrent: true });
    return t ? { academicSession: t.academicSession, semester: t.semester } : null;
  }
  async getLecturer(lecturerId: string) {
    const l = await Lecturer.findById(lecturerId).select("+profilePhotoPublicId");
    return l ? toLecturer(l) : null;
  }
  async getDepartment(departmentId: string) {
    const d = await Department.findById(departmentId);
    return d ? { id: id(d._id), name: d.name, code: d.code } : null;
  }
  async updateLecturerProfile(lecturerId: string, patch: { phone?: string | null; profilePhoto?: string | null; profilePhotoPublicId?: string | null }) {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ""> = {};
    for (const k of ["phone", "profilePhoto", "profilePhotoPublicId"] as const) {
      if (patch[k] === undefined) continue;
      if (patch[k] === null) $unset[k] = ""; else $set[k] = patch[k];
    }
    const l = await Lecturer.findByIdAndUpdate(lecturerId, { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) }, { new: true, runValidators: true }).select("+profilePhotoPublicId");
    return l ? toLecturer(l) : null;
  }
  async assignmentsForLecturer(lecturerId: string) {
    return (await LecturerCourseAssignment.find({ lecturer: lecturerId }).sort({ assignedAt: -1 })).map(toAssignment);
  }
  courseLecturers(departmentId: string, courseIds: string[]) { return lecturersByCourse(departmentId, courseIds); }
  async getCourse(courseId: string, departmentId: string) {
    const c = await Course.findOne({ _id: courseId, department: departmentId });
    return c ? toCourse(c) : null;
  }

  listMembers(course: CourseRec, q: { page: number; limit: number; search?: string }) { return this.shared.listMembers(course, q); }
  countMembers(course: CourseRec) { return this.shared.countMembers(course); }
  listTimetable(courses: CourseRec[]) { return this.shared.listTimetable(courses, "course"); }

  async createAnnouncement(rec: Omit<AnnouncementRec, "id" | "createdAt" | "updatedAt">) {
    const a = await Announcement.create({
      department: rec.departmentId, title: rec.title, body: rec.body, priority: rec.priority, status: rec.status,
      audience: { scope: "COURSE", courseCodes: [rec.courseCode] }, // built from the assigned course, never from request data
      createdByName: rec.authorName, createdByRole: rec.authorRole, createdByLecturer: rec.lecturerId, course: rec.courseId,
      level: rec.level, academicSession: rec.academicSession, semester: rec.semester, publishedAt: rec.publishedAt ?? new Date(), expiresAt: rec.expiresAt ?? undefined,
      ...(rec.image ? { image: { url: rec.image.url, publicId: rec.image.publicId } } : {}),
    });
    return toAnnouncement(a);
  }
  async getAnnouncement(announcementId: string, departmentId: string) {
    // Lecturer-written announcements only: a course representative's announcement is never reachable by a lecturer (it looks like a missing id).
    const a = await Announcement.findOne({ _id: announcementId, department: departmentId, createdByLecturer: { $exists: true } }).select("+image.publicId");
    return a ? toAnnouncement(a) : null;
  }
  async updateAnnouncement(announcementId: string, patch: Partial<Pick<AnnouncementRec, "title" | "body" | "priority" | "status" | "expiresAt" | "publishedAt">> & { image?: { url: string; publicId?: string } | null }) {
    const { expiresAt, image, ...rest } = patch;
    const update: Record<string, unknown> = { $set: { ...rest, ...(expiresAt ? { expiresAt } : {}), ...(image ? { image: { url: image.url, publicId: image.publicId } } : {}) } };
    const unset: Record<string, ""> = {};
    if (expiresAt === null) unset.expiresAt = "";
    if (image === null) unset.image = "";
    if (Object.keys(unset).length) update.$unset = unset;
    // Defence in depth: only lecturer-written announcements can ever be modified here (a rep's can't).
    const a = await Announcement.findOneAndUpdate({ _id: announcementId, createdByLecturer: { $exists: true } }, update, { new: true, runValidators: true }).select("+image.publicId");
    return a ? toAnnouncement(a) : null;
  }
  async listAnnouncements(courseIds: string[], viewerLecturerId: string) {
    if (!courseIds.length) return [];
    const rows = await Announcement.find({
      course: { $in: courseIds },
      createdByLecturer: { $exists: true }, // lecturers see lecturers' announcements only, never a course representative's
      $or: [{ status: "PUBLISHED" }, { createdByLecturer: viewerLecturerId, status: { $in: ["DRAFT", "UNPUBLISHED"] } }],
    }).select("+image.publicId").sort({ createdAt: -1 }).limit(300);
    return rows.map(toAnnouncement);
  }

  private async toMaterial(m: MaterialDocument): Promise<MaterialRec> {
    let courseId = m.course ? id(m.course) : undefined;
    if (!courseId && m.courseCode) courseId = (await Course.findOne({ department: m.department, courseCode: m.courseCode, academicSession: m.academicSession, semester: m.semester }).select("_id"))?._id?.toString();
    return {
      id: id(m._id), departmentId: id(m.department), courseId, courseCode: m.courseCode ?? "", level: m.level, academicSession: m.academicSession, semester: m.semester, title: m.title,
      description: m.description ?? undefined, type: m.type, file: { url: m.file.url, publicId: m.file.publicId ?? undefined, originalName: m.file.originalName, mimeType: m.file.mimeType, sizeBytes: m.file.sizeBytes },
      lecturerId: m.lecturer ? id(m.lecturer) : undefined, studentId: m.createdByStudent ? id(m.createdByStudent) : undefined, uploadedByName: m.uploadedByName, uploadedByRole: m.uploadedByRole,
      status: m.status, createdAt: stamps(m).createdAt, updatedAt: stamps(m).updatedAt,
    };
  }
  async createMaterial(rec: Omit<MaterialRec, "id" | "createdAt" | "updatedAt">) {
    const m = await Material.create({
      department: rec.departmentId, title: rec.title, description: rec.description, type: "OFFICIAL_COURSE_MATERIAL", courseCode: rec.courseCode, level: rec.level, semester: rec.semester,
      academicSession: rec.academicSession, file: { url: rec.file.url, publicId: rec.file.publicId, originalName: rec.file.originalName, mimeType: rec.file.mimeType, sizeBytes: rec.file.sizeBytes },
      uploadedByName: rec.uploadedByName, uploadedByRole: rec.uploadedByRole, status: rec.status, course: rec.courseId, lecturer: rec.lecturerId,
    });
    return this.toMaterial(m);
  }
  async getMaterial(materialId: string, departmentId: string) {
    const m = await Material.findOne({ _id: materialId, department: departmentId });
    return m ? this.toMaterial(m) : null;
  }
  async updateMaterial(materialId: string, patch: Partial<Pick<MaterialRec, "title" | "description" | "status">>) {
    const m = await Material.findOneAndUpdate({ _id: materialId, type: "OFFICIAL_COURSE_MATERIAL" }, { $set: patch }, { new: true, runValidators: true }); // never a rep's CLASS_RESOURCE
    return m ? this.toMaterial(m) : null;
  }
  async deleteMaterial(materialId: string) { await Material.deleteOne({ _id: materialId, type: "OFFICIAL_COURSE_MATERIAL" }); }
  async listOfficialMaterials(courses: CourseRec[]) {
    if (!courses.length) return [];
    const rows = await Material.find({
      type: "OFFICIAL_COURSE_MATERIAL",
      $or: courses.map((c) => ({ department: c.departmentId, courseCode: c.courseCode, academicSession: c.academicSession, semester: c.semester })),
    }).sort({ createdAt: -1 }).limit(500);
    return Promise.all(rows.map((m) => this.toMaterial(m)));
  }

  async createCourseWork(rec: Omit<CourseWorkRec, "id" | "createdAt" | "updatedAt">) {
    const a = await Assignment.create({
      department: rec.departmentId, courseCode: rec.courseCode, title: rec.title, instructions: rec.description, level: rec.level, academicSession: rec.academicSession, semester: rec.semester,
      dueAt: rec.dueAt, allowLateSubmission: rec.allowLateSubmission, status: rec.status, createdByName: rec.authorName, createdByRole: "LECTURER", course: rec.courseId, lecturer: rec.lecturerId,
      attachment: rec.attachment ? { url: rec.attachment.url, publicId: rec.attachment.publicId, originalName: rec.attachment.originalName, mimeType: rec.attachment.mimeType, sizeBytes: rec.attachment.sizeBytes } : undefined,
    });
    return toWork(a);
  }
  async getCourseWork(workId: string, departmentId: string) {
    const a = await Assignment.findOne({ _id: workId, department: departmentId });
    return a ? toWork(a) : null;
  }
  async updateCourseWork(workId: string, patch: Parameters<LecturerStore["updateCourseWork"]>[1]) {
    const { attachment, description, dueAt, ...rest } = patch;
    const $set: Record<string, unknown> = { ...rest, ...(description !== undefined ? { instructions: description } : {}), ...(dueAt ? { dueAt } : {}) };
    const update: Record<string, unknown> = {};
    if (attachment) $set.attachment = { url: attachment.url, publicId: attachment.publicId, originalName: attachment.originalName, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes };
    if (Object.keys($set).length) update.$set = $set;
    if (attachment === null) update.$unset = { attachment: "" };
    const a = await Assignment.findOneAndUpdate({ _id: workId, lecturer: { $exists: true } }, update, { new: true, runValidators: true });
    return a ? toWork(a) : null;
  }
  async deleteCourseWork(workId: string) { await Assignment.deleteOne({ _id: workId, lecturer: { $exists: true } }); }
  async listCourseWork(courseIds: string[]) {
    if (!courseIds.length) return [];
    return (await Assignment.find({ course: { $in: courseIds } }).sort({ dueAt: 1 }).limit(500)).map(toWork);
  }
  countSubmissions(workId: string) { return AssignmentSubmission.countDocuments({ assignment: workId }); }
  async listSubmissions(workId: string): Promise<SubmissionView[]> {
    const subs = await AssignmentSubmission.find({ assignment: workId }).sort({ submittedAt: 1 });
    const students = await Student.find({ _id: { $in: subs.map((s) => s.student) } }).select("firstName lastName matricNumber");
    const byId = new Map(students.map((s) => [id(s._id), s]));
    return subs.map((s) => {
      const st = byId.get(id(s.student));
      return {
        id: id(s._id), assignmentId: id(s.assignment), studentId: id(s.student), firstName: st?.firstName ?? "", lastName: st?.lastName ?? "", matricNumber: st?.matricNumber ?? "",
        submittedAt: s.submittedAt, isLate: s.isLate, content: s.content ?? undefined,
        file: s.file?.publicId ? { name: s.file.originalName ?? "file", mimeType: s.file.mimeType ?? "", sizeBytes: s.file.sizeBytes ?? 0, publicId: s.file.publicId, resourceType: s.file.resourceType ?? "raw" } : undefined,
      };
    });
  }

  async createAttendanceSession(rec: Omit<LecturerSessionRec, "id" | "createdAt">) {
    const s = await AttendanceSession.create({
      department: rec.departmentId, course: rec.courseId, lecturer: rec.lecturerId, createdBy: rec.lecturerId, courseCode: rec.courseCode, level: rec.level,
      academicSession: rec.academicSession, semester: rec.semester, title: rec.title, opensAt: rec.opensAt, closesAt: rec.closesAt, lateAfterMinutes: rec.lateAfterMinutes,
      codeHash: rec.codeHash, status: rec.status, location: rec.location, createdByName: "Lecturer", createdByRole: "LECTURER",
    });
    return toSession(s);
  }
  async getAttendanceSession(sessionId: string, departmentId: string) {
    const s = await AttendanceSession.findOne({ _id: sessionId, department: departmentId }).select("+codeHash");
    return s ? toSession(s) : null;
  }
  async updateAttendanceSession(sessionId: string, patch: Partial<Pick<LecturerSessionRec, "status" | "opensAt" | "closesAt">>) {
    const s = await AttendanceSession.findOneAndUpdate({ _id: sessionId }, { $set: patch }, { new: true }).select("+codeHash");
    return s ? toSession(s) : null;
  }
  async listAttendanceSessions(course: CourseRec) {
    const rows = await AttendanceSession.find({ department: course.departmentId, courseCode: course.courseCode, academicSession: course.academicSession, semester: course.semester }).select("+codeHash").sort({ opensAt: -1 }).limit(500);
    return rows.map(toSession);
  }
  async recordsForSessions(sessionIds: string[]): Promise<AttendanceRecordView[]> {
    if (!sessionIds.length) return [];
    const recs = await AttendanceRecord.find({ session: { $in: sessionIds } });
    const students = await Student.find({ _id: { $in: recs.map((r) => r.student) } }).select("firstName lastName matricNumber");
    const byId = new Map(students.map((s) => [id(s._id), s]));
    return recs.map((r) => {
      const st = byId.get(id(r.student));
      return { sessionId: id(r.session), studentId: id(r.student), firstName: st?.firstName ?? "", lastName: st?.lastName ?? "", matricNumber: st?.matricNumber ?? "", status: r.status, markedAt: r.markedAt, distanceMeters: r.location?.distanceMeters ?? undefined };
    });
  }
  flaggedAttempts(sessionId: string) { return AttendanceSecurityLog.countDocuments({ session: sessionId, flagged: true }); }

  async listNotifications(lecturerId: string, q: { page: number; limit: number; unread?: boolean }) {
    const base = { recipient: lecturerId, recipientType: "LECTURER" as const };
    const filter = { ...base, ...(q.unread ? { readAt: { $exists: false } } : {}) };
    const [rows, total, unread] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
      Notification.countDocuments(filter), Notification.countDocuments({ ...base, readAt: { $exists: false } }),
    ]);
    return { items: rows.map(toNotification), total, unread };
  }
  async markNotificationRead(lecturerId: string, notificationId: string) {
    const n = await Notification.findOneAndUpdate({ _id: notificationId, recipient: lecturerId, recipientType: "LECTURER" }, { $set: { readAt: new Date() } }, { new: true });
    return n ? toNotification(n) : null;
  }
  async markAllNotificationsRead(lecturerId: string) {
    return (await Notification.updateMany({ recipient: lecturerId, recipientType: "LECTURER", readAt: { $exists: false } }, { $set: { readAt: new Date() } })).modifiedCount;
  }
  unreadNotificationCount(lecturerId: string) { return Notification.countDocuments({ recipient: lecturerId, recipientType: "LECTURER", readAt: { $exists: false } }); }

  async addAudit(rec: LecturerAuditRec) {
    await LecturerAuditLog.create({
      actor: rec.actorId, actorName: rec.actorName, role: rec.role, action: rec.action, resourceType: rec.resourceType, resourceId: rec.resourceId,
      course: rec.courseId, courseCode: rec.courseCode, department: rec.departmentId, ip: rec.ip, detail: rec.detail, at: rec.at,
    });
  }
}
