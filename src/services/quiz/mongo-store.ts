import { Types, type FilterQuery } from "mongoose";
import { Quiz, type QuizDocument } from "../../models/Quiz";
import { QuizAnswer, type QuizAnswerDocument } from "../../models/QuizAnswer";
import { QuizGame, type QuizGameDocument } from "../../models/QuizGame";
import { QuizPlayer, type QuizPlayerDocument } from "../../models/QuizPlayer";
import { StoreDuplicateError } from "../hod/store";
import type { QuizStore } from "./store";
import type { AnswerRec, GameExpect, GamePatch, GameRec, NewAnswer, NewGame, NewPlayer, PlayerCommit, PlayerRec, QuestionInput, QuizRec } from "./types";

const id = (v: unknown) => String(v);
const stamps = (d: unknown) => d as { createdAt: Date; updatedAt: Date };
const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;
const qs = (list: { text: string; options: string[]; correctIndex: number; jackpot?: boolean; type?: string }[]): QuestionInput[] =>
  list.map((q) => ({
    text: q.text, options: [...q.options], correctIndex: q.correctIndex,
    ...(q.type === "TRUE_FALSE" ? { type: "TRUE_FALSE" as const } : {}), // omitted for multiple choice, so older questions keep their exact shape
    ...(q.jackpot ? { jackpot: true } : {}),
  }));

const toQuiz = (q: QuizDocument): QuizRec => ({ id: id(q._id), ownerId: id(q.owner), departmentId: id(q.department), level: q.level, title: q.title, secondsPerQuestion: q.secondsPerQuestion, questions: qs(q.questions), timesHosted: q.timesHosted, createdAt: stamps(q).createdAt, updatedAt: stamps(q).updatedAt });
const toGame = (g: QuizGameDocument): GameRec => ({
  id: id(g._id), quizId: id(g.quiz), title: g.title, secondsPerQuestion: g.secondsPerQuestion, questions: qs(g.questions), hostId: id(g.host), hostName: g.hostName, departmentId: id(g.department),
  level: g.level, pin: g.pin, status: g.status, open: g.open, questionIndex: g.questionIndex, questionStartedAt: g.questionStartedAt ?? null, closing: g.closing,
  lastHostActionAt: g.lastHostActionAt, createdAt: stamps(g).createdAt, finishedAt: g.finishedAt ?? null,
});
const toPlayer = (p: QuizPlayerDocument): PlayerRec => ({
  id: id(p._id), gameId: id(p.game), studentId: id(p.student), nickname: p.nickname, nicknameKey: p.nicknameKey, score: p.score, streak: p.streak, correctCount: p.correctCount,
  totalCorrectMs: p.totalCorrectMs, rank: p.rank ?? null, finalRank: p.finalRank ?? null, joinedAt: p.joinedAt, seq: p.seq,
  lastQuestion: p.lastQuestion ?? -1, lastDrop: p.lastDrop ?? 0, // older players have neither
});
/** The last-result fields of a commit are only written when the commit carries them (the final-ranks commit does not). */
const optionalNumbers = (u: PlayerCommit) => {
  const out: Record<string, number> = {};
  for (const k of ["lastQuestion", "lastDrop"] as const) if (u[k] !== undefined) out[k] = u[k] as number;
  return out;
};
const toAnswer = (a: QuizAnswerDocument): AnswerRec => ({ id: id(a._id), gameId: id(a.game), playerId: id(a.player), studentId: id(a.student), questionIndex: a.questionIndex, choice: a.choice, elapsedMs: a.elapsedMs, correct: a.correct, points: a.points, streakBonus: a.streakBonus, streakAfter: a.streakAfter, seq: a.seq });

/** MongoDB implementation. Phase changes are single conditional updates (findOneAndUpdate with the expected state in the filter). */
export class MongoQuizStore implements QuizStore {
  async listQuizzes(ownerId: string, departmentId: string) { return (await Quiz.find({ owner: ownerId, department: departmentId }).sort({ createdAt: -1 })).map(toQuiz); }
  async getQuiz(ownerId: string, departmentId: string, quizId: string) { const q = await Quiz.findOne({ _id: quizId, owner: ownerId, department: departmentId }); return q ? toQuiz(q) : null; }
  async createQuiz(rec: { ownerId: string; departmentId: string; level: string; title: string; secondsPerQuestion: number; questions: QuestionInput[] }) {
    return toQuiz(await Quiz.create({ owner: rec.ownerId, department: rec.departmentId, level: rec.level, title: rec.title, secondsPerQuestion: rec.secondsPerQuestion, questions: rec.questions }));
  }
  async updateQuiz(ownerId: string, departmentId: string, quizId: string, patch: { title: string; secondsPerQuestion: number; questions: QuestionInput[] }) {
    const q = await Quiz.findOneAndUpdate({ _id: quizId, owner: ownerId, department: departmentId }, { $set: patch }, { new: true, runValidators: true });
    return q ? toQuiz(q) : null;
  }
  async deleteQuiz(ownerId: string, departmentId: string, quizId: string) { return (await Quiz.deleteOne({ _id: quizId, owner: ownerId, department: departmentId })).deletedCount > 0; }
  async bumpTimesHosted(quizId: string) { await Quiz.updateOne({ _id: quizId }, { $inc: { timesHosted: 1 } }); }

