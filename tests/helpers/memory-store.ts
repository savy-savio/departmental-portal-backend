import { randomUUID } from "node:crypto";
import { StoreDuplicateError, type AttendanceStore } from "../../src/services/attendance/store";
import type {
  AttendanceRecordRec, ChallengeRec, CourseContext, DeviceRec, SecurityLogRec, SessionRec, VerificationRec,
} from "../../src/services/attendance/types";

/** In-memory AttendanceStore that enforces the SAME uniqueness / atomicity rules as the MongoDB indexes. */
export class MemoryStore implements AttendanceStore {
  sessions: SessionRec[] = [];
  /** studentId -> context */
  courseCtx = new Map<string, CourseContext>();
  devices: DeviceRec[] = [];
  challenges: ChallengeRec[] = [];
  records: AttendanceRecordRec[] = [];
  verifications: VerificationRec[] = [];
  logs: SecurityLogRec[] = [];

  async findSession(id: string, departmentId: string) {
    return this.sessions.find((s) => s.id === id && s.departmentId === departmentId) ?? null;
  }
  async getCourseContext(studentId: string) {
    return this.courseCtx.get(studentId) ?? { term: null, enrolledCodes: [] };
  }

  async findDeviceByHash(h: string) {
    return this.devices.find((d) => d.tokenHash === h) ?? null;
  }
  async findActiveDeviceByStudent(studentId: string) {
    return this.devices.find((d) => d.studentId === studentId && d.status === "ACTIVE") ?? null;
  }
  async createDevice(rec: Omit<DeviceRec, "id">) {
    if (this.devices.some((d) => d.tokenHash === rec.tokenHash)) throw new StoreDuplicateError("tokenHash");
    if (rec.status === "ACTIVE" && this.devices.some((d) => d.studentId === rec.studentId && d.status === "ACTIVE")) {
      throw new StoreDuplicateError("one ACTIVE device per student");
    }
    const d = { ...rec, id: randomUUID() };
    this.devices.push(d);
    return d;
  }
  async revokeDevice(id: string, reason: "REPLACED" | "ADMIN_RESET", at: Date) {
    const d = this.devices.find((x) => x.id === id && x.status === "ACTIVE");
    if (!d) return false;
    Object.assign(d, { status: "REVOKED", revokedReason: reason, revokedAt: at });
    return true;
  }
  async touchDevice(id: string, at: Date, ip: string) {
    const d = this.devices.find((x) => x.id === id);
    if (d) Object.assign(d, { lastUsedAt: at, lastIp: ip });
  }
  async countDeviceReplacements(studentId: string, since: Date) {
    return this.devices.filter((d) => d.studentId === studentId && d.revokedReason === "REPLACED" && d.revokedAt! >= since).length;
  }

  async createChallenge(rec: Omit<ChallengeRec, "id">) {
    this.challenges.push({ ...rec, id: randomUUID() });
  }
  async consumeChallenge(m: { tokenHash: string; studentId: string; deviceId: string; sessionId: string; now: Date }) {
    const c = this.challenges.find(
      (x) => x.tokenHash === m.tokenHash && x.studentId === m.studentId && x.deviceId === m.deviceId &&
        x.sessionId === m.sessionId && !x.usedAt && x.expiresAt > m.now,
    );
    if (!c) return false;
    c.usedAt = m.now;
    return true;
  }

  async findRecord(sessionId: string, studentId: string) {
    return this.records.find((r) => r.sessionId === sessionId && r.studentId === studentId) ?? null;
  }
  async createRecord(rec: Omit<AttendanceRecordRec, "id">) {
    if (this.records.some((r) => r.sessionId === rec.sessionId && r.studentId === rec.studentId)) throw new StoreDuplicateError("record");
    const r = { ...rec, id: randomUUID() };
    this.records.push(r);
    return r;
  }

  async saveVerification(rec: Omit<VerificationRec, "id">) {
    this.verifications = this.verifications.filter((v) => v.studentId !== rec.studentId);
    const v = { ...rec, id: randomUUID() };
    this.verifications.push(v);
    return v;
  }
  async findVerification(studentId: string) {
    return this.verifications.find((v) => v.studentId === studentId) ?? null;
  }
  async bumpVerificationAttempts(id: string) {
    const v = this.verifications.find((x) => x.id === id);
    if (v) v.attempts += 1;
  }
  async consumeVerification(id: string, at: Date) {
    const v = this.verifications.find((x) => x.id === id && !x.usedAt);
    if (!v) return false;
    v.usedAt = at;
    return true;
  }

  async addLog(rec: SecurityLogRec) {
    const id = randomUUID();
    this.logs.push({ ...rec, id });
    return id;
  }
  async flagLog(id: string, flags: string[]) {
    const l = this.logs.find((x) => x.id === id);
    if (l) Object.assign(l, { flagged: true, flags });
  }
  async recentLogs(q: { studentId?: string; deviceFingerprint?: string; since: Date }) {
    return this.logs.filter(
      (l) => l.at >= q.since && (!q.studentId || l.studentId === q.studentId) && (!q.deviceFingerprint || l.deviceFingerprint === q.deviceFingerprint),
    );
  }
}
