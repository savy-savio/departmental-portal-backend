import { AppError } from "../../utils/AppError";
import {
  DEVICE_TOKEN_REGEX, generateDeviceToken, generateOtp, hashAttendanceCode, hmacSha256, safeEqual, sha256,
} from "../../utils/crypto";
import { distanceMeters, evaluateProximity, isValidLatitude, isValidLongitude } from "./geo";
import { StoreDuplicateError, type AttendanceStore } from "./store";
import { detectSuspicion, SUSPICION } from "./suspicion";
import type {
  Actor, DeviceRec, RejectReason, RequestMeta, SecurityAction, SecurityLogRec, SessionRec,
} from "./types";

export interface AttendanceSecurityConfig {
  challengeTtlSeconds: number;
  verificationTtlMinutes: number;
  maxVerificationAttempts: number;
  maxDeviceChangesPer30Days: number;
  maxAccuracyMeters: number;
  /** Most the radius may be widened by GPS uncertainty (student + venue accuracy combined), in metres. Absent / 0 = strict radius. */
  accuracyAllowanceMaxMeters?: number;
  /** Tell a rejected student roughly how far away they appeared to be (helps them fix it; rounded to 10 m). Default true. */
  showDistance?: boolean;
  /** Server secret used to HMAC one-time codes. */
  hmacKey: string;
}

export interface AttendanceDeps {
  store: AttendanceStore;
  config: AttendanceSecurityConfig;
  now: () => Date;
  /** Verifies the student's CURRENT account password (step-up before touching the attendance device). */
  verifyPassword: (studentId: string, password: string) => Promise<boolean>;
  sendVerificationCode: (actor: Actor, code: string, purpose: "REGISTER" | "REPLACE") => Promise<void>;
}

export interface MarkInput {
  attendanceToken: string;
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  code?: string;
}

interface Ctx {
  action: SecurityAction;
  actor: Actor;
  meta: RequestMeta;
  sessionId?: string;
  courseCode?: string;
  deviceId?: string;
  fingerprint?: string;
  location?: SecurityLogRec["location"];
}

const MSG = {
  boundToOther: "Attendance cannot be marked from this device because it is registered to another student.",
} as const;
const DAY_MS = 86_400_000;

const fingerprintOf = (tokenHash: string) => tokenHash.slice(0, 16);

/**
 * The attendance security engine. It combines independent signals (authenticated student, bound device,
 * session window, enrollment, server-computed location, single-use token, DB-level one-mark-per-session)
 * and writes an audit record for every attempt.
 *
 * LIMITATION: a bound device raises the cost of account sharing; it does not prove who is holding the phone.
 */
export class AttendanceSecurityService {
  constructor(private readonly d: AttendanceDeps) {}

  /* ------------------------------------------------------------------ */
  /* logging + rejection helpers                                         */
  /* ------------------------------------------------------------------ */
  private async log(ctx: Ctx, outcome: "SUCCESS" | "REJECTED", reason?: RejectReason): Promise<void> {
    const rec: SecurityLogRec = {
      action: ctx.action, outcome, reason,
      studentId: ctx.actor.studentId, departmentId: ctx.actor.departmentId,
      sessionId: ctx.sessionId, courseCode: ctx.courseCode, deviceId: ctx.deviceId, deviceFingerprint: ctx.fingerprint,
      ip: ctx.meta.ip, userAgent: ctx.meta.userAgent?.slice(0, 300), location: ctx.location,
      flagged: false, flags: [], at: this.d.now(),
    };
    try {
      if (outcome === "REJECTED") {
        const now = this.d.now();
        const [own, sameDevice] = await Promise.all([
          this.d.store.recentLogs({ studentId: ctx.actor.studentId, since: new Date(now.getTime() - SUSPICION.burstWindowMs) }),
          ctx.fingerprint
            ? this.d.store.recentLogs({ deviceFingerprint: ctx.fingerprint, since: new Date(now.getTime() - SUSPICION.deviceWindowMs) })
            : Promise.resolve([] as SecurityLogRec[]),
        ]);
        const flags = detectSuspicion(rec, [...own, ...sameDevice], now);
        if (flags.length) Object.assign(rec, { flagged: true, flags });
      }
      await this.d.store.addLog(rec);
    } catch {
      // Auditing must never turn a correct decision into a 500; infrastructure logs cover store failures.
    }
  }

