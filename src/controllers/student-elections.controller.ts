import type { Request, Response } from "express";
import * as elections from "../services/student-elections.service";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";
import { sendSuccess } from "../utils/response";

function authed(req: Request) {
  if (!req.student || !req.department) throw new AppError(401, "Authentication required.");
  return { student: req.student, department: req.department };
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await elections.listElections(student, department));
});
export const get = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await elections.getElection(student, department, req.params.electionId));
});
export const vote = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await elections.castVotes(student, department, req.params.electionId, req.body), "Your vote has been recorded.", 201);
});
export const results = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await elections.getResults(student, department, req.params.electionId));
});
