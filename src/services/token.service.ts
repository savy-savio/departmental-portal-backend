import jwt, { JwtPayload, SignOptions } from "jsonwebtoken";
import { env } from "../config/env";
import { AppError } from "../utils/AppError";
import type { StudentDocument } from "../models/Student";

const ISSUER = "departmental-portal";
const AUDIENCE_ACCESS = "student-access";
const AUDIENCE_ONBOARDING = "student-onboarding";

export interface VerifiedToken {
  studentId: string;
  /** Issued-at, seconds since epoch. */
  issuedAt: number;
}

function sign(student: StudentDocument, audience: string, expiresIn: string): string {
  // Payload carries ONLY the subject. Role / department are always re-read from the database.
  return jwt.sign({}, env.JWT_SECRET, {
    algorithm: "HS256",
    subject: String(student._id),
    audience,
    issuer: ISSUER,
    expiresIn: expiresIn as SignOptions["expiresIn"],
  });
}

function verify(token: string, audience: string, expiredMessage: string, invalidMessage: string): VerifiedToken {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ["HS256"],
      audience,
      issuer: ISSUER,
    }) as JwtPayload;
    if (!payload.sub || typeof payload.iat !== "number") throw new Error("malformed");
    return { studentId: payload.sub, issuedAt: payload.iat };
  } catch (err) {
    // Distinct codes let the frontend sign out ONLY when the session has really ended (and not on a network error, 429 or 5xx).
    if (err instanceof jwt.TokenExpiredError) throw new AppError(401, expiredMessage, undefined, "TOKEN_EXPIRED");
    throw new AppError(401, invalidMessage, undefined, "TOKEN_INVALID");
  }
}

export const signAccessToken = (student: StudentDocument): string =>
  sign(student, AUDIENCE_ACCESS, env.JWT_EXPIRES_IN);

export const signOnboardingToken = (student: StudentDocument): string =>
  sign(student, AUDIENCE_ONBOARDING, env.ONBOARDING_TOKEN_EXPIRES_IN);

export const verifyAccessToken = (token: string): VerifiedToken =>
  verify(token, AUDIENCE_ACCESS, "Your session has expired. Please log in again.", "Invalid authentication token.");

export const verifyOnboardingToken = (token: string): VerifiedToken =>
  verify(
    token,
    AUDIENCE_ONBOARDING,
    "Your verification has expired. Please verify your details again.",
    "Invalid onboarding token.",
  );

/* ---------------- lecturer tokens (separate audience) ---------------- */
const AUDIENCE_LECTURER = "lecturer-access";

export function signLecturerAccessToken(lecturerId: string): string {
  return jwt.sign({}, env.JWT_SECRET, { algorithm: "HS256", subject: lecturerId, audience: AUDIENCE_LECTURER, issuer: ISSUER, expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"] });
}
export function verifyLecturerAccessToken(token: string): { lecturerId: string; issuedAt: number } {
  const v = verify(token, AUDIENCE_LECTURER, "Your session has expired. Please log in again.", "Invalid authentication token.");
  return { lecturerId: v.studentId, issuedAt: v.issuedAt }; // `studentId` is just the JWT subject field in the shared helper
}

/* ---------------- HOD tokens (their own audience) ---------------- */
const AUDIENCE_HOD = "hod-access";
export function signHodAccessToken(hodId: string): string {
  return jwt.sign({}, env.JWT_SECRET, { algorithm: "HS256", subject: hodId, audience: AUDIENCE_HOD, issuer: ISSUER, expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"] });
}
export function verifyHodAccessToken(token: string): { lecturerId: string; issuedAt: number } {
  const v = verify(token, AUDIENCE_HOD, "Your session has expired. Please log in again.", "Invalid authentication token.");
  return { lecturerId: v.studentId, issuedAt: v.issuedAt }; // `lecturerId` here is simply "the staff account id" for the shared auth engine
}