  private async fail(ctx: Ctx, reason: RejectReason, status: number, message: string, details?: unknown): Promise<never> {
    await this.log(ctx, "REJECTED", reason);
    throw new AppError(status, message, details, reason);
  }

  /** Resolve an `X-Attendance-Device` value to a device record (never trusting any client-supplied id). */
  private async resolveDevice(presented: string | undefined): Promise<{ device: DeviceRec | null; fingerprint?: string }> {
    if (!presented || !DEVICE_TOKEN_REGEX.test(presented)) return { device: null };
    const hash = sha256(presented);
    return { device: await this.d.store.findDeviceByHash(hash), fingerprint: fingerprintOf(hash) };
  }

  /* ------------------------------------------------------------------ */
  /* device status                                                       */
  /* ------------------------------------------------------------------ */
  async getDeviceStatus(actor: Actor, presented?: string) {
    const [active, { device }] = await Promise.all([this.d.store.findActiveDeviceByStudent(actor.studentId), this.resolveDevice(presented)]);
    const since = new Date(this.d.now().getTime() - 30 * DAY_MS);
    const used = await this.d.store.countDeviceReplacements(actor.studentId, since);
    return {
      registered: Boolean(active),
      device: active ? { id: active.id, label: active.label ?? null, registeredAt: active.registeredAt, lastUsedAt: active.lastUsedAt ?? null } : null,
      thisDeviceIsRegistered: Boolean(active && device && device.id === active.id),
      thisDeviceBelongsToAnotherStudent: Boolean(device && device.status === "ACTIVE" && device.studentId !== actor.studentId),
      deviceChangesRemaining: Math.max(0, this.d.config.maxDeviceChangesPer30Days - used),
    };
  }

  /* ------------------------------------------------------------------ */
  /* device registration / replacement (password + emailed code)         */
  /* ------------------------------------------------------------------ */
  private async assertDeviceNotOwnedByAnother(ctx: Ctx, presented: string | undefined) {
    const { device, fingerprint } = await this.resolveDevice(presented);
    ctx.fingerprint = fingerprint;
    if (device && device.status === "ACTIVE" && device.studentId !== ctx.actor.studentId) {
      ctx.deviceId = device.id;
      await this.fail(ctx, "DEVICE_BOUND_TO_OTHER_STUDENT", 403, MSG.boundToOther);
    }
    return device;
  }

  private async assertChangeAllowed(ctx: Ctx) {
    const since = new Date(this.d.now().getTime() - 30 * DAY_MS);
    const used = await this.d.store.countDeviceReplacements(ctx.actor.studentId, since);
    if (used >= this.d.config.maxDeviceChangesPer30Days) {
      await this.fail(ctx, "DEVICE_CHANGE_LIMIT_REACHED", 403, "You have changed your attendance device too many times recently. Please contact your department.");
    }
  }

  /** Step 1: prove it's really the account owner (password) and email them a one-time code. */
  async requestDeviceVerification(actor: Actor, meta: RequestMeta, password: string, presented?: string) {
    const ctx: Ctx = { action: "DEVICE_VERIFY_REQUEST", actor, meta };
    const current = await this.assertDeviceNotOwnedByAnother(ctx, presented);

    if (!(await this.d.verifyPassword(actor.studentId, password))) {
      await this.fail(ctx, "PASSWORD_INCORRECT", 403, "Your password is incorrect.");
    }
    if (!actor.email) await this.fail(ctx, "NO_EMAIL_ON_FILE", 409, "No email address is on file for your account.");

    const active = await this.d.store.findActiveDeviceByStudent(actor.studentId);
    if (active && current && current.id === active.id) {
      await this.fail(ctx, "ALREADY_REGISTERED_DEVICE", 409, "This device is already your registered attendance device.");
    }
    const purpose = active ? "REPLACE" : "REGISTER";
    if (purpose === "REPLACE") await this.assertChangeAllowed(ctx);

    const code = generateOtp();
    const now = this.d.now();
    await this.d.store.saveVerification({
      studentId: actor.studentId,
      codeHash: hmacSha256(this.d.config.hmacKey, `${actor.studentId}:${code}`),
      purpose,
      expiresAt: new Date(now.getTime() + this.d.config.verificationTtlMinutes * 60_000),
      attempts: 0,
      requestedIp: meta.ip,
    });
    await this.d.sendVerificationCode(actor, code, purpose);
    await this.log(ctx, "SUCCESS");
    return { purpose, expiresInMinutes: this.d.config.verificationTtlMinutes };
  }

