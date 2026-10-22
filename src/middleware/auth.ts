import type { Request, RequestHandler } from "express";
import { Department, DepartmentDocument } from "../models/Department";
import { Student, StudentDocument } from "../models/Student";
import { verifyAccessToken, verifyOnboardingToken } from "../services/token.service";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";
import type { StudentRole } from "../utils/constants";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Loaded from the database using the verified token. Never taken from client input. */
      student?: StudentDocument;
      /** The authenticated student's own department (derived server-side). */
      department?: DepartmentDocument;
    }
  }
}

function bearerToken(req: Request): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new AppError(401, "Authentication required.");
  }
  const token = header.slice(7).trim();
  if (!token) throw new AppError(401, "Authentication required.");
  return token;
}

/** Guards POST /onboarding/complete: needs the short-lived token from /onboarding/verify. */
export const authenticateOnboarding: RequestHandler = asyncHandler(async (req, _res, next) => {
  const { studentId } = verifyOnboardingToken(bearerToken(req));
  const student = await Student.findById(studentId);
  if (!student) throw new AppError(401, "Invalid onboarding token.");
  if (student.onboardingCompleted) {
    throw new AppError(409, "This account is already set up. Please log in with your email and password.");
  }
  if (student.status === "SUSPENDED") throw new AppError(403, "Your account has been suspended. Contact your department.");
  const department = await Department.findById(student.department);
  if (!department || !department.isActive) throw new AppError(403, "Your department is not currently active on the portal.");
  req.student = student;
  req.department = department;
  next();
});

/** Guards every protected student route. Identity, role and department come from the DB, not the client. */
/**
 * Verifies a student access token and loads the student + department, applying every rule the API enforces (password-change invalidation,
 * onboarding, ACTIVE status, active department). Shared by the HTTP middleware and the Socket.IO handshake so both accept exactly the same people.
 */
export async function loadActiveStudent(token: string) {
  const { studentId, issuedAt } = verifyAccessToken(token);
  const student = await Student.findById(studentId).select("+passwordChangedAt");
  if (!student) throw new AppError(401, "Invalid authentication token.", undefined, "TOKEN_INVALID");

  // A password change/reset invalidates every token issued before it.
  if (student.passwordChangedAt && Math.floor(student.passwordChangedAt.getTime() / 1000) > issuedAt) {
    throw new AppError(401, "Your password was changed. Please log in again.", undefined, "PASSWORD_CHANGED");
  }
  if (!student.onboardingCompleted) throw new AppError(403, "Please finish setting up your account first.", undefined, "ONBOARDING_REQUIRED");
  if (student.status !== "ACTIVE") throw new AppError(403, "Your account is not active. Contact your department.", undefined, "ACCOUNT_INACTIVE");

  const department = await Department.findById(student.department);
  if (!department || !department.isActive) throw new AppError(403, "Your department is not currently active on the portal.", undefined, "DEPARTMENT_INACTIVE");
  return { student, department };
}

export const authenticateStudent: RequestHandler = asyncHandler(async (req, _res, next) => {
  const { student, department } = await loadActiveStudent(bearerToken(req));
  req.student = student;
  req.department = department;
  next();
});

/** Role gate. Department scoping is applied separately in each query via req.department. */
export const requireRole =
  (...roles: StudentRole[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.student || !roles.includes(req.student.role)) {
      return next(new AppError(403, "You do not have permission to do that."));
    }
    next();
  };
