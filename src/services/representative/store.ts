import type { AnnouncementImage, AnnouncementRec, AssignmentRec, AuditRec, CourseRec, MemberRec, ResourceRec, TimetableRec } from "./types";

/** What a rep may list: announcements for these courses, plus class-wide (no course) announcements of these level + term classes. */
export interface AnnouncementViewScope { courseIds: string[]; classes: { level: string; academicSession: string; semester: "FIRST" | "SECOND" }[] }

/** Storage the representative engine needs. Every lookup that takes a departmentId filters by it. */
export interface RepresentativeStore {
  getCurrentTerm(departmentId: string): Promise<{ academicSession: string; semester: "FIRST" | "SECOND" } | null>;
  /** All of THIS student's assignments in any status (the engine decides which count). */
  assignmentsForStudent(studentId: string): Promise<AssignmentRec[]>;
  getCourse(courseId: string, departmentId: string): Promise<CourseRec | null>;
  /** The department's ACTIVE courses of a level in a term (what a level appointment covers). */
  listCoursesForLevel(departmentId: string, level: string, academicSession: string, semester: "FIRST" | "SECOND"): Promise<CourseRec[]>;
  /** Active students of the level for the session (the class). */
  countLevelStudents(departmentId: string, level: string, academicSession: string): Promise<number>;

  listMembers(course: CourseRec, q: { page: number; limit: number; search?: string }): Promise<{ items: MemberRec[]; total: number }>;
  countMembers(course: CourseRec): Promise<number>;
  /** Names of the lecturers ASSIGNED to the course (never typed text). */
  lecturerNames(course: CourseRec): Promise<string[]>;
  /** All entries (any source / status) for the courses (view=course) or their levels (view=class). The engine filters drafts. */
  listTimetable(courses: CourseRec[], view: "course" | "class"): Promise<TimetableRec[]>;
  createTimetableEntry(rec: Omit<TimetableRec, "id" | "createdAt" | "updatedAt">): Promise<TimetableRec>;
  getTimetableEntry(id: string, departmentId: string): Promise<TimetableRec | null>;
  /** Only ever touches CLASS_REP entries. */
  updateTimetableEntry(id: string, patch: Partial<Pick<TimetableRec, "title" | "type" | "dayOfWeek" | "startTime" | "endTime" | "venue" | "lecturerName" | "status">> & { date?: string | null }): Promise<TimetableRec | null>;
  deleteTimetableEntry(id: string): Promise<void>;

  createAnnouncement(rec: Omit<AnnouncementRec, "id" | "createdAt" | "updatedAt">): Promise<AnnouncementRec>;
  getAnnouncement(id: string, departmentId: string): Promise<AnnouncementRec | null>;
  updateAnnouncement(id: string, patch: Partial<Pick<AnnouncementRec, "title" | "body" | "priority" | "status" | "expiresAt" | "publishedAt">> & { image?: AnnouncementImage | null }): Promise<AnnouncementRec | null>;
  /** Published items for the courses, plus the viewer's own drafts / unpublished items. Never DELETED. */
  /** Always inside ONE department: a class-wide announcement is matched on department + level + term, never on level alone. */
  listAnnouncements(departmentId: string, scope: AnnouncementViewScope, viewerStudentId: string): Promise<AnnouncementRec[]>;

  createResource(rec: Omit<ResourceRec, "id" | "createdAt" | "updatedAt">): Promise<ResourceRec>;
  getResource(id: string, departmentId: string): Promise<ResourceRec | null>;
  updateResource(id: string, patch: Partial<Pick<ResourceRec, "title" | "description" | "resourceType" | "status">>): Promise<ResourceRec | null>;
  deleteResource(id: string): Promise<void>;
  /** Everything visible for these courses: official materials and class resources. */
  listResources(courses: CourseRec[]): Promise<ResourceRec[]>;

  addAudit(rec: AuditRec): Promise<void>;
}