  /** Step 2: redeem the code. Registers the first device, or replaces (revokes) the old one. */
  async completeDeviceRegistration(actor: Actor, meta: RequestMeta, input: { code: string; label?: string }, presented?: string) {
    const ctx: Ctx = { action: "DEVICE_REGISTER", actor, meta };
    await this.assertDeviceNotOwnedByAnother(ctx, presented);
    const now = this.d.now();

    const ver = await this.d.store.findVerification(actor.studentId);
    if (!ver || ver.usedAt) await this.fail(ctx, "VERIFICATION_NOT_FOUND", 400, "Request a new verification code first.");
    const v = ver!;
    if (v.expiresAt <= now) await this.fail(ctx, "VERIFICATION_EXPIRED", 400, "That code has expired. Request a new one.");
    if (v.attempts >= this.d.config.maxVerificationAttempts) {
      await this.fail(ctx, "VERIFICATION_LOCKED", 429, "Too many incorrect codes. Request a new one.");
    }
    const expected = hmacSha256(this.d.config.hmacKey, `${actor.studentId}:${input.code.trim()}`);
    if (!safeEqual(expected, v.codeHash)) {
      await this.d.store.bumpVerificationAttempts(v.id);
      await this.fail(ctx, "VERIFICATION_CODE_INCORRECT", 400, "That code is incorrect.");
    }
    // Single-use, atomically: two parallel submissions of the same code can't both succeed.
    if (!(await this.d.store.consumeVerification(v.id, now))) {
      await this.fail(ctx, "VERIFICATION_NOT_FOUND", 400, "That code has already been used.");
    }

    const active = await this.d.store.findActiveDeviceByStudent(actor.studentId);
    if (active) {
      ctx.action = "DEVICE_REPLACE";
      await this.assertChangeAllowed(ctx);
      await this.d.store.revokeDevice(active.id, "REPLACED", now);
    }

    const rawToken = generateDeviceToken();
    const tokenHash = sha256(rawToken);
    let created: DeviceRec;
    try {
      created = await this.d.store.createDevice({
        studentId: actor.studentId, departmentId: actor.departmentId, tokenHash,
        label: input.label?.trim().slice(0, 60), userAgent: meta.userAgent?.slice(0, 300),
        status: "ACTIVE", registeredAt: now,
      });
    } catch (err) {
      if (err instanceof StoreDuplicateError) await this.fail(ctx, "DEVICE_ALREADY_REGISTERED", 409, "A device is already registered for your account.");
      throw err;
    }
    ctx.deviceId = created.id;
    ctx.fingerprint = fingerprintOf(tokenHash);
    await this.log(ctx, "SUCCESS");
    // The raw token is returned exactly once and never stored; the client must keep it (see README).
    return {
      deviceToken: rawToken,
      replaced: Boolean(active),
      device: { id: created.id, label: created.label ?? null, registeredAt: created.registeredAt },
    };
  }

