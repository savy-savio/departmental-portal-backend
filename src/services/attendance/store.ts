import type {
  AttendanceRecordRec, ChallengeRec, CourseContext, DeviceRec, SecurityLogRec, SessionRec, VerificationRec,
} from "./types";

/** Thrown by a store when a unique constraint is hit (double-mark, second active device, ...). */
export class StoreDuplicateError extends Error {
  constructor(what: string) {
    super(`Duplicate: ${what}`);
    this.name = "StoreDuplicateError";
  }
}

/**
 * Everything the attendance security engine needs from storage. Uniqueness and atomicity guarantees
 * live in the store (MongoDB indexes / atomic updates in production), never only in engine code.
 */
export interface AttendanceStore {
  /** Department filter is part of the lookup: another department's session id simply doesn't exist. */
  findSession(sessionId: string, departmentId: string): Promise<SessionRec | null>;
  getCourseContext(studentId: string, departmentId: string): Promise<CourseContext>;

  findDeviceByHash(tokenHash: string): Promise<DeviceRec | null>;
  findActiveDeviceByStudent(studentId: string): Promise<DeviceRec | null>;
  /** Throws StoreDuplicateError if the student already has an ACTIVE device or the hash exists. */
  createDevice(rec: Omit<DeviceRec, "id">): Promise<DeviceRec>;
  /** Only revokes an ACTIVE device; returns whether it changed anything. */
  revokeDevice(deviceId: string, reason: "REPLACED" | "ADMIN_RESET", at: Date): Promise<boolean>;
  touchDevice(deviceId: string, at: Date, ip: string): Promise<void>;
  countDeviceReplacements(studentId: string, since: Date): Promise<number>;

  createChallenge(rec: Omit<ChallengeRec, "id">): Promise<void>;
  /** Atomic single-use: true only if an unused, unexpired challenge matches ALL of student, device, session and hash. */
  consumeChallenge(m: { tokenHash: string; studentId: string; deviceId: string; sessionId: string; now: Date }): Promise<boolean>;

  findRecord(sessionId: string, studentId: string): Promise<AttendanceRecordRec | null>;
  /** Throws StoreDuplicateError on a second mark for the same (session, student). */
  createRecord(rec: Omit<AttendanceRecordRec, "id">): Promise<AttendanceRecordRec>;

  /** Replaces any earlier pending verification for this student. */
  saveVerification(rec: Omit<VerificationRec, "id">): Promise<VerificationRec>;
  findVerification(studentId: string): Promise<VerificationRec | null>;
  bumpVerificationAttempts(id: string): Promise<void>;
  /** Atomic single-use. */
  consumeVerification(id: string, at: Date): Promise<boolean>;

  addLog(rec: SecurityLogRec): Promise<string>;
  flagLog(id: string, flags: string[]): Promise<void>;
  recentLogs(q: { studentId?: string; deviceFingerprint?: string; since: Date }): Promise<SecurityLogRec[]>;
}
