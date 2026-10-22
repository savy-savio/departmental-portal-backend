import { env } from "../config/env";
import { Department, DepartmentDocument } from "../models/Department";
import { Student, StudentDocument } from "../models/Student";
import { AppError } from "../utils/AppError";
import { LOGIN_LOCK_MINUTES, MAX_FAILED_LOGINS } from "../utils/constants";
import { generateToken, sha256 } from "../utils/crypto";
import { toStudentDTO } from "../utils/dto";
import { namesMatch } from "../utils/name";
import { parseMatricNumber } from "./matric.service";
import {
  sendInBackground,
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
} from "./email.service";
import { notify } from "./notification.service";
import { fakePasswordCheck, hashPassword, verifyPassword } from "./password.service";
import { signAccessToken, signOnboardingToken } from "./token.service";
import type {
  ChangePasswordInput,
  CompleteOnboardingInput,
  LoginInput,
  ResetPasswordInput,
  VerifyIdentityInput,
} from "../validators/student-auth.validators";

const INVALID_CREDENTIALS = "Invalid email or password.";
const VERIFY_FAILED = "We couldn't verify those details. Check your full name and matric number and try again.";
const RESET_INVALID = "This reset link is invalid or has expired. Please request a new one.";

async function loadActiveDepartment(departmentId: unknown): Promise<DepartmentDocument> {
  const department = await Department.findById(departmentId);
  if (!department || !department.isActive) {
    throw new AppError(403, "Your department is not currently active on the portal.");
  }
  return department;
}

