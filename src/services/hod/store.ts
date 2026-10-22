import type {
  AnnouncementFilter, ListQuery, AttendanceRecordView, ComplaintEvent, ComplaintFilter, ComplaintPatch, ComplaintRec, CourseAttendanceStat, CourseFilter, CourseRec, CourseView,
  DashboardCounts, DeptRec, DocumentRec, EnrollmentView, HodAnnouncementRec, HodAuditRec, HodRec, ActivityItem, LecturerAssignmentRec, LecturerAssignmentView,
  LecturerFilter, LecturerRow, MaterialOverview, NotificationView, Page, RepAssignmentView, RepFilter, SessionFilter, SessionView, StudentAttendanceRow,
  StudentFilter, StudentRow, TermRec, TimetableFilter, TimetableRec, RepAssignmentRec,
} from "./types";

export class StoreDuplicateError extends Error { constructor(what: string) { super(`Duplicate: ${what}`); this.name = "StoreDuplicateError"; } }

/**
 * Storage for the HOD engine. EVERY method takes the department id and filters by it, so an id that belongs to another department is
 * indistinguishable from an id that doesn't exist. The engine passes the authenticated HOD's department, never a request value.
 */
export interface HodStore {
  /* identity / department / term */
  getHod(hodId: string): Promise<HodRec | null>;
  updateHodProfile(hodId: string, patch: { phone?: string | null; profilePhoto?: string | null; profilePhotoPublicId?: string | null }): Promise<HodRec | null>;
  getDepartment(departmentId: string): Promise<DeptRec | null>;
  updateDepartment(departmentId: string, patch: { name?: string; faculty?: string; contact?: { email?: string; phone?: string; office?: string }; levels?: string[] }): Promise<DeptRec | null>;
  levelUsage(departmentId: string): Promise<{ level: string; students: number; courses: number }[]>;
  getCurrentTerm(departmentId: string): Promise<TermRec | null>;
  /** Marks (creating if needed) the given term current and un-marks the previous one. */
  setCurrentTerm(departmentId: string, term: { academicSession: string; semester: "FIRST" | "SECOND" }): Promise<TermRec>;
  updateRegistration(departmentId: string, patch: { registrationOpen?: boolean; registrationOpensAt?: Date | null; registrationClosesAt?: Date | null; maxUnits?: number }): Promise<TermRec | null>;

  /* students */
  listStudents(departmentId: string, q: StudentFilter): Promise<Page<StudentRow>>;
  getStudent(departmentId: string, studentId: string): Promise<StudentRow | null>;
  setStudentStatus(departmentId: string, studentId: string, status: "ACTIVE" | "SUSPENDED"): Promise<StudentRow | null>;
  /** Updates only students of this department; returns how many changed. */
  updateStudentAcademic(departmentId: string, studentIds: string[], patch: { level?: string; academicSession?: string }): Promise<number>;
  countStudentsInDepartment(departmentId: string, studentIds: string[]): Promise<number>;
  studentEnrollments(departmentId: string, studentId: string): Promise<EnrollmentView[]>;
  studentAttendance(departmentId: string, studentId: string, term: { academicSession: string; semester: string }): Promise<StudentAttendanceRow[]>;

  /* lecturers */
  listLecturers(departmentId: string, q: LecturerFilter): Promise<Page<LecturerRow>>;
  getLecturer(departmentId: string, lecturerId: string): Promise<LecturerRow | null>;
  /** Throws StoreDuplicateError for an existing email / staff id. */
  createLecturer(rec: { departmentId: string; firstName: string; lastName: string; email: string; phone?: string; staffId: string; activationTokenHash: string; activationExpires: Date }): Promise<LecturerRow>;
  updateLecturer(departmentId: string, lecturerId: string, patch: { firstName?: string; lastName?: string; phone?: string | null }): Promise<LecturerRow | null>;
  setLecturerStatus(departmentId: string, lecturerId: string, status: "ACTIVE" | "SUSPENDED"): Promise<LecturerRow | null>;
  reissueLecturerInvitation(departmentId: string, lecturerId: string, tokenHash: string, expires: Date): Promise<boolean>;
  lecturerAssignments(departmentId: string, lecturerId: string): Promise<LecturerAssignmentView[]>;
  /** Throws StoreDuplicateError if this lecturer already holds the course. */
  createLecturerAssignment(rec: Omit<LecturerAssignmentRec, "id">): Promise<LecturerAssignmentRec>;
  hasActiveLecturerAssignment(departmentId: string, lecturerId: string, courseId: string): Promise<boolean>;
  revokeLecturerAssignment(departmentId: string, lecturerId: string, courseId: string, by: { name: string; role: string }): Promise<LecturerAssignmentRec | null>;

  /* courses */
  listCourses(departmentId: string, q: CourseFilter): Promise<Page<CourseView>>;
  getCourse(departmentId: string, courseId: string): Promise<CourseRec | null>;
  /** Throws StoreDuplicateError for the same (department, code, session, semester). */
  createCourse(rec: Omit<CourseRec, "id">): Promise<CourseRec>;
  updateCourse(departmentId: string, courseId: string, patch: Partial<Pick<CourseRec, "title" | "description" | "units" | "level" | "semester" | "status">>): Promise<CourseRec | null>;
  countEnrollments(course: CourseRec): Promise<number>;
  courseLecturers(course: CourseRec): Promise<{ lecturerId: string; name: string }[]>;
  courseRepresentatives(course: CourseRec): Promise<RepAssignmentView[]>;

