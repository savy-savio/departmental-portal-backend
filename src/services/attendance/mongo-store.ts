import { AcademicTerm } from "../../models/AcademicTerm";
import { AttendanceChallenge } from "../../models/AttendanceChallenge";
import { AttendanceRecord } from "../../models/AttendanceRecord";
import { AttendanceSecurityLog } from "../../models/AttendanceSecurityLog";
import { AttendanceSession } from "../../models/AttendanceSession";
import { CourseEnrollment } from "../../models/CourseEnrollment";
import { DeviceVerification } from "../../models/DeviceVerification";
import { StudentAttendanceDevice, StudentAttendanceDeviceDocument } from "../../models/StudentAttendanceDevice";
import { StoreDuplicateError, type AttendanceStore } from "./store";
import type {
  AttendanceRecordRec, CourseContext, DeviceRec, SecurityLogRec, SessionRec, VerificationRec,
} from "./types";

const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;
const id = (v: unknown) => String(v);

const toDevice = (d: StudentAttendanceDeviceDocument): DeviceRec => ({
  id: id(d._id), studentId: id(d.student), departmentId: id(d.department), tokenHash: d.tokenHash, label: d.label ?? undefined,
  userAgent: d.userAgent ?? undefined, status: d.status, registeredAt: d.registeredAt, lastUsedAt: d.lastUsedAt ?? undefined,
  lastIp: d.lastIp ?? undefined, revokedAt: d.revokedAt ?? undefined, revokedReason: d.revokedReason ?? undefined,
});

/** MongoDB implementation. Uniqueness comes from the indexes declared on the models; single-use from atomic updates. */
export class MongoAttendanceStore implements AttendanceStore {
  async findSession(sessionId: string, departmentId: string): Promise<SessionRec | null> {
    const s = await AttendanceSession.findOne({ _id: sessionId, department: departmentId }).select("+codeHash");
    if (!s) return null;
    const loc = s.location;
    // `radiusMeters` is the pre-rename field name; sessions created before the rename still carry it.
    const radius = loc?.allowedRadiusInMeters ?? loc?.radiusMeters;
    const hasLoc = loc?.latitude != null && loc?.longitude != null && radius != null;
    return {
      id: id(s._id), departmentId: id(s.department), courseCode: s.courseCode, level: s.level, academicSession: s.academicSession,
      semester: s.semester, title: s.title, opensAt: s.opensAt, closesAt: s.closesAt, lateAfterMinutes: s.lateAfterMinutes,
      codeHash: s.codeHash ?? undefined, status: s.status,
      location: hasLoc ? { latitude: loc!.latitude as number, longitude: loc!.longitude as number, allowedRadiusInMeters: radius as number, accuracyMeters: loc!.accuracyMeters ?? undefined } : undefined,
    };
  }

  async getCourseContext(studentId: string, departmentId: string): Promise<CourseContext> {
    const term = await AcademicTerm.findOne({ department: departmentId, isCurrent: true });
    if (!term) return { term: null, enrolledCodes: [] };
    const rows = await CourseEnrollment.find({
      student: studentId, department: departmentId, academicSession: term.academicSession, semester: term.semester, status: "ENROLLED",
    }).select("courseCode");
    return { term: { academicSession: term.academicSession, semester: term.semester }, enrolledCodes: rows.map((r) => r.courseCode) };
  }

  async findDeviceByHash(tokenHash: string) {
    const d = await StudentAttendanceDevice.findOne({ tokenHash });
    return d ? toDevice(d) : null;
  }
  async findActiveDeviceByStudent(studentId: string) {
    const d = await StudentAttendanceDevice.findOne({ student: studentId, status: "ACTIVE" });
    return d ? toDevice(d) : null;
  }
  async createDevice(rec: Omit<DeviceRec, "id">) {
    try {
      const d = await StudentAttendanceDevice.create({
        student: rec.studentId, department: rec.departmentId, tokenHash: rec.tokenHash, label: rec.label, userAgent: rec.userAgent,
        status: rec.status, registeredAt: rec.registeredAt,
      });
      return toDevice(d);
    } catch (e) {
      if (isDup(e)) throw new StoreDuplicateError("attendance device");
      throw e;
    }
  }
  async revokeDevice(deviceId: string, reason: "REPLACED" | "ADMIN_RESET", at: Date) {
    const r = await StudentAttendanceDevice.updateOne({ _id: deviceId, status: "ACTIVE" }, { $set: { status: "REVOKED", revokedReason: reason, revokedAt: at } });
    return r.modifiedCount === 1;
  }
  async touchDevice(deviceId: string, at: Date, ip: string) {
    await StudentAttendanceDevice.updateOne({ _id: deviceId }, { $set: { lastUsedAt: at, lastIp: ip } });
  }
  async countDeviceReplacements(studentId: string, since: Date) {
    return StudentAttendanceDevice.countDocuments({ student: studentId, revokedReason: "REPLACED", revokedAt: { $gte: since } });
  }

