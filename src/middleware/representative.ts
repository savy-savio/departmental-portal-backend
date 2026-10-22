import type { Request, RequestHandler } from "express";
import { repActorFrom, representativeService } from "../services/representative";
import type { Permission } from "../services/representative/policy";
import type { AssignmentRec } from "../services/representative/types";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The caller's assignments that are valid right now (ACTIVE, own department, current term). */
      representative?: { assignments: AssignmentRec[] };
      /** Set by requireAssignedCourse when the route targets a specific course. */
      repAssignment?: AssignmentRec;
    }
  }
}

export function actorOf(req: Request) {
  if (!req.student || !req.department) throw new AppError(401, "Authentication required.");
  return repActorFrom(req.student, req.department);
}

/**
 * Run AFTER authenticateStudent. Representative authority is not a JWT claim or a Student.role value:
 * it is an ACTIVE CourseRepresentativeAssignment in the department's current term, looked up on every request,
 * so revoking an assignment takes effect on the very next call.
 */
export const requireRepresentative: RequestHandler = asyncHandler(async (req, _res, next) => {
  req.representative = { assignments: await representativeService.requireRepresentative(actorOf(req)) };
  next();
});

/** The caller must hold the permission on at least one of their valid assignments. (Per-course checks happen again inside the service.) */
export const requireRepresentativePermission = (permission: Permission): RequestHandler =>
  asyncHandler(async (req, _res, next) => {
    await representativeService.requirePermission(actorOf(req), req.representative?.assignments ?? [], permission);
    next();
  });

/** For routes that name a course (`:courseId`, `?courseId=`, or `courseId` in the body): the caller must be assigned to exactly that course. */
export const requireAssignedCourse = (source: "params" | "query" | "body" = "params"): RequestHandler =>
  asyncHandler(async (req, _res, next) => {
    const courseId = (req[source] as { courseId?: string } | undefined)?.courseId;
    if (courseId) req.repAssignment = await representativeService.assertAssigned(actorOf(req), req.representative?.assignments ?? [], courseId);
    next();
  });