  /* ------------------------------------------------------------------ */
  /* shared pre-checks for challenge + mark                              */
  /* ------------------------------------------------------------------ */
  private async precheck(ctx: Ctx, sessionId: string, presented: string | undefined): Promise<{ session: SessionRec; device: DeviceRec }> {
    ctx.sessionId = sessionId;
    const { actor } = ctx;

    // 1. Session must exist IN THE STUDENT'S OWN DEPARTMENT (another department's id is simply "not found").
    const session = await this.d.store.findSession(sessionId, actor.departmentId);
    if (!session || session.status === "CANCELLED") await this.fail(ctx, "SESSION_NOT_FOUND", 404, "Attendance session not found.");
    const s = session!;
    ctx.courseCode = s.courseCode;

    // 2. Student must be registered for this course in the term the session belongs to.
    const course = await this.d.store.getCourseContext(actor.studentId, actor.departmentId);
    const inTerm = course.term && course.term.academicSession === s.academicSession && course.term.semester === s.semester;
    if (!inTerm || !course.enrolledCodes.includes(s.courseCode)) {
      await this.fail(ctx, "NOT_ENROLLED", 403, "You are not registered for this course this semester.");
    }

    // 3. Time window.
    const now = this.d.now();
    if (s.status === "CLOSED" || now > s.closesAt) await this.fail(ctx, "SESSION_CLOSED", 403, "Attendance for this session has closed.");
    if (now < s.opensAt) await this.fail(ctx, "SESSION_NOT_OPEN", 403, "Attendance for this session has not opened yet.");

    // 3b. A session with no GPS location can't be verified. Fail closed instead of silently skipping the location layer.
    if (!s.location) await this.fail(ctx, "SESSION_LOCATION_NOT_CONFIGURED", 409, "This attendance session has no location set. Ask your lecturer.");

    // 4. Device binding: the presented token must resolve to THIS student's ACTIVE attendance device.
    const { device, fingerprint } = await this.resolveDevice(presented);
    ctx.fingerprint = fingerprint;
    if (!presented) await this.fail(ctx, "DEVICE_NOT_REGISTERED", 403, "This device isn't set up for attendance yet. Verify it first.");
    if (!device) await this.fail(ctx, "DEVICE_UNRECOGNISED", 403, "This device isn't recognised. Verify it to use it for attendance.");
    const dev = device!;
    ctx.deviceId = dev.id;
    if (dev.studentId !== actor.studentId) await this.fail(ctx, "DEVICE_BOUND_TO_OTHER_STUDENT", 403, MSG.boundToOther);
    if (dev.status !== "ACTIVE") await this.fail(ctx, "DEVICE_REVOKED", 403, "This device is no longer registered for attendance. Verify it again to use it.");

    // 5. Fast duplicate check (the unique index at record-creation is the real guarantee).
    if (await this.d.store.findRecord(s.id, actor.studentId)) {
      await this.fail(ctx, "ALREADY_MARKED", 409, "You have already marked attendance for this session.");
    }
    return { session: s, device: dev };
  }

  /* ------------------------------------------------------------------ */
  /* attendance token (challenge)                                        */
  /* ------------------------------------------------------------------ */
  async createChallenge(actor: Actor, meta: RequestMeta, sessionId: string, presented?: string) {
    const ctx: Ctx = { action: "CHALLENGE", actor, meta };
    const { session, device } = await this.precheck(ctx, sessionId, presented);

    const raw = generateDeviceToken(); // same primitive: 256 random bits
    const now = this.d.now();
    const expiresAt = new Date(now.getTime() + this.d.config.challengeTtlSeconds * 1000);
    await this.d.store.createChallenge({ studentId: actor.studentId, deviceId: device.id, sessionId: session.id, tokenHash: sha256(raw), expiresAt });
    await this.log(ctx, "SUCCESS");
    return {
      attendanceToken: raw,
      expiresAt,
      expiresInSeconds: this.d.config.challengeTtlSeconds,
      requiresLocation: Boolean(session.location),
      requiresCode: Boolean(session.codeHash),
    };
  }

