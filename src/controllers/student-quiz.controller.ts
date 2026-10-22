import type { Request } from "express";
import { quizService as quiz } from "../services/quiz";
import type { QuizPlayerIdentity } from "../services/quiz/quiz.service";
import { asyncHandler } from "../utils/asyncHandler";
import { sendSuccess } from "../utils/response";

/** A student playing: identity, department and level come from the token (the game's eligibility rule is checked in the service). */
const me = (req: Request): QuizPlayerIdentity => ({ studentId: String(req.student!._id), departmentId: String(req.department!._id), level: req.student!.level });
const H = asyncHandler;

export const join = H(async (req, res) => sendSuccess(res, await quiz.join(me(req), req.body), "Joined."));
export const active = H(async (req, res) => sendSuccess(res, await quiz.active(me(req))));
export const gameState = H(async (req, res) => sendSuccess(res, await quiz.getPlayerState(me(req), req.params.gameId)));
export const answer = H(async (req, res) => sendSuccess(res, await quiz.answer(me(req), req.params.gameId, req.body)));
export const leave = H(async (req, res) => { await quiz.leave(me(req), req.params.gameId); sendSuccess(res, {}); });
export const results = H(async (req, res) => sendSuccess(res, await quiz.results(me(req))));
export const result = H(async (req, res) => sendSuccess(res, await quiz.result(me(req), req.params.gameId)));