  async createChallenge(rec: { studentId: string; deviceId: string; sessionId: string; tokenHash: string; expiresAt: Date }) {
    await AttendanceChallenge.create({ student: rec.studentId, device: rec.deviceId, session: rec.sessionId, tokenHash: rec.tokenHash, expiresAt: rec.expiresAt });
  }
  async consumeChallenge(m: { tokenHash: string; studentId: string; deviceId: string; sessionId: string; now: Date }) {
    // One atomic statement: matches only an unused, unexpired challenge for exactly this student + device + session.
    const c = await AttendanceChallenge.findOneAndUpdate(
      { tokenHash: m.tokenHash, student: m.studentId, device: m.deviceId, session: m.sessionId, usedAt: { $exists: false }, expiresAt: { $gt: m.now } },
      { $set: { usedAt: m.now } },
    );
    return Boolean(c);
  }

  async findRecord(sessionId: string, studentId: string): Promise<AttendanceRecordRec | null> {
    const r = await AttendanceRecord.findOne({ session: sessionId, student: studentId });
    return r ? this.toRecord(r) : null;
  }
  async createRecord(rec: Omit<AttendanceRecordRec, "id">) {
    try {
      const r = await AttendanceRecord.create({
        session: rec.sessionId, student: rec.studentId, department: rec.departmentId, courseCode: rec.courseCode,
        markedAt: rec.markedAt, status: rec.status, device: rec.deviceId, ip: rec.ip, location: rec.location,
      });
      return this.toRecord(r);
    } catch (e) {
      if (isDup(e)) throw new StoreDuplicateError("attendance record"); // unique (session, student)
      throw e;
    }
  }
  private toRecord(r: InstanceType<typeof AttendanceRecord>): AttendanceRecordRec {
    return {
      id: id(r._id), sessionId: id(r.session), studentId: id(r.student), departmentId: id(r.department), courseCode: r.courseCode,
      markedAt: r.markedAt, status: r.status, deviceId: r.device ? id(r.device) : "", ip: r.ip ?? "",
    };
  }

  async saveVerification(rec: Omit<VerificationRec, "id">) {
    await DeviceVerification.deleteMany({ student: rec.studentId });
    const v = await DeviceVerification.create({
      student: rec.studentId, codeHash: rec.codeHash, purpose: rec.purpose, expiresAt: rec.expiresAt, attempts: 0, requestedIp: rec.requestedIp,
    });
    return { ...rec, id: id(v._id) };
  }
  async findVerification(studentId: string): Promise<VerificationRec | null> {
    const v = await DeviceVerification.findOne({ student: studentId }).sort({ createdAt: -1 });
    return v
      ? { id: id(v._id), studentId: id(v.student), codeHash: v.codeHash, purpose: v.purpose, expiresAt: v.expiresAt, attempts: v.attempts, usedAt: v.usedAt ?? undefined, requestedIp: v.requestedIp ?? undefined }
      : null;
  }
  async bumpVerificationAttempts(verificationId: string) {
    await DeviceVerification.updateOne({ _id: verificationId }, { $inc: { attempts: 1 } });
  }
  async consumeVerification(verificationId: string, at: Date) {
    const r = await DeviceVerification.updateOne({ _id: verificationId, usedAt: { $exists: false } }, { $set: { usedAt: at } });
    return r.modifiedCount === 1;
  }

  async addLog(rec: SecurityLogRec) {
    const l = await AttendanceSecurityLog.create({
      action: rec.action, outcome: rec.outcome, reason: rec.reason, student: rec.studentId, department: rec.departmentId,
      session: rec.sessionId, courseCode: rec.courseCode, device: rec.deviceId, deviceFingerprint: rec.deviceFingerprint,
      ip: rec.ip, userAgent: rec.userAgent, location: rec.location, flagged: rec.flagged, flags: rec.flags, at: rec.at,
    });
    return id(l._id);
  }
  async flagLog(logId: string, flags: string[]) {
    await AttendanceSecurityLog.updateOne({ _id: logId }, { $set: { flagged: true, flags } });
  }
  async recentLogs(q: { studentId?: string; deviceFingerprint?: string; since: Date }): Promise<SecurityLogRec[]> {
    const filter: Record<string, unknown> = { at: { $gte: q.since } };
    if (q.studentId) filter.student = q.studentId;
    if (q.deviceFingerprint) filter.deviceFingerprint = q.deviceFingerprint;
    const rows = await AttendanceSecurityLog.find(filter).sort({ at: -1 }).limit(200);
    return rows.map((l) => ({
      action: l.action as SecurityLogRec["action"], outcome: l.outcome, reason: l.reason as SecurityLogRec["reason"],
      studentId: id(l.student), departmentId: id(l.department), deviceFingerprint: l.deviceFingerprint ?? undefined,
      ip: l.ip, flagged: l.flagged, flags: l.flags, at: l.at,
    }));
  }
}