  /* ------------------------------------------------------------------ */
  /* mark attendance                                                     */
  /* ------------------------------------------------------------------ */
  async markAttendance(actor: Actor, meta: RequestMeta, sessionId: string, presented: string | undefined, input: MarkInput) {
    const ctx: Ctx = { action: "MARK", actor, meta };
    const { session, device } = await this.precheck(ctx, sessionId, presented);

    // 6. Location: the SERVER computes the distance. We never accept a client "withinRadius" flag.
    let location: { latitude: number; longitude: number; accuracyMeters?: number; distanceMeters: number } | undefined;
    if (session.location) { // always true here: precheck rejects sessions without a location
      const { latitude, longitude, accuracyMeters } = input;
      if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
        await this.fail(ctx, "LOCATION_REQUIRED", 422, "Your location is required to mark attendance for this session.");
      }
      const lat = latitude as number;
      const lng = longitude as number;
      ctx.location = { latitude: lat, longitude: lng, accuracyMeters };
      if (accuracyMeters !== undefined && accuracyMeters > this.d.config.maxAccuracyMeters) {
        await this.fail(ctx, "LOCATION_ACCURACY_LOW", 422, "Your location signal is too weak. Move to an open area and try again.");
      }
      const distance = distanceMeters({ latitude: lat, longitude: lng }, session.location);
      const near = evaluateProximity({
        distanceMeters: distance, allowedRadiusInMeters: session.location.allowedRadiusInMeters, studentAccuracyMeters: accuracyMeters,
        venueAccuracyMeters: session.location.accuracyMeters, maxAllowanceMeters: this.d.config.accuracyAllowanceMaxMeters ?? 0,
      });
      const within = near.within;
      ctx.location = { latitude: lat, longitude: lng, accuracyMeters, distanceMeters: Math.round(distance), withinRadius: within };
      if (!within) {
        if (this.d.config.showDistance === false) await this.fail(ctx, "LOCATION_OUTSIDE_RADIUS", 403, "You are outside the allowed attendance location.");
        const shown = Math.max(10, Math.round(distance / 10) * 10);
        await this.fail(
          ctx, "LOCATION_OUTSIDE_RADIUS", 403,
          `You appear to be about ${shown} m from the attendance location (allowed: ${near.effectiveRadiusMeters} m). If you are in the room, move near a window or outside, wait a few seconds for a better GPS fix, and try again.`,
          { distanceMeters: shown, allowedRadiusInMeters: session.location.allowedRadiusInMeters, accuracyAllowanceMeters: near.allowanceMeters, effectiveRadiusMeters: near.effectiveRadiusMeters, yourAccuracyMeters: accuracyMeters ?? null },
        );
      }
      location = { latitude: lat, longitude: lng, accuracyMeters, distanceMeters: Math.round(distance) };
    }

    // 7. Optional in-class code.
    if (session.codeHash) {
      if (!input.code) await this.fail(ctx, "CODE_REQUIRED", 422, "Enter the attendance code given in class.");
      if (!safeEqual(hashAttendanceCode(input.code as string), session.codeHash)) {
        await this.fail(ctx, "CODE_INCORRECT", 403, "Incorrect attendance code.");
      }
    }

    // 8. Attendance token: single-use, short-lived, bound to THIS student + THIS device + THIS session.
    const now = this.d.now();
    const consumed = await this.d.store.consumeChallenge({
      tokenHash: sha256(input.attendanceToken), studentId: actor.studentId, deviceId: device.id, sessionId: session.id, now,
    });
    if (!consumed) await this.fail(ctx, "ATTENDANCE_TOKEN_INVALID", 403, "Your attendance request expired or is invalid. Please start again.");

    // 9. The database's unique (session, student) index is what truly prevents double attendance.
    const lateAt = new Date(session.opensAt.getTime() + session.lateAfterMinutes * 60_000);
    try {
      const record = await this.d.store.createRecord({
        sessionId: session.id, studentId: actor.studentId, departmentId: actor.departmentId, courseCode: session.courseCode,
        markedAt: now, status: now > lateAt ? "LATE" : "PRESENT", deviceId: device.id, ip: meta.ip, location,
      });
      await this.d.store.touchDevice(device.id, now, meta.ip);
      await this.log(ctx, "SUCCESS");
      return {
        sessionId: session.id, courseCode: session.courseCode, status: record.status, markedAt: record.markedAt,
        locationVerified: Boolean(location),
      };
    } catch (err) {
      if (err instanceof StoreDuplicateError) await this.fail(ctx, "ALREADY_MARKED", 409, "You have already marked attendance for this session.");
      throw err;
    }
  }
}
