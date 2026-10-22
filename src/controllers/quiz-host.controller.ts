import type { Request } from "express";
import { quizService as quiz } from "../services/quiz";
import { pickLevel } from "../services/quiz/rules";
import type { QuizHost } from "../services/quiz/quiz.service";
import { asyncHandler } from "../utils/asyncHandler";
import { sendSuccess } from "../utils/response";

/**
 * The rep running a quiz. Identity comes from the token, the level from their appointment: never from the request.
 * (Course Rep / Assistant permissions are enforced by requireRepresentativePermission on every route.)
 */
function hostOf(req: Request): QuizHost {
  const s = req.student!;
  const levels = (req.representative?.assignments ?? []).map((a) => a.level);
  return { studentId: String(s._id), departmentId: String(req.department!._id), name: `${s.firstName} ${s.lastName}`.trim(), level: pickLevel(levels, s.level) };
}
const H = asyncHandler;

export const listQuizzes = H(async (req, res) => sendSuccess(res, await quiz.listQuizzes(hostOf(req))));
export const createQuiz = H(async (req, res) => sendSuccess(res, await quiz.createQuiz(hostOf(req), req.body), "Quiz created.", 201));
export const getQuiz = H(async (req, res) => sendSuccess(res, await quiz.getQuiz(hostOf(req), req.params.id)));
export const updateQuiz = H(async (req, res) => sendSuccess(res, await quiz.updateQuiz(hostOf(req), req.params.id, req.body), "Quiz updated."));
export const deleteQuiz = H(async (req, res) => { await quiz.deleteQuiz(hostOf(req), req.params.id); sendSuccess(res, {}, "Quiz deleted."); }); // data: {} as the contract says
export const hostGame = H(async (req, res) => sendSuccess(res, await quiz.hostGame(hostOf(req), req.params.id), "Game created.", 201));
export const listGames = H(async (req, res) => sendSuccess(res, await quiz.listGames(hostOf(req))));
export const gameState = H(async (req, res) => sendSuccess(res, await quiz.getHostState(hostOf(req), req.params.gameId)));
export const startGame = H(async (req, res) => sendSuccess(res, await quiz.start(hostOf(req), req.params.gameId)));
export const endQuestion = H(async (req, res) => sendSuccess(res, await quiz.endQuestion(hostOf(req), req.params.gameId)));
export const nextQuestion = H(async (req, res) => sendSuccess(res, await quiz.next(hostOf(req), req.params.gameId)));
export const cancelGame = H(async (req, res) => sendSuccess(res, await quiz.cancel(hostOf(req), req.params.gameId)));
export const kickPlayer = H(async (req, res) => { await quiz.kick(hostOf(req), req.params.gameId, req.params.playerId); sendSuccess(res, {}); });
