import type { LecturerAssignmentStatus, LecturerStatus, Semester } from "../../utils/constants";
import type { SessionRec } from "../attendance/types";
import type { CourseRec, MemberRec, StoredFile, TimetableRec } from "../representative/types";
import type { ComplaintEvent, ComplaintRec } from "../hod/types";

export type { CourseRec, MemberRec, StoredFile, TimetableRec };
/** The SAME complaint record the HOD and students use (one collection, one shape). A lecturer only ever receives the ones assigned to them. */
export type LecturerComplaintRec = ComplaintRec;
export type LecturerComplaintEvent = ComplaintEvent;
export interface LecturerComplaintQuery { page: number; limit: number; search?: string; status?: string; courseId?: string; from?: Date; to?: Date; sort?: string; order?: "asc" | "desc" }

/** Derived from the lecturer's JWT + their own record. Never from the request. */
export interface LecturerActor {
  lecturerId: string;
  departmentId: string;
  firstName: string;
  lastName: string;
}
/** Recorded in the audit trail (IP is an audit signal only). */
export interface LecturerMeta {
  ip?: string;
}

export interface LecturerRec {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  staffId: string;
  departmentId: string;
  role: "LECTURER";
  profilePhoto?: string;
  /** Internal (used to delete the old image); never returned by the API. */
  profilePhotoPublicId?: string;
  status: LecturerStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface LecturerAssignmentRec {
  id: string;
  lecturerId: string;
  departmentId: string;
  courseId: string;
  courseCode: string;
  level: string;
  academicSession: string;
  semester: Semester;
  status: LecturerAssignmentStatus;
  assignedBy: { name: string; role: string };
  assignedAt: Date;
}

export type AnnouncementStatus = "DRAFT" | "PUBLISHED" | "UNPUBLISHED" | "DELETED";
export interface AnnouncementRec {
  id: string;
  departmentId: string;
  courseId: string;
  courseCode: string;
  level: string;
  academicSession: string;
  semester: Semester;
  /** Optional picture. `publicId` is only for deleting it from storage. */
  image?: { url: string; publicId?: string };
  title: string;
  body: string;
  priority: "NORMAL" | "IMPORTANT" | "URGENT";
  status: AnnouncementStatus;
  /** Exactly one of these is set: who wrote it. A lecturer can only change her own, a rep only theirs. */
  lecturerId?: string;
  studentId?: string;
  authorName: string;
  authorRole: string;
  publishedAt?: Date;
  expiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MaterialRec {
  id: string;
  departmentId: string;
  courseId?: string;
  courseCode: string;
  level: string;
  academicSession: string;
  semester: Semester;
  title: string;
  description?: string;
  type: "OFFICIAL_COURSE_MATERIAL" | "CLASS_RESOURCE";
  file: StoredFile;
  lecturerId?: string;
  studentId?: string;
  uploadedByName: string;
  uploadedByRole: string;
  status: "PUBLISHED" | "HIDDEN";
  createdAt: Date;
  updatedAt: Date;
}

export type CourseWorkStatus = "DRAFT" | "PUBLISHED" | "CLOSED";
export interface CourseWorkRec {
  id: string;
  departmentId: string;
  courseId: string;
  courseCode: string;
  level: string;
  academicSession: string;
  semester: Semester;
  title: string;
  description: string;
  dueAt: Date;
  allowLateSubmission: boolean;
  attachment?: StoredFile;
  status: CourseWorkStatus;
  lecturerId?: string;
  authorName: string;
  createdAt: Date;
  updatedAt: Date;
}

/** What a lecturer may see of a submission: no grading data exists in this phase. */
export interface SubmissionView {
  id: string;
  assignmentId: string;
  studentId: string;
  firstName: string;
  lastName: string;
  matricNumber: string;
  submittedAt: Date;
  isLate: boolean;
  content?: string;
  file?: { name: string; mimeType: string; sizeBytes: number; publicId: string; resourceType: "image" | "raw" };
}

export interface LecturerSessionRec extends SessionRec {
  courseId: string;
  lecturerId: string;
  createdAt: Date;
}
export interface AttendanceRecordView {
  sessionId: string;
  studentId: string;
  firstName: string;
  lastName: string;
  matricNumber: string;
  status: "PRESENT" | "LATE";
  markedAt: Date;
  distanceMeters?: number;
}

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string;
  link?: string;
  read: boolean;
  createdAt: Date;
}

export interface LecturerAuditRec {
  actorId?: string;
  actorName?: string;
  role: string;
  action: string;
  resourceType?: "ANNOUNCEMENT" | "MATERIAL" | "ASSIGNMENT" | "ATTENDANCE_SESSION" | "COURSE" | "LECTURER" | "COMPLAINT";
  resourceId?: string;
  courseId?: string;
  courseCode?: string;
  departmentId: string;
  ip?: string;
  detail?: Record<string, unknown>;
  at: Date;
}
