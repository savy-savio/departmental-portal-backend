import { AttendanceSecurityService, type AttendanceSecurityConfig } from "../../src/services/attendance/attendance-security.service";
import type { Actor, RequestMeta, SessionRec } from "../../src/services/attendance/types";
import { MemoryStore } from "./memory-store";

export const CAMPUS = { latitude: 6.5244, longitude: 3.3792 };
/** ~0.0009 degrees of latitude is roughly 100 m. */
export const NEAR = { latitude: CAMPUS.latitude + 0.0003, longitude: CAMPUS.longitude };
export const FAR = { latitude: CAMPUS.latitude + 0.02, longitude: CAMPUS.longitude }; // ~2.2 km away

export const CSC = "dept-csc";
export const MLS = "dept-mls";
export const T0 = new Date("2026-10-10T10:00:00Z");

export const config: AttendanceSecurityConfig = {
  challengeTtlSeconds: 90, verificationTtlMinutes: 10, maxVerificationAttempts: 5,
  maxDeviceChangesPer30Days: 2, maxAccuracyMeters: 100, hmacKey: "test-hmac-key-that-is-long-enough-1234567890",
};

export const actor = (id: string, departmentId = CSC): Actor => ({ studentId: id, departmentId, firstName: id, email: `${id}@example.com` });
export const meta = (ip = "41.58.0.10"): RequestMeta => ({ ip, userAgent: "jest-phone" });

export function makeWorld() {
  const store = new MemoryStore();
  const clock = { now: new Date(T0) };
  const passwords = new Map<string, string>([["alice", "pw-alice"], ["bob", "pw-bob"], ["mia", "pw-mia"]]);
  const sentCodes: { studentId: string; code: string; purpose: string }[] = [];

  const svc = new AttendanceSecurityService({
    store, config, now: () => new Date(clock.now),
    verifyPassword: async (id, pw) => passwords.get(id) === pw,
    sendVerificationCode: async (a, code, purpose) => void sentCodes.push({ studentId: a.studentId, code, purpose }),
  });

  const makeSession = (over: Partial<SessionRec> = {}): SessionRec => {
    const s: SessionRec = {
      id: `ses-${store.sessions.length + 1}`, departmentId: CSC, courseCode: "CSC201", level: "200",
      academicSession: "2026/2027", semester: "FIRST", title: "CSC201 lecture",
      opensAt: new Date("2026-10-10T09:55:00Z"), closesAt: new Date("2026-10-10T12:00:00Z"), lateAfterMinutes: 15,
      status: "ACTIVE", location: { ...CAMPUS, allowedRadiusInMeters: 100 }, ...over,
    };
    store.sessions.push(s);
    return s;
  };

  const enroll = (studentId: string, departmentId: string, codes: string[]) =>
    store.courseCtx.set(studentId, { term: { academicSession: "2026/2027", semester: "FIRST" }, enrolledCodes: codes });

  /** Full legitimate device onboarding: password + emailed code -> raw device token. */
  async function registerDevice(studentId: string, departmentId = CSC, current?: string, ip = "41.58.0.10") {
    await svc.requestDeviceVerification(actor(studentId, departmentId), meta(ip), passwords.get(studentId)!, current);
    const code = sentCodes[sentCodes.length - 1].code;
    return svc.completeDeviceRegistration(actor(studentId, departmentId), meta(ip), { code, label: "My phone" }, current);
  }

  /** challenge -> mark, as the real client does. */
  async function attend(studentId: string, sessionId: string, deviceToken: string | undefined, where = NEAR, ip = "41.58.0.10", departmentId = CSC) {
    const ch = await svc.createChallenge(actor(studentId, departmentId), meta(ip), sessionId, deviceToken);
    return svc.markAttendance(actor(studentId, departmentId), meta(ip), sessionId, deviceToken, { attendanceToken: ch.attendanceToken, ...where });
  }

  return { store, clock, svc, makeSession, enroll, registerDevice, attend, sentCodes, passwords };
}

export async function rejection(p: Promise<unknown>): Promise<{ status: number; code?: string; message: string; details?: unknown }> {
  try {
    await p;
  } catch (e) {
    const err = e as { statusCode?: number; code?: string; message: string; details?: unknown };
    return { status: err.statusCode ?? 0, code: err.code, message: err.message, details: err.details };
  }
  throw new Error("Expected the call to be rejected, but it succeeded");
}
