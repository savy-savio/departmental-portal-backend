/** Every role the platform will eventually support. */
export const ROLES = [
  "SUPER_ADMIN",
  "HOD",
  "LECTURER",
  "COURSE_REP",
  "ASSISTANT_COURSE_REP",
  "STUDENT",
] as const;
export type Role = (typeof ROLES)[number];

/**
 * Roles a record in the Student collection may hold.
 * Course reps and assistant reps are students with elevated, class-scoped duties.
 */
export const STUDENT_ROLES = ["STUDENT", "COURSE_REP", "ASSISTANT_COURSE_REP"] as const;
export type StudentRole = (typeof STUDENT_ROLES)[number];

export const STUDENT_STATUSES = ["PENDING_ONBOARDING", "ACTIVE", "SUSPENDED"] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const LEVEL_REGEX = /^[1-9]\d{2}$/; // "100", "200", ... "500"
export const ACADEMIC_SESSION_REGEX = /^(\d{4})\/(\d{4})$/; // "2026/2027"

export const MAX_FAILED_LOGINS = 5;
export const LOGIN_LOCK_MINUTES = 15;

export const SEMESTERS = ["FIRST", "SECOND"] as const;
export type Semester = (typeof SEMESTERS)[number];

export const COURSE_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];

export const ENROLLMENT_TYPES = ["REGULAR", "CARRYOVER"] as const;
export type EnrollmentType = (typeof ENROLLMENT_TYPES)[number];

/** WITHDRAWN / COMPLETED are set by later academic processes (HOD / lecturer phases), not by students. */
export const ENROLLMENT_STATUSES = ["ENROLLED", "WITHDRAWN", "COMPLETED"] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export const DEFAULT_MAX_UNITS = 24;

export const DAYS_OF_WEEK = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];
export const TIMETABLE_TYPES = ["LECTURE", "PRACTICAL", "TUTORIAL", "OTHER"] as const;
export type TimetableType = (typeof TIMETABLE_TYPES)[number];
export const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const ANNOUNCEMENT_SCOPES = ["DEPARTMENT", "LEVEL", "CLASS", "COURSE", "GROUP"] as const;
export type AnnouncementScope = (typeof ANNOUNCEMENT_SCOPES)[number];
export const ANNOUNCEMENT_PRIORITIES = ["NORMAL", "IMPORTANT", "URGENT"] as const;
export const ANNOUNCEMENT_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED", "UNPUBLISHED", "DELETED"] as const;

export const MATERIAL_TYPES = ["OFFICIAL_COURSE_MATERIAL", "CLASS_RESOURCE"] as const;
export type MaterialType = (typeof MATERIAL_TYPES)[number];
export const MATERIAL_STATUSES = ["PUBLISHED", "HIDDEN"] as const;

export const ASSIGNMENT_STATUSES = ["DRAFT", "PUBLISHED", "CLOSED"] as const;
export const SUBMISSION_STATUSES = ["SUBMITTED", "GRADED"] as const;

export const ATTENDANCE_SESSION_STATUSES = ["ACTIVE", "CLOSED", "CANCELLED"] as const;
export const ATTENDANCE_RECORD_STATUSES = ["PRESENT", "LATE"] as const;
export const DEFAULT_LATE_AFTER_MINUTES = 15;

export const COMPLAINT_TYPES = ["COURSE", "HOD"] as const;
export type ComplaintType = (typeof COMPLAINT_TYPES)[number];
export const COMPLAINT_STATUSES = [
  "SUBMITTED", "PENDING", "UNDER_REVIEW", "ASSIGNED", "IN_PROGRESS", "RESOLVED", "REJECTED", "CLOSED",
] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];
/** Statuses in which the student may still edit or add attachments. */
export const COMPLAINT_EDITABLE_STATUSES: readonly ComplaintStatus[] = ["SUBMITTED", "PENDING"];
export const COMPLAINT_MAX_FILES = 3;
export const COMPLAINT_MAX_FILE_MB = 5;
export const COMPLAINT_ALLOWED_EXTENSIONS = ["pdf", "docx", "jpg", "jpeg", "png", "webp"] as const;