/* ------------------------------------------------------------------ */
/* Stage 4a: first-time identity verification (full name + matric)     */
/* ------------------------------------------------------------------ */
export async function verifyIdentity(input: VerifyIdentityInput) {
  const parsed = parseMatricNumber(input.matricNumber);
  if (!parsed) {
    throw new AppError(422, "That matric number isn't in a valid format (for example 25/208XXX/123).");
  }

  const student = await Student.findOne({ matricNumber: parsed.normalized });
  // Same message for "no such matric" and "wrong name" so the endpoint can't be used to probe records.
  if (!student || !namesMatch(input.fullName, student.firstName, student.lastName)) {
    throw new AppError(401, VERIFY_FAILED);
  }
  if (student.status === "SUSPENDED") throw new AppError(403, "Your account has been suspended. Contact your department.");
  if (student.onboardingCompleted) {
    throw new AppError(409, "This account is already set up. Please log in with your email and password.");
  }
  const department = await loadActiveDepartment(student.department);

  return {
    onboardingToken: signOnboardingToken(student),
    expiresIn: env.ONBOARDING_TOKEN_EXPIRES_IN,
    student: {
      firstName: student.firstName,
      lastName: student.lastName,
      matricNumber: student.matricNumber,
      level: student.level,
      academicSession: student.academicSession,
      department: { name: department.name, code: department.code },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Stage 4b: set email + password, activate, issue the real JWT        */
/* ------------------------------------------------------------------ */
export async function completeOnboarding(
  student: StudentDocument,
  department: DepartmentDocument,
  input: CompleteOnboardingInput,
) {
  if (await Student.exists({ email: input.email })) {
    throw new AppError(409, "This email address is already registered.");
  }

  const passwordHash = await hashPassword(input.password);

  // Atomic: only succeeds if onboarding hasn't already been completed (blocks token replay / double submit).
  const updated = await Student.findOneAndUpdate(
    { _id: student._id, onboardingCompleted: false, status: "PENDING_ONBOARDING" },
    {
      $set: {
        email: input.email,
        passwordHash,
        onboardingCompleted: true,
        onboardedAt: new Date(),
        status: "ACTIVE",
      },
    },
    { new: true },
  );
  if (!updated) throw new AppError(409, "This account is already set up. Please log in with your email and password.");

  sendInBackground("welcome", sendWelcomeEmail(input.email, updated.firstName));
  await notify({
    recipient: updated._id,
    department: department._id,
    kind: "SYSTEM",
    title: "Welcome to the portal",
    body: "Your account is ready. Register your courses to see your timetable and assignments.",
    link: "/student/courses",
  });

  return { token: signAccessToken(updated), student: toStudentDTO(updated, department) };
}

/* ------------------------------------------------------------------ */
/* Stage 5: normal login                                               */
/* ------------------------------------------------------------------ */
export async function login(input: LoginInput) {
  const student = await Student.findOne({ email: input.email }).select(
    "+passwordHash +failedLoginAttempts +lockUntil",
  );

  if (!student || !student.passwordHash) {
    await fakePasswordCheck(input.password);
    throw new AppError(401, INVALID_CREDENTIALS);
  }

  if (student.lockUntil && student.lockUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((student.lockUntil.getTime() - Date.now()) / 60_000);
    throw new AppError(429, `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }

  const ok = await verifyPassword(input.password, student.passwordHash);
  if (!ok) {
    const attempts = (student.failedLoginAttempts ?? 0) + 1;
    if (attempts >= MAX_FAILED_LOGINS) {
      await Student.updateOne(
        { _id: student._id },
        { $set: { failedLoginAttempts: 0, lockUntil: new Date(Date.now() + LOGIN_LOCK_MINUTES * 60_000) } },
      );
    } else {
      await Student.updateOne({ _id: student._id }, { $set: { failedLoginAttempts: attempts } });
    }
    throw new AppError(401, INVALID_CREDENTIALS);
  }

  // Status is only revealed to someone who proved they own the account.
  if (!student.onboardingCompleted) throw new AppError(403, "Please finish setting up your account first.");
  if (student.status !== "ACTIVE") throw new AppError(403, "Your account is not active. Contact your department.");
  const department = await loadActiveDepartment(student.department);

  await Student.updateOne(
    { _id: student._id },
    { $set: { failedLoginAttempts: 0, lastLoginAt: new Date() }, $unset: { lockUntil: "" } },
  );

  return { token: signAccessToken(student), student: toStudentDTO(student, department) };
}

/* ------------------------------------------------------------------ */
/* Stage 5: forgot / reset password                                    */
/* ------------------------------------------------------------------ */
/** Always resolves silently; the controller returns the same message whether or not the email exists. */
export async function requestPasswordReset(email: string): Promise<void> {
  const student = await Student.findOne({ email, status: "ACTIVE" });
  if (!student) return;

  const rawToken = generateToken(32);
  await Student.updateOne(
    { _id: student._id },
    {
      $set: {
        resetPasswordTokenHash: sha256(rawToken), // only the hash is stored
        resetPasswordExpires: new Date(Date.now() + env.PASSWORD_RESET_EXPIRES_MINUTES * 60_000),
      },
    },
  );
  // Not awaited: keeps response time identical for existing and non-existing emails.
  sendInBackground("password-reset", sendPasswordResetEmail(email, student.firstName, rawToken));
}

export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const tokenHash = sha256(input.token);
  const student = await Student.findOne({
    resetPasswordTokenHash: tokenHash,
    resetPasswordExpires: { $gt: new Date() },
    status: "ACTIVE",
  });
  if (!student) throw new AppError(400, RESET_INVALID);

  const passwordHash = await hashPassword(input.password);

  // Atomic consume: a token can only be used once, even with two simultaneous requests.
  const result = await Student.updateOne(
    { _id: student._id, resetPasswordTokenHash: tokenHash },
    {
      $set: { passwordHash, passwordChangedAt: new Date(), failedLoginAttempts: 0 },
      $unset: { resetPasswordTokenHash: "", resetPasswordExpires: "", lockUntil: "" },
    },
  );
  if (result.modifiedCount !== 1) throw new AppError(400, RESET_INVALID);

  if (student.email) sendInBackground("password-changed", sendPasswordChangedEmail(student.email, student.firstName));
}

/* ------------------------------------------------------------------ */
/* Change password (signed in)                                         */
/* ------------------------------------------------------------------ */
export async function changePassword(
  student: StudentDocument,
  department: DepartmentDocument,
  input: ChangePasswordInput,
) {
  const withHash = await Student.findById(student._id).select("+passwordHash");
  if (!withHash?.passwordHash) throw new AppError(401, "Authentication required.");

  if (!(await verifyPassword(input.currentPassword, withHash.passwordHash))) {
    throw new AppError(400, "Your current password is incorrect.");
  }
  if (await verifyPassword(input.password, withHash.passwordHash)) {
    throw new AppError(400, "Your new password must be different from the current one.");
  }

  const passwordHash = await hashPassword(input.password);
  const updated = await Student.findByIdAndUpdate(
    student._id,
    { $set: { passwordHash, passwordChangedAt: new Date() } },
    { new: true },
  );
  if (!updated) throw new AppError(401, "Authentication required.");

  if (updated.email) sendInBackground("password-changed", sendPasswordChangedEmail(updated.email, updated.firstName));

  // Old tokens are now invalid (passwordChangedAt); hand back a fresh one for this session.
  return { token: signAccessToken(updated), student: toStudentDTO(updated, department) };
}
