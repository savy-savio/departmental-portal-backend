import { StoreDuplicateError } from "../../src/services/hod/store";
import type { QuizStore } from "../../src/services/quiz/store";
import type { AnswerRec, GameExpect, GamePatch, GameRec, NewAnswer, NewGame, NewPlayer, PlayerCommit, PlayerRec, QuestionInput, QuizRec } from "../../src/services/quiz/types";

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory QuizStore with the same uniqueness rules and conditional (compare-and-set) updates as the Mongo store. Returns copies, like a database. */
export class QuizMemoryStore implements QuizStore {
  quizzes: QuizRec[] = []; games: GameRec[] = []; players: PlayerRec[] = []; answers: AnswerRec[] = [];
  private n = 0;
  private nid = (p: string) => `${p}${++this.n}`;

  async listQuizzes(o: string, d: string) { return clone(this.quizzes.filter((q) => q.ownerId === o && q.departmentId === d).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())); }
  async getQuiz(o: string, d: string, id: string) { const q = this.quizzes.find((x) => x.id === id && x.ownerId === o && x.departmentId === d); return q ? clone(q) : null; }
  async createQuiz(r: { ownerId: string; departmentId: string; level: string; title: string; secondsPerQuestion: number; questions: QuestionInput[] }) {
    const q: QuizRec = { id: this.nid("quiz"), ...clone(r), timesHosted: 0, createdAt: new Date(1_000 + this.n), updatedAt: new Date(1_000 + this.n) };
    this.quizzes.push(q); return clone(q);
  }
  async updateQuiz(o: string, d: string, id: string, p: { title: string; secondsPerQuestion: number; questions: QuestionInput[] }) {
    const q = this.quizzes.find((x) => x.id === id && x.ownerId === o && x.departmentId === d); if (!q) return null; Object.assign(q, clone(p), { updatedAt: new Date() }); return clone(q);
  }
  async deleteQuiz(o: string, d: string, id: string) { const n = this.quizzes.length; this.quizzes = this.quizzes.filter((x) => !(x.id === id && x.ownerId === o && x.departmentId === d)); return this.quizzes.length < n; }
  async bumpTimesHosted(id: string) { const q = this.quizzes.find((x) => x.id === id); if (q) q.timesHosted++; }

  async createGame(r: NewGame) {
    if (r.open && this.games.some((g) => g.open && g.pin === r.pin)) throw new StoreDuplicateError("pin");
    const g: GameRec = { id: this.nid("game"), ...clone(r), createdAt: new Date(2_000 + this.n), finishedAt: null };
    this.games.push(g); return clone(g);
  }
  async getGame(id: string) { const g = this.games.find((x) => x.id === id); return g ? clone(g) : null; }
  async openGameByPin(pin: string) { const g = this.games.find((x) => x.open && x.pin === pin); return g ? clone(g) : null; }
  async openGameOfHost(h: string) { const g = this.games.find((x) => x.open && x.hostId === h); return g ? clone(g) : null; }
  async openGameOfQuiz(q: string) { const g = this.games.find((x) => x.open && x.quizId === q); return g ? clone(g) : null; }
  async listGamesOfHost(h: string, d: string) { return clone(this.games.filter((g) => g.hostId === h && g.departmentId === d).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())); }
  async openGames() { return clone(this.games.filter((g) => g.open)); }
  async casGame(id: string, e: GameExpect, patch: GamePatch) {
    const g = this.games.find((x) => x.id === id); if (!g) return null;
    if (e.status !== undefined && !(Array.isArray(e.status) ? e.status.includes(g.status) : g.status === e.status)) return null;
    if (e.questionIndex !== undefined && g.questionIndex !== e.questionIndex) return null;
    if (e.closing !== undefined && g.closing !== e.closing) return null;
    Object.assign(g, clone(patch)); return clone(g);
  }

  async addPlayer(r: NewPlayer) {
    if (this.players.some((p) => p.gameId === r.gameId && p.studentId === r.studentId)) throw new StoreDuplicateError("student");
    if (this.players.some((p) => p.gameId === r.gameId && p.nicknameKey === r.nicknameKey)) throw new StoreDuplicateError("nickname");
    const p: PlayerRec = { id: this.nid("pl"), ...clone(r), score: 0, streak: 0, correctCount: 0, totalCorrectMs: 0, rank: null, finalRank: null };
    this.players.push(p); return clone(p);
  }
  async listPlayers(g: string) { return clone(this.players.filter((p) => p.gameId === g).sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || a.seq - b.seq)); }
  async getPlayerByStudent(g: string, s: string) { const p = this.players.find((x) => x.gameId === g && x.studentId === s); return p ? clone(p) : null; }
  async getPlayer(g: string, id: string) { const p = this.players.find((x) => x.gameId === g && x.id === id); return p ? clone(p) : null; }
  async removePlayer(g: string, id: string) { const n = this.players.length; this.players = this.players.filter((p) => !(p.gameId === g && p.id === id)); return this.players.length < n; }
  async countPlayers(ids: string[]) { const m = new Map<string, number>(); for (const p of this.players) if (ids.includes(p.gameId)) m.set(p.gameId, (m.get(p.gameId) ?? 0) + 1); return m; }
  async openGameOfStudent(s: string) { for (const p of this.players.filter((x) => x.studentId === s)) { const g = this.games.find((x) => x.id === p.gameId && x.open); if (g) return clone(g); } return null; }
  async commitPlayers(g: string, updates: PlayerCommit[]) { for (const u of updates) { const p = this.players.find((x) => x.gameId === g && x.id === u.id); if (p) Object.assign(p, { score: u.score, streak: u.streak, correctCount: u.correctCount, totalCorrectMs: u.totalCorrectMs, rank: u.rank, ...(u.finalRank !== undefined ? { finalRank: u.finalRank } : {}) }); } }
  async finishedGamesOfStudent(s: string) {
    return this.players.filter((p) => p.studentId === s).flatMap((p) => { const g = this.games.find((x) => x.id === p.gameId && x.status === "FINISHED"); return g ? [{ player: clone(p), game: clone(g) }] : []; });
  }

  async addAnswer(r: NewAnswer) {
    if (this.answers.some((a) => a.gameId === r.gameId && a.playerId === r.playerId && a.questionIndex === r.questionIndex)) throw new StoreDuplicateError("answer");
    const a: AnswerRec = { id: this.nid("ans"), ...clone(r) }; this.answers.push(a); return clone(a);
  }
  async listAnswers(g: string, q: number) { return clone(this.answers.filter((a) => a.gameId === g && a.questionIndex === q)); }
  async listAnswersOfPlayer(g: string, p: string) { return clone(this.answers.filter((a) => a.gameId === g && a.playerId === p).sort((a, b) => a.questionIndex - b.questionIndex)); }
}
