import type { Request, RequestHandler } from "express";
import { hodAuth, hodService } from "../services/hod";
import type { HodActor, HodMeta } from "../services/hod/types";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Loaded from the database from the verified HOD token. Never taken from client input. */
      hodCtx?: { actor: HodActor; department: { id: string; name: string; code: string }; role: string; status: string };
    }
  }
}

export function hodActor(req: Request): HodActor {
  if (!req.hodCtx) throw new AppError(401, "Authentication required.");
  return req.hodCtx.actor;
}
/** The IP is recorded in the audit trail only; it never decides anything. */
export const hodMeta = (req: Request): HodMeta => ({ ip: req.ip });

/**
 * Steps 1-4 of the HOD authorization chain: valid HOD token (lecturer / student tokens have different audiences and are refused),
 * the HOD record exists, is the department's CURRENT head and ACTIVE, and the department is active. Role and department are
 * re-read from the database on every request, never taken from the token or the client.
 */
export const authenticateHod: RequestHandler = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ") || !header.slice(7).trim()) throw new AppError(401, "Authentication required.");
  const { actor, lecturer, department } = await hodAuth.authenticate(header.slice(7).trim());
  req.hodCtx = { actor: { hodId: actor.lecturerId, departmentId: actor.departmentId, firstName: actor.firstName, lastName: actor.lastName }, department, role: lecturer.role, status: lecturer.status };
  next();
});

/** Explicit role gate (defence in depth after authenticateHod). */
export const requireHod: RequestHandler = (req, _res, next) => {
  if (!req.hodCtx || req.hodCtx.role !== "HOD" || req.hodCtx.status !== "ACTIVE") return next(new AppError(403, "Department head access only.", undefined, "NOT_A_HOD"));
  next();
};

const SCOPE_KEYS = ["departmentId", "department", "department_id"];
/**
 * Step 5: the department is ALWAYS the authenticated HOD's own. If the request names a department (body, query or path) that isn't theirs it is refused
 * and audited as a SCOPE_VIOLATION; if it names their own it is simply ignored. Every service call and every store query is then filtered by the HOD's department,
 * so an id from another department answers like a missing one.
 */
export const requireDepartmentScope: RequestHandler = asyncHandler(async (req, _res, next) => {
  const actor = hodActor(req);
  for (const src of [req.params, req.query, req.body] as Record<string, unknown>[]) {
    for (const key of SCOPE_KEYS) {
      const v = src?.[key];
      if (v !== undefined) await hodService.assertScope(actor, String(v), hodMeta(req));
    }
  }
  next();
});