  async createGame(rec: NewGame) {
    try {
      return toGame(await QuizGame.create({
        quiz: rec.quizId, title: rec.title, secondsPerQuestion: rec.secondsPerQuestion, questions: rec.questions, host: rec.hostId, hostName: rec.hostName, department: rec.departmentId,
        level: rec.level, pin: rec.pin, status: rec.status, open: rec.open, questionIndex: rec.questionIndex, closing: rec.closing, lastHostActionAt: rec.lastHostActionAt,
      }));
    } catch (e) { if (isDup(e)) throw new StoreDuplicateError("pin"); throw e; }
  }
  async getGame(gameId: string) { if (!Types.ObjectId.isValid(gameId)) return null; const g = await QuizGame.findById(gameId); return g ? toGame(g) : null; }
  async openGameByPin(pin: string) { const g = await QuizGame.findOne({ pin, open: true }); return g ? toGame(g) : null; }
  async openGameOfHost(hostId: string) { const g = await QuizGame.findOne({ host: hostId, open: true }); return g ? toGame(g) : null; }
  async openGameOfQuiz(quizId: string) { const g = await QuizGame.findOne({ quiz: quizId, open: true }); return g ? toGame(g) : null; }
  async listGamesOfHost(hostId: string, departmentId: string) { return (await QuizGame.find({ host: hostId, department: departmentId }).sort({ createdAt: -1 }).limit(100)).map(toGame); }
  async openGames() { return (await QuizGame.find({ open: true })).map(toGame); }
  async casGame(gameId: string, expect: GameExpect, patch: GamePatch) {
    const filter: FilterQuery<unknown> = { _id: gameId };
    if (expect.status !== undefined) filter.status = Array.isArray(expect.status) ? { $in: expect.status } : expect.status;
    if (expect.questionIndex !== undefined) filter.questionIndex = expect.questionIndex;
    if (expect.closing !== undefined) filter.closing = expect.closing;
    const g = await QuizGame.findOneAndUpdate(filter, { $set: patch }, { new: true });
    return g ? toGame(g) : null;
  }

  async addPlayer(rec: NewPlayer) {
    try {
      return toPlayer(await QuizPlayer.create({ game: rec.gameId, student: rec.studentId, nickname: rec.nickname, nicknameKey: rec.nicknameKey, joinedAt: rec.joinedAt, seq: rec.seq }));
    } catch (e) {
      if (isDup(e)) throw new StoreDuplicateError((e as { keyPattern?: Record<string, unknown> }).keyPattern?.nicknameKey ? "nickname" : "student");
      throw e;
    }
  }
  async listPlayers(gameId: string) { return (await QuizPlayer.find({ game: gameId }).sort({ joinedAt: 1, seq: 1 })).map(toPlayer); }
  async getPlayerByStudent(gameId: string, studentId: string) { const p = await QuizPlayer.findOne({ game: gameId, student: studentId }); return p ? toPlayer(p) : null; }
  async getPlayer(gameId: string, playerId: string) { if (!Types.ObjectId.isValid(playerId)) return null; const p = await QuizPlayer.findOne({ _id: playerId, game: gameId }); return p ? toPlayer(p) : null; }
  async removePlayer(gameId: string, playerId: string) { return (await QuizPlayer.deleteOne({ _id: playerId, game: gameId })).deletedCount > 0; }
  async countPlayers(gameIds: string[]) {
    if (!gameIds.length) return new Map<string, number>();
    const rows = await QuizPlayer.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { game: { $in: gameIds.map((g) => new Types.ObjectId(g)) } } }, { $group: { _id: "$game", n: { $sum: 1 } } }]);
    return new Map<string, number>(rows.map((r) => [id(r._id), r.n] as [string, number]));
  }
  async openGameOfStudent(studentId: string) {
    const mine = await QuizPlayer.find({ student: studentId }).select("game");
    if (!mine.length) return null;
    const g = await QuizGame.findOne({ _id: { $in: mine.map((p) => p.game) }, open: true });
    return g ? toGame(g) : null;
  }
  async commitPlayers(gameId: string, updates: PlayerCommit[]) {
    if (!updates.length) return;
    await QuizPlayer.bulkWrite(updates.map((u) => ({ updateOne: { filter: { _id: u.id, game: gameId }, update: { $set: { score: u.score, streak: u.streak, correctCount: u.correctCount, totalCorrectMs: u.totalCorrectMs, rank: u.rank, ...(u.finalRank !== undefined ? { finalRank: u.finalRank } : {}), ...optionalNumbers(u) } } } })));
  }
  async finishedGamesOfStudent(studentId: string) {
    const mine = await QuizPlayer.find({ student: studentId });
    if (!mine.length) return [];
    const games = await QuizGame.find({ _id: { $in: mine.map((p) => p.game) }, status: "FINISHED" });
    const by = new Map(games.map((g) => [id(g._id), g]));
    return mine.filter((p) => by.has(id(p.game))).map((p) => ({ player: toPlayer(p), game: toGame(by.get(id(p.game)) as QuizGameDocument) }));
  }

  async addAnswer(rec: NewAnswer) {
    try {
      return toAnswer(await QuizAnswer.create({ game: rec.gameId, player: rec.playerId, student: rec.studentId, questionIndex: rec.questionIndex, choice: rec.choice, elapsedMs: rec.elapsedMs, correct: rec.correct, points: rec.points, streakBonus: rec.streakBonus, streakAfter: rec.streakAfter, seq: rec.seq }));
    } catch (e) { if (isDup(e)) throw new StoreDuplicateError("answer"); throw e; }
  }
  async listAnswers(gameId: string, questionIndex: number) { return (await QuizAnswer.find({ game: gameId, questionIndex })).map(toAnswer); }
  async listAnswersOfPlayer(gameId: string, playerId: string) { return (await QuizAnswer.find({ game: gameId, player: playerId }).sort({ questionIndex: 1 })).map(toAnswer); }
}
