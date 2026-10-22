import type { RepAssignmentStatus, RepRole, ResourceType, Semester } from "../../utils/constants";
import type { Priority } from "./policy";

export interface RepActor {
  studentId: string;
  departmentId: string;
  firstName: string;
  lastName?: string;
}
export interface AssignmentRec {
  id: string;
  studentId: string;
  departmentId: string;
  /** "LEVEL" for appointments (the whole level of the department); absent on legacy course-scoped records. */
  scope?: "LEVEL" | "COURSE";
  /** Legacy course-scoped records only. */
  courseId?: string;
  courseCode?: string;
  level: string;
  academicSession: string;
  semester: Semester;
  role: RepRole;
  status: RepAssignmentStatus;
  assignedBy: { name: string; role: string };
  assignedAt: Date;
  revokedAt?: Date;
}
export interface CourseRec {
  id: string;
  departmentId: string;
  courseCode: string;
  title: string;
  description?: string;
  units: number;
  level: string;
  semester: Semester;
  academicSession: string;
  status: "ACTIVE" | "ARCHIVED";
}
export interface MemberRec {
  studentId: string;
  firstName: string;
  lastName: string;
  matricNumber: string;
  profilePhoto?: string;
  level: string;
  enrollmentType: "REGULAR" | "CARRYOVER";
}
export interface TimetableRec {
  id: string;
  departmentId: string;
  courseId?: string;
  courseCode?: string;
  level: string;
  academicSession: string;
  semester: Semester;
  title: string;
  type: "LECTURE" | "PRACTICAL" | "TUTORIAL" | "OTHER";
  dayOfWeek: "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN";
  /** One-off date (YYYY-MM-DD); absent = weekly. */
  date?: string;
  startTime: string;
  endTime: string;
  venue?: string;
  lecturerName?: string;
  /** OFFICIAL = departmental timetable (protected). CLASS_REP = the class timetable a Course Rep manages. */
  source: "OFFICIAL" | "CLASS_REP";
  status: "DRAFT" | "PUBLISHED";
  createdByStudentId?: string;
  createdByRole?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
/** A stored announcement picture. `publicId` is only for deleting it and is never sent to clients. */
export interface AnnouncementImage { url: string; publicId?: string }
export type AnnouncementStatus = "DRAFT" | "PUBLISHED" | "UNPUBLISHED" | "DELETED";
export interface AnnouncementRec {
  id: string;
  departmentId: string;
  /** Set when the announcement targets one course; absent = the whole level (class). */
  courseId?: string;
  courseCode?: string;
  level: string;
  academicSession: string;
  semester: Semester;
  title: string;
  body: string;
  priority: Priority;
  status: AnnouncementStatus;
  createdByStudentId: string;
  createdByRole: string;
  createdByName: string;
  /** Optional picture attached by the author. */
  image?: AnnouncementImage;
  publishedAt?: Date;
  expiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface StoredFile {
  url: string;
  publicId?: string;
  resourceType?: "image" | "raw";
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}
export interface ResourceRec {
  id: string;
  departmentId: string;
  courseId?: string;
  courseCode?: string;
  level: string;
  academicSession: string;
  semester: Semester;
  title: string;
  description?: string;
  /** OFFICIAL_COURSE_MATERIAL is lecturer-controlled and read-only to representatives. */
  type: "OFFICIAL_COURSE_MATERIAL" | "CLASS_RESOURCE";
  resourceType?: ResourceType;
  file: StoredFile;
  createdByStudentId?: string;
  uploadedByName: string;
  uploadedByRole: string;
  status: "PUBLISHED" | "HIDDEN";
  createdAt: Date;
  updatedAt: Date;
}
export interface AuditRec {
  actorId: string;
  role?: string;
  action: string;
  resourceType?: "ANNOUNCEMENT" | "RESOURCE" | "ASSIGNMENT" | "COURSE";
  resourceId?: string;
  courseId?: string;
  courseCode?: string;
  departmentId: string;
  detail?: Record<string, unknown>;
  at: Date;
}
