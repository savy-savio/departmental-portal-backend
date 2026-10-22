import { env } from "../../config/env";
import { Student } from "../../models/Student";
import { AppError } from "../../utils/AppError";
import { sendDeviceVerificationEmail } from "../email.service";
import { verifyPassword } from "../password.service";
import { AttendanceSecurityService } from "./attendance-security.service";
import { MongoAttendanceStore } from "./mongo-store";

/** The single production wiring of the attendance security engine (Mongo store + Resend + bcrypt). */
export const attendanceSecurity = new AttendanceSecurityService({
  store: new MongoAttendanceStore(),
  now: () => new Date(),
  config: {
    challengeTtlSeconds: env.ATTENDANCE_CHALLENGE_TTL_SECONDS,
    verificationTtlMinutes: env.DEVICE_VERIFICATION_TTL_MINUTES,
    maxVerificationAttempts: 5,
    maxDeviceChangesPer30Days: env.DEVICE_CHANGE_LIMIT_30D,
    maxAccuracyMeters: env.ATTENDANCE_MAX_ACCURACY_METERS,
    accuracyAllowanceMaxMeters: env.ATTENDANCE_ACCURACY_ALLOWANCE_MAX_METERS,
    showDistance: env.ATTENDANCE_SHOW_DISTANCE === "true",
    hmacKey: env.JWT_SECRET,
  },
  verifyPassword: async (studentId, password) => {
    const s = await Student.findById(studentId).select("+passwordHash");
    return Boolean(s?.passwordHash && (await verifyPassword(password, s.passwordHash)));
  },
  sendVerificationCode: async (actor, code, purpose) => {
    if (!actor.email) throw new AppError(409, "No email address is on file for your account.");
    try {
      await sendDeviceVerificationEmail(actor.email, actor.firstName, code, purpose);
    } catch {
      throw new AppError(502, "We couldn't send the verification email. Please try again.");
    }
  },
});
