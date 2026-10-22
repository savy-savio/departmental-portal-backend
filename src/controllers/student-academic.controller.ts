import type { Request, Response } from "express";
import * as announcements from "../services/student-announcements.service";
import * as assignments from "../services/student-assignments.service";
import * as documents from "../services/student-documents.service";
import * as materials from "../services/student-materials.service";
import * as timetable from "../services/student-timetable.service";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";
import { sendSuccess } from "../utils/response";

function authed(req: Request) {
  if (!req.student || !req.department) throw new AppError(401, "Authentication required.");
  return { student: req.student, department: req.department };
}

export const getTimetable = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await timetable.getTimetable(student, department, req.query as never));
});

export const listAnnouncements = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await announcements.listAnnouncements(student, department, req.query as never));
});

export const getAnnouncement = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await announcements.getAnnouncement(student, department, req.params.id));
});

export const listMaterials = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await materials.listMaterials(student, department, req.query as never));
});

export const listAssignments = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await assignments.listAssignments(student, department, req.query as never));
});

export const getAssignment = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await assignments.getAssignment(student, department, req.params.id));
});

export const submitAssignment = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  const data = await assignments.submitAssignment(student, department, req.params.id, req.body, req.file);
  sendSuccess(res, data, "Submission saved.", 201);
});

export const listDepartmentDocuments = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await documents.listDepartmentDocuments(student, department));
});
