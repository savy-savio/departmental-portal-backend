/** Plain-data records used by the attendance security engine. Storage-agnostic (Mongo in prod, memory in tests). */

export type RejectReason =
  | "SESSION_NOT_FOUND" | "NOT_ENROLLED" | "SESSION_NOT_OPEN" | "SESSION_CLOSED"
  | "DEVICE_NOT_REGISTERED" | "DEVICE_UNRECOGNISED" | "DEVICE_BOUND_TO_OTHER_STUDENT" | "DEVICE_REVOKED"
  | "ALREADY_MARKED" | "ATTENDANCE_TOKEN_INVALID"
  | "LOCATION_REQUIRED" | "LOCATION_OUTSIDE_RADIUS" | "LOCATION_ACCURACY_LOW" | "SESSION_LOCATION_NOT_CONFIGURED"
  | "CODE_REQUIRED" | "CODE_INCORRECT"
  | "PASSWORD_INCORRECT" | "NO_EMAIL_ON_FILE" | "ALREADY_REGISTERED_DEVICE" | "DEVICE_CHANGE_LIMIT_REACHED"
  | "VERIFICATION_NOT_FOUND" | "VERIFICATION_EXPIRED" | "VERIFICATION_LOCKED" | "VERIFICATION_CODE_INCORRECT"
  | "DEVICE_ALREADY_REGISTERED";

export type SecurityAction =
  | "CHALLENGE" | "MARK" | "DEVICE_VERIFY_REQUEST" | "DEVICE_REGISTER" | "DEVICE_REPLACE";

export interface Actor {
  studentId: string;
  departmentId: string;
  firstName: string;
  email?: string;
}
export interface RequestMeta {
  /** Recorded for audit / suspicious-activity detection only. NEVER used as identity. */
  ip: string;
  userAgent?: string;
}

export interface DeviceRec {
  id: string;
  studentId: string;
  departmentId: string;
  tokenHash: string;
  label?: string;
  userAgent?: string;
  status: "ACTIVE" | "REVOKED";
  registeredAt: Date;
  lastUsedAt?: Date;
  lastIp?: string;
  revokedAt?: Date;
  revokedReason?: "REPLACED" | "ADMIN_RESET";
}

export interface SessionRec {
  id: string;
  departmentId: string;
  courseCode: string;
  level: string;
  academicSession: string;
  semester: "FIRST" | "SECOND";
  title: string;
  opensAt: Date;
  closesAt: Date;
  lateAfterMinutes: number;
  codeHash?: string;
  status: "ACTIVE" | "CLOSED" | "CANCELLED";
  /** Required for attendance to be markable. A session without it is rejected (fail closed). */
  location?: { latitude: number; longitude: number; allowedRadiusInMeters: number; /** Accuracy of the lecturer's reading of the venue (metres), when known. */ accuracyMeters?: number };
}

export interface CourseContext {
  term: { academicSession: string; semester: "FIRST" | "SECOND" } | null;
  enrolledCodes: string[];
}

export interface ChallengeRec {
  id: string;
  studentId: string;
  deviceId: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date;
}

export interface AttendanceRecordRec {
  id: string;
  sessionId: string;
  studentId: string;
  departmentId: string;
  courseCode: string;
  markedAt: Date;
  status: "PRESENT" | "LATE";
  deviceId: string;
  ip: string;
  location?: { latitude: number; longitude: number; accuracyMeters?: number; distanceMeters: number };
}

export interface VerificationRec {
  id: string;
  studentId: string;
  codeHash: string;
  purpose: "REGISTER" | "REPLACE";
  expiresAt: Date;
  attempts: number;
  usedAt?: Date;
  requestedIp?: string;
}

export interface SecurityLogRec {
  id?: string;
  action: SecurityAction;
  outcome: "SUCCESS" | "REJECTED";
  reason?: RejectReason;
  studentId: string;
  departmentId: string;
  sessionId?: string;
  courseCode?: string;
  deviceId?: string;
  /** First 16 hex chars of the presented device-token hash: lets us correlate a device across accounts without storing the token. */
  deviceFingerprint?: string;
  ip: string;
  userAgent?: string;
  location?: { latitude?: number; longitude?: number; accuracyMeters?: number; distanceMeters?: number; withinRadius?: boolean };
  flagged: boolean;
  flags: string[];
  at: Date;
}
