import type { ComplaintStatusName } from "../hod/policy";
import type { LecturerComplaintEvent, LecturerComplaintQuery, LecturerComplaintRec, AttendanceRecordView, AnnouncementRec, CourseRec, CourseWorkRec, LecturerAssignmentRec, LecturerAuditRec, LecturerRec, LecturerSessionRec, MaterialRec, MemberRec, NotificationView, SubmissionView, TimetableRec } from "./types";

/** Storage the lecturer engine needs. Every lookup that takes a departmentId filters by it. */
export interface LecturerStore {
  getCurrentTerm(departmentId: string): Promise<{ academicSession: string; semester: "FIRST" | "SECOND" } | null>;
  getLecturer(lecturerId: string): Promise<LecturerRec | null>;
  getDepartment(departmentId: string): Promise<{ id: string; name: string; code: string } | null>;
  /** Only whitelisted personal fields; role / department / staffId are not parameters, so they can't be changed through here. */
  updateLecturerProfile(lecturerId: string, patch: { phone?: string | null; profilePhoto?: string | null; profilePhotoPublicId?: string | null }): Promise<LecturerRec | null>;
  /** All of THIS lecturer's assignments in any status (the engine decides which count). */
  assignmentsForLecturer(lecturerId: string): Promise<LecturerAssignmentRec[]>;
  getCourse(courseId: string, departmentId: string): Promise<CourseRec | null>;
  /** Lecturers with an ACTIVE assignment on each course (suspended ones left out), in this department only. */
  courseLecturers(departmentId: string, courseIds: string[]): Promise<Map<string, { lecturerId: string; name: string }[]>>;

  listMembers(course: CourseRec, q: { page: number; limit: number; search?: string }): Promise<{ items: MemberRec[]; total: number }>;
  countMembers(course: CourseRec): Promise<number>;
  /** Course-view timetable (any source); the engine hides drafts. */
  listTimetable(courses: CourseRec[]): Promise<TimetableRec[]>;

  createAnnouncement(rec: Omit<AnnouncementRec, "id" | "createdAt" | "updatedAt">): Promise<AnnouncementRec>;
  getAnnouncement(id: string, departmentId: string): Promise<AnnouncementRec | null>;
  /** Only ever touches lecturer-written announcements. */
  updateAnnouncement(id: string, patch: Partial<Pick<AnnouncementRec, "title" | "body" | "priority" | "status" | "expiresAt" | "publishedAt">> & { image?: { url: string; publicId?: string } | null }): Promise<AnnouncementRec | null>;
  /** Everything a class sees for these courses (lecturer's and reps'), except DELETED and other people's drafts. */
  listAnnouncements(courseIds: string[], viewerLecturerId: string): Promise<AnnouncementRec[]>;

  createMaterial(rec: Omit<MaterialRec, "id" | "createdAt" | "updatedAt">): Promise<MaterialRec>;
  getMaterial(id: string, departmentId: string): Promise<MaterialRec | null>;
  /** Only ever touches OFFICIAL_COURSE_MATERIAL. */
  updateMaterial(id: string, patch: Partial<Pick<MaterialRec, "title" | "description" | "status">>): Promise<MaterialRec | null>;
  deleteMaterial(id: string): Promise<void>;
  /** OFFICIAL materials only: class resources written by representatives are never mixed in. */
  listOfficialMaterials(courses: CourseRec[]): Promise<MaterialRec[]>;

  createCourseWork(rec: Omit<CourseWorkRec, "id" | "createdAt" | "updatedAt">): Promise<CourseWorkRec>;
  getCourseWork(id: string, departmentId: string): Promise<CourseWorkRec | null>;
  updateCourseWork(id: string, patch: Partial<Pick<CourseWorkRec, "title" | "description" | "dueAt" | "allowLateSubmission" | "status">> & { attachment?: CourseWorkRec["attachment"] | null }): Promise<CourseWorkRec | null>;
  deleteCourseWork(id: string): Promise<void>;
  listCourseWork(courseIds: string[]): Promise<CourseWorkRec[]>;
  countSubmissions(assignmentId: string): Promise<number>;
  listSubmissions(assignmentId: string): Promise<SubmissionView[]>;

  createAttendanceSession(rec: Omit<LecturerSessionRec, "id" | "createdAt">): Promise<LecturerSessionRec>;
  getAttendanceSession(id: string, departmentId: string): Promise<LecturerSessionRec | null>;
  updateAttendanceSession(id: string, patch: Partial<Pick<LecturerSessionRec, "status" | "opensAt" | "closesAt">>): Promise<LecturerSessionRec | null>;
  listAttendanceSessions(course: CourseRec): Promise<LecturerSessionRec[]>;
  recordsForSessions(sessionIds: string[]): Promise<AttendanceRecordView[]>;
  /** Flagged (suspicious) security log entries for a session, for the lecturer's live view. */
  flaggedAttempts(sessionId: string): Promise<number>;

  /** Complaints the HOD forwarded to THIS lecturer, in THIS department. Nothing else is reachable through these three methods. */
  listComplaints(departmentId: string, lecturerId: string, q: LecturerComplaintQuery): Promise<{ items: LecturerComplaintRec[]; total: number }>;
  getAssignedComplaint(departmentId: string, lecturerId: string, complaintId: string): Promise<LecturerComplaintRec | null>;
  /**
   * Appends a timeline event (and optionally moves the status) in ONE conditional write: it applies only if the complaint is still assigned to this
   * lecturer and still in one of `expected`, so a concurrent HOD decision can't be overwritten. Null = nothing was written.
   */
  appendComplaintEvent(departmentId: string, lecturerId: string, complaintId: string, expected: readonly ComplaintStatusName[], event: LecturerComplaintEvent, newStatus?: ComplaintStatusName): Promise<LecturerComplaintRec | null>;

  listNotifications(lecturerId: string, q: { page: number; limit: number; unread?: boolean }): Promise<{ items: NotificationView[]; total: number; unread: number }>;
  markNotificationRead(lecturerId: string, notificationId: string): Promise<NotificationView | null>;
  markAllNotificationsRead(lecturerId: string): Promise<number>;
  unreadNotificationCount(lecturerId: string): Promise<number>;

  addAudit(rec: LecturerAuditRec): Promise<void>;
}
