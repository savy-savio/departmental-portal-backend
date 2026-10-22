import type { Request, Response } from "express";
import * as profileService from "../services/student-profile.service";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";
import { toStudentDTO } from "../utils/dto";
import { sendSuccess } from "../utils/response";

function authed(req: Request) {
  if (!req.student || !req.department) throw new AppError(401, "Authentication required.");
  return { student: req.student, department: req.department };
}

export const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, toStudentDTO(student, department));
});

export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await profileService.updateProfile(student, department, req.body), "Profile updated.");
});

export const uploadPhoto = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await profileService.setProfilePhoto(student, department, req.file?.buffer), "Profile photo updated.");
});

export const deletePhoto = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await profileService.removeProfilePhoto(student, department), "Profile photo removed.");
});