export const NOTIFICATION_KINDS = [
  "ANNOUNCEMENT", "MATERIAL", "TIMETABLE", "SUBMITTED", "STATUS_CHANGED", "ASSIGNED", "RESOLVED",
  "INFO_REQUESTED", "RESPONSE", "ASSIGNMENT", "ATTENDANCE", "SYSTEM",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const ELECTION_STATUSES = ["DRAFT", "PUBLISHED", "CANCELLED"] as const;
export const CANDIDATE_STATUSES = ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"] as const;
/** Who may vote: the whole department, chosen levels (classes), or an explicit group of students picked by the HOD. */
export const ELECTORATE_MODES = ["DEPARTMENT", "LEVELS", "GROUP"] as const;
export type ElectorateMode = (typeof ELECTORATE_MODES)[number];
export const MAX_ELECTION_GROUP_SIZE = 2000;

export const REP_ROLES = ["COURSE_REP", "ASSISTANT_COURSE_REP"] as const;
export type RepRole = (typeof REP_ROLES)[number];
export const REP_ASSIGNMENT_STATUSES = ["ACTIVE", "INACTIVE", "REVOKED"] as const;
export type RepAssignmentStatus = (typeof REP_ASSIGNMENT_STATUSES)[number];
/** What a class resource is (distinct from Material.type, which separates OFFICIAL_COURSE_MATERIAL from CLASS_RESOURCE). */
export const RESOURCE_TYPES = ["PAST_QUESTION", "CLASS_NOTES", "STUDY_MATERIAL", "HANDOUT", "CLASS_DOCUMENT", "OTHER"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export const REP_AUDIT_ACTIONS = [
  "ANNOUNCEMENT_CREATED", "ANNOUNCEMENT_UPDATED", "ANNOUNCEMENT_UNPUBLISHED", "ANNOUNCEMENT_DELETED",
  "RESOURCE_UPLOADED", "RESOURCE_UPDATED", "RESOURCE_DELETED",
  "TIMETABLE_CREATED", "TIMETABLE_UPDATED", "TIMETABLE_DELETED",
  "ASSIGNMENT_CREATED", "ASSIGNMENT_REVOKED", "ASSIGNMENT_STATUS_CHANGED", "ACCESS_DENIED",
] as const;

export const LECTURER_STATUSES = ["INVITED", "ACTIVE", "SUSPENDED"] as const;
export type LecturerStatus = (typeof LECTURER_STATUSES)[number];
export const LECTURER_ASSIGNMENT_STATUSES = ["ACTIVE", "INACTIVE", "REVOKED"] as const;
export type LecturerAssignmentStatus = (typeof LECTURER_ASSIGNMENT_STATUSES)[number];
export const NOTIFICATION_RECIPIENT_TYPES = ["STUDENT", "LECTURER", "HOD"] as const;
export const LECTURER_AUDIT_ACTIONS = [
  "ANNOUNCEMENT_CREATED", "ANNOUNCEMENT_UPDATED", "ANNOUNCEMENT_UNPUBLISHED", "ANNOUNCEMENT_DELETED",
  "MATERIAL_UPLOADED", "MATERIAL_UPDATED", "MATERIAL_DELETED",
  "ASSIGNMENT_CREATED", "ASSIGNMENT_UPDATED", "ASSIGNMENT_PUBLISHED", "ASSIGNMENT_UNPUBLISHED", "ASSIGNMENT_DELETED",
  "ATTENDANCE_SESSION_CREATED", "ATTENDANCE_SESSION_OPENED", "ATTENDANCE_SESSION_CLOSED",
  "COMPLAINT_RESPONDED", "COMPLAINT_STATUS_CHANGED",
  "PROFILE_UPDATED", "ACCOUNT_CREATED", "ACCOUNT_ACTIVATED", "LECTURER_ASSIGNED_TO_COURSE", "LECTURER_UNASSIGNED", "ACCESS_DENIED",
] as const;

export const HOD_STATUSES = ["INVITED", "ACTIVE", "SUSPENDED"] as const;
export const HOD_AUDIT_ACTIONS = [
  "LECTURER_CREATED", "LECTURER_INVITATION_REISSUED", "LECTURER_UPDATED", "LECTURER_STATUS_CHANGED", "LECTURER_ASSIGNED_TO_COURSE", "LECTURER_UNASSIGNED",
  "COURSE_CREATED", "COURSE_UPDATED", "COURSE_STATUS_CHANGED",
  "REPRESENTATIVE_APPOINTED", "REPRESENTATIVE_STATUS_CHANGED", "REPRESENTATIVE_REVOKED",
  "STUDENT_STATUS_CHANGED", "STUDENT_ACADEMIC_RECORD_UPDATED",
  "COMPLAINT_STATUS_CHANGED", "COMPLAINT_ASSIGNED", "COMPLAINT_RESPONDED", "COMPLAINT_RESOLVED",
  "ANNOUNCEMENT_CREATED", "ANNOUNCEMENT_UPDATED", "ANNOUNCEMENT_UNPUBLISHED", "ANNOUNCEMENT_DELETED",
  "DOCUMENT_CREATED", "DOCUMENT_UPDATED", "DOCUMENT_DELETED",
  "ELECTION_CREATED", "ELECTION_UPDATED", "ELECTION_PUBLISHED", "ELECTION_OPENED", "ELECTION_CLOSED", "ELECTION_CANCELLED", "ELECTION_DELETED", "ELECTION_RESULTS_PUBLISHED",
  "ELECTION_POSITION_CREATED", "ELECTION_POSITION_UPDATED", "ELECTION_POSITION_DELETED", "ELECTION_POSITIONS_REORDERED",
  "ELECTION_CANDIDATE_ADDED", "ELECTION_CANDIDATE_UPDATED", "ELECTION_CANDIDATE_APPROVED", "ELECTION_CANDIDATE_REJECTED", "ELECTION_CANDIDATE_REMOVED", "ELECTION_CANDIDATE_PHOTO_CHANGED",
  "DEPARTMENT_SETTINGS_CHANGED", "ACADEMIC_TERM_CHANGED", "REGISTRATION_SETTINGS_CHANGED",
  "HOD_ACCOUNT_CREATED", "HOD_ACCOUNT_ACTIVATED", "PROFILE_UPDATED", "ACCESS_DENIED", "SCOPE_VIOLATION",
] as const;
export const DEPARTMENT_DOCUMENT_STATUSES = ["PUBLISHED", "HIDDEN"] as const;
export const ATTENDANCE_ISSUE_THRESHOLD_PERCENT = 60;

/** Recipients of a notification: students, lecturers and (now) HODs share ONE notification collection. */
