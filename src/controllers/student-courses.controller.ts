import type { Request, Response } from "express";
import * as svc from "../services/student-courses.service";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";
import { sendSuccess } from "../utils/response";

function authed(req: Request) {
  if (!req.student || !req.department) throw new AppError(401, "Authentication required.");
  return { student: req.student, department: req.department };
}

export const listMine = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await svc.listMyCourses(student, department));
});

export const listAvailable = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await svc.listAvailableCourses(student, department));
});

export const listCarryoverOptions = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await svc.listCarryoverOptions(student, department));
});

export const history = asyncHandler(async (req: Request, res: Response) => {
  const { student } = authed(req);
  sendSuccess(res, await svc.courseHistory(student));
});

export const add = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await svc.addCourse(student, department, req.body), "Course added.", 201);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await svc.updateEnrollment(student, department, req.params.enrollmentId, req.body), "Registration updated.");
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  await svc.removeEnrollment(student, department, req.params.enrollmentId);
  res.status(200).json({ success: true, message: "Course removed." });
});
