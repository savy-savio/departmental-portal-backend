import type { Request, RequestHandler } from "express";
import { lecturerAuth, lecturerService } from "../services/lecturer";
import type { AuthLecturerRow } from "../services/lecturer/auth.service";
import type { LecturerActor, LecturerAssignmentRec, LecturerMeta } from "../services/lecturer/types";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Loaded from the database from the verified lecturer token. Never taken from client input. */
      lecturerCtx?: { actor: LecturerActor; lecturer: AuthLecturerRow; department: { id: string; name: string; code: string } };
      /** Set by requireLecturerCourseAssignment when the route names a course. */
      lecturerAssignment?: LecturerAssignmentRec;
    }
  }
}

export function lecturerActor(req: Request): LecturerActor {
  if (!req.lecturerCtx) throw new AppError(401, "Authentication required.");
  return req.lecturerCtx.actor;
}
/** The IP is recorded in the audit trail only; it is never used to decide anything. */
export const lecturerMeta = (req: Request): LecturerMeta => ({ ip: req.ip });

/**
 * Steps 1-3 of the lecturer authorization chain: valid LECTURER token (a student's token is rejected: different audience),
 * the lecturer exists, is ACTIVE, and belongs to an active department. Role / department / status are re-read from the database on every request.
 */
export const authenticateLecturer: RequestHandler = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ") || !header.slice(7).trim()) throw new AppError(401, "Authentication required.");
  const { actor, lecturer, department } = await lecturerAuth.authenticate(header.slice(7).trim());
  req.lecturerCtx = { actor, lecturer, department };
  next();
});

/** Explicit role gate (defence in depth after authenticateLecturer). */
export const requireLecturer: RequestHandler = (req, _res, next) => {
  const l = req.lecturerCtx?.lecturer;
  if (!l || l.role !== "LECTURER" || l.status !== "ACTIVE") return next(new AppError(403, "Lecturer access only.", undefined, "NOT_A_LECTURER"));
  next();
};

/**
 * Steps 4-7: for routes that name a course (`:courseId` or `courseId` in the body/query) the lecturer must hold an ACTIVE assignment
 * for exactly that course in the department's CURRENT term. "Not yours", "other department" and "doesn't exist" all answer the same.
 * The service re-checks, so non-HTTP callers get the same protection.
 */
export const requireLecturerCourseAssignment = (source: "params" | "body" | "query" = "params"): RequestHandler =>
  asyncHandler(async (req, _res, next) => {
    const courseId = (req[source] as { courseId?: string } | undefined)?.courseId;
    if (courseId) req.lecturerAssignment = (await lecturerService.authorizeCourse(lecturerActor(req), courseId, lecturerMeta(req))).assignment;
    next();
  });