  /* representatives (CourseRepresentativeAssignment) */
  listRepAssignments(departmentId: string, q: RepFilter): Promise<Page<RepAssignmentView>>;
  getRepAssignment(departmentId: string, assignmentId: string): Promise<RepAssignmentView | null>;
  /** Legacy course-scoped appointments only. */
  activeRepsOnCourse(departmentId: string, courseId: string): Promise<{ studentId: string; role: "COURSE_REP" | "ASSISTANT_COURSE_REP" }[]>;
  /** ACTIVE level appointments of a level in a term. */
  activeRepsOnLevel(departmentId: string, level: string, academicSession: string, semester: "FIRST" | "SECOND"): Promise<{ studentId: string; role: "COURSE_REP" | "ASSISTANT_COURSE_REP" }[]>;
  isEnrolled(departmentId: string, studentId: string, course: CourseRec): Promise<boolean>;
  /** Throws StoreDuplicateError (unique partial indexes are the final guard). */
  createRepAssignment(rec: Omit<RepAssignmentRec, "id">): Promise<RepAssignmentRec>;
  setRepAssignmentStatus(departmentId: string, assignmentId: string, status: "ACTIVE" | "INACTIVE"): Promise<RepAssignmentView | null>;
  revokeRepAssignment(departmentId: string, assignmentId: string, by: { name: string; role: string }): Promise<RepAssignmentView | null>;

  /* timetable (read-only) */
  listTimetable(departmentId: string, term: { academicSession: string; semester: string }, q: TimetableFilter): Promise<Page<TimetableRec>>;
  allTimetable(departmentId: string, term: { academicSession: string; semester: string }): Promise<TimetableRec[]>;

  /* announcements */
  listAnnouncements(departmentId: string, hodId: string, q: AnnouncementFilter): Promise<Page<HodAnnouncementRec>>;
  getAnnouncement(departmentId: string, id: string): Promise<HodAnnouncementRec | null>;
  createAnnouncement(rec: Omit<HodAnnouncementRec, "id" | "createdAt" | "updatedAt">): Promise<HodAnnouncementRec>;
  /** Only ever touches HOD-written announcements. */
  updateAnnouncement(id: string, patch: Partial<Pick<HodAnnouncementRec, "title" | "body" | "priority" | "status" | "expiresAt" | "publishedAt" | "levels" | "scope">> & { image?: { url: string; publicId?: string } | null }): Promise<HodAnnouncementRec | null>;

  /* department documents + read-only materials overview */
  listDocuments(departmentId: string, q: ListQuery & { status?: string }): Promise<Page<DocumentRec>>;
  getDocument(departmentId: string, id: string): Promise<DocumentRec | null>;
  createDocument(rec: Omit<DocumentRec, "id" | "createdAt" | "updatedAt">): Promise<DocumentRec>;
  updateDocument(departmentId: string, id: string, patch: Partial<Pick<DocumentRec, "title" | "description" | "levels" | "status">>): Promise<DocumentRec | null>;
  deleteDocument(departmentId: string, id: string): Promise<void>;
  listMaterialsOverview(departmentId: string, q: ListQuery & { type?: string; courseCode?: string }): Promise<Page<MaterialOverview>>;

  /* attendance (read-only) */
  listSessions(departmentId: string, term: { academicSession: string; semester: string } | null, q: SessionFilter, now: Date): Promise<Page<SessionView>>;
  getSession(departmentId: string, sessionId: string): Promise<SessionView | null>;
  sessionRecordCounts(sessionIds: string[]): Promise<Map<string, { present: number; late: number }>>;
  recordsForSession(sessionId: string): Promise<AttendanceRecordView[]>;
  flaggedAttempts(sessionId: string): Promise<number>;
  enrolledCountsByCourse(departmentId: string, term: { academicSession: string; semester: string }): Promise<Map<string, number>>;
  courseAttendanceStats(departmentId: string, term: { academicSession: string; semester: string }, now: Date): Promise<CourseAttendanceStat[]>;

  /* complaints */
  listComplaints(departmentId: string, q: ComplaintFilter): Promise<Page<ComplaintRec>>;
  getComplaint(departmentId: string, id: string): Promise<ComplaintRec | null>;
  updateComplaint(departmentId: string, id: string, patch: ComplaintPatch, event: ComplaintEvent): Promise<ComplaintRec | null>;
  addComplaintEvent(departmentId: string, id: string, event: ComplaintEvent): Promise<ComplaintRec | null>;

  /* notifications (same collection as students / lecturers) */
  listNotifications(hodId: string, q: { page: number; limit: number; unread?: boolean }): Promise<{ items: NotificationView[]; total: number; unread: number }>;
  markNotificationRead(hodId: string, id: string): Promise<NotificationView | null>;
  markAllNotificationsRead(hodId: string): Promise<number>;

  /* dashboard / audit */
  dashboardCounts(departmentId: string, term: { academicSession: string; semester: string } | null, now: Date): Promise<DashboardCounts>;
  recentActivity(departmentId: string, limit: number): Promise<ActivityItem[]>;
  addAudit(rec: HodAuditRec): Promise<void>;
}
