import type { Request, Response } from "express";
import * as authService from "../services/student-auth.service";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";
import { sendMessage, sendSuccess } from "../utils/response";

function requireAuthed(req: Request) {
  if (!req.student || !req.department) throw new AppError(401, "Authentication required.");
  return { student: req.student, department: req.department };
}

export const verifyIdentity = asyncHandler(async (req: Request, res: Response) => {
  const data = await authService.verifyIdentity(req.body);
  sendSuccess(res, data, "Identity verified. Continue to set up your account.");
});

export const completeOnboarding = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = requireAuthed(req);
  const data = await authService.completeOnboarding(student, department, req.body);
  sendSuccess(res, data, "Your account is ready.", 201);
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const data = await authService.login(req.body);
  sendSuccess(res, data, "Login successful.");
});

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  await authService.requestPasswordReset(req.body.email);
  // Identical response whether or not the email exists.
  sendMessage(res, "If an account exists for that email, a reset link has been sent.");
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  await authService.resetPassword(req.body);
  sendMessage(res, "Your password has been reset. You can now log in.");
});

export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = requireAuthed(req);
  const data = await authService.changePassword(student, department, req.body);
  sendSuccess(res, data, "Password changed.");
});

/** JWTs are stateless; the client discards the token. Endpoint exists so the frontend has a stable call. */
export const logout = asyncHandler(async (_req: Request, res: Response) => {
  sendMessage(res, "Logged out.");
});
