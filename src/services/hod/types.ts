import type { Semester } from "../../utils/constants";
import type { AttendanceRecordView, LecturerAssignmentRec, LecturerSessionRec } from "../lecturer/types";
import type { AssignmentRec, CourseRec, StoredFile, TimetableRec } from "../representative/types";
import type { ComplaintStatusName } from "./policy";

export type { AttendanceRecordView, CourseRec, LecturerAssignmentRec, LecturerSessionRec, StoredFile, TimetableRec, AssignmentRec as RepAssignmentRec };

/** Derived from the HOD's JWT + their own record. Never from the request. */
export interface HodActor { hodId: string; departmentId: string; firstName: string; lastName: string }
export interface HodMeta { ip?: string }

export interface HodRec {
  id: string; firstName: string; lastName: string; email: string; phone?: string; staffId: string; departmentId: string; role: "HOD";
  profilePhoto?: string; profilePhotoPublicId?: string; status: "INVITED" | "ACTIVE" | "SUSPENDED"; createdAt?: Date; updatedAt?: Date;
}
export interface DeptRec {
  id: string; name: string; code: string; faculty: string; isActive: boolean; levels: string[];
  contact?: { email?: string; phone?: string; office?: string };
}
export interface TermRec {
  academicSession: string; semester: Semester; registrationOpen: boolean; registrationOpensAt?: Date; registrationClosesAt?: Date; maxUnits: number;
}

/** Generic pagination / sorting input. `sort` is validated against a per-list whitelist before it reaches the store. */
export interface ListQuery { page: number; limit: number; search?: string; sort?: string; order?: "asc" | "desc" }
export interface Page<T> { items: T[]; total: number }

export interface StudentRow {
  id: string; firstName: string; lastName: string; matricNumber: string; email?: string; phone?: string; level: string; academicSession: string;
  status: "PENDING_ONBOARDING" | "ACTIVE" | "SUSPENDED"; onboardingCompleted: boolean; profilePhoto?: string; createdAt?: Date;
}
export interface StudentFilter extends ListQuery { level?: string; academicSession?: string; status?: string }
export interface EnrollmentView { id: string; courseId?: string; courseCode: string; title: string; units: number; level: string; semester: Semester; academicSession: string; enrollmentType: "REGULAR" | "CARRYOVER"; status: string }
export interface StudentAttendanceRow { courseCode: string; sessionsHeld: number; attended: number; late: number }

export interface LecturerRow {
  id: string; firstName: string; lastName: string; email: string; phone?: string; staffId: string; status: "INVITED" | "ACTIVE" | "SUSPENDED"; profilePhoto?: string; createdAt?: Date;
}
export interface LecturerFilter extends ListQuery { status?: string }
export interface LecturerAssignmentView extends LecturerAssignmentRec { courseTitle?: string }

export interface CourseView extends CourseRec { enrolledCount: number; lecturers?: { lecturerId: string; name: string }[] }
export interface CourseFilter extends ListQuery { level?: string; semester?: Semester; academicSession?: string; status?: string }

export interface RepAssignmentView extends AssignmentRec { student: { firstName: string; lastName: string; matricNumber: string }; courseTitle?: string }
export interface RepFilter extends ListQuery { courseId?: string; level?: string; academicSession?: string; semester?: Semester; role?: string; status?: string }

export interface TimetableFilter extends ListQuery { courseId?: string; level?: string; day?: string; source?: string }

/** Any department announcement: written by the HOD (DEPARTMENT / LEVEL scope), a lecturer or a rep (COURSE scope). Only HOD-written ones are editable by the HOD. */
export interface HodAnnouncementRec {
  id: string; departmentId: string; title: string; body: string; priority: "NORMAL" | "IMPORTANT" | "URGENT";
  status: "DRAFT" | "PUBLISHED" | "UNPUBLISHED" | "ARCHIVED" | "DELETED";
  scope: "DEPARTMENT" | "LEVEL" | "COURSE" | "CLASS" | "GROUP"; levels?: string[]; courseCode?: string;
  hodId?: string; lecturerId?: string; studentId?: string; authorName: string; authorRole: string;
  /** Optional picture. `publicId` is only for deleting it from storage. */
  image?: { url: string; publicId?: string };
  publishedAt?: Date; expiresAt?: Date | null; createdAt: Date; updatedAt: Date;
}
export interface AnnouncementFilter extends ListQuery { status?: string; scope?: string; mine?: boolean }

export interface DocumentRec {
  id: string; departmentId: string; title: string; description?: string; levels: string[]; file: StoredFile; status: "PUBLISHED" | "HIDDEN";
  hodId: string; authorName: string; createdAt: Date; updatedAt: Date;
}
export interface MaterialOverview {
  id: string; courseCode?: string; title: string; type: "OFFICIAL_COURSE_MATERIAL" | "CLASS_RESOURCE"; ownerName: string; ownerRole: string; status: string; createdAt: Date;
}

export interface SessionFilter extends ListQuery { courseId?: string; lecturerId?: string; state?: "UPCOMING" | "OPEN" | "CLOSED"; from?: Date; to?: Date }
export interface SessionView extends LecturerSessionRec { lecturerName?: string }

export interface ComplaintEvent { id?: string; status: ComplaintStatusName; label: string; note?: string; at: Date; byRole?: string; byId?: string; byName?: string; internal?: boolean }
export interface ComplaintRec {
  id: string; referenceNumber: string; departmentId: string; studentId: string; studentName: string; matricNumber: string; type: "COURSE" | "HOD";
  title: string; message: string; courseId?: string; courseCode?: string; courseTitle?: string; status: ComplaintStatusName;
  assignedLecturer?: { id: string; name: string }; assignedAt?: Date; resolution?: string; resolvedAt?: Date;
  attachments: { id: string; name: string; mimeType: string; sizeBytes: number; publicId: string; resourceType: "image" | "raw" }[];
  timeline: ComplaintEvent[]; createdAt: Date; updatedAt: Date;
}
export interface ComplaintFilter extends ListQuery { status?: string; type?: string; courseId?: string; assignedLecturerId?: string; from?: Date; to?: Date }
export interface ComplaintPatch { status?: ComplaintStatusName; assignedLecturerId?: string; assignedAt?: Date; resolution?: string; resolvedAt?: Date; reviewedByHodId?: string }

export interface NotificationView { id: string; kind: string; title: string; body: string; link?: string; read: boolean; createdAt: Date }
export interface HodAuditRec {
  actorId?: string; actorName?: string; role: string; action: string; resourceType?: string; resourceId?: string; departmentId: string; ip?: string; detail?: Record<string, unknown>; at: Date;
}
export interface ActivityItem { source: "HOD" | "LECTURER" | "REPRESENTATIVE"; action: string; actorName?: string; role?: string; resourceType?: string; courseCode?: string; at: Date }
export interface DashboardCounts {
  students: { total: number; active: number; pendingOnboarding: number; suspended: number };
  lecturers: { total: number; active: number };
  representatives: { courseReps: number; assistantCourseReps: number };
  activeCourses: number; activeAnnouncements: number; openAttendanceSessions: number;
  complaints: { pending: number; underReview: number };
}
export interface CourseAttendanceStat { courseId: string; courseCode: string; title: string; sessionsHeld: number; enrolled: number; attendanceRecords: number }
