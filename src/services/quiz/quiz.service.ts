import { AppError } from "../../utils/AppError";
import { StoreDuplicateError } from "../hod/store";
import {
  ANSWER_GRACE_MS, checkAnswer, checkCancel, checkEndQuestion, checkLobbyOnly, checkNext, checkStart, generatePin, IDLE_CANCEL_MS, isOpen, isPin, MAX_PLAYERS_PER_GAME,
  rankPlayers, scoreAnswer, validateNickname, validateQuiz, type QuizInput, type Violation,
} from "./rules";
import type { QuizStore } from "./store";
import type { AnswerRec, GameRec, HostState, PlayerRec, PlayerState } from "./types";
import { hostView, playerView } from "./views";

export interface QuizDeps {
  store: QuizStore;
  now: () => Date;
  /** Delivers an event to one student's open sessions (Socket.IO). Never throws into the caller. */
  emit: (studentId: string, event: string, payload: unknown) => void;
  scheduler: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  randomInt: (min: number, maxExclusive: number) => number;
  log?: { warn: (...a: unknown[]) => void };
}
/** The rep running things. Identity and level come from the token and the appointment, never from the request. */
export interface QuizHost { studentId: string; departmentId: string; name: string; level: string }
/** A student playing. */
export interface QuizPlayerIdentity { studentId: string; departmentId: string; level: string }

const fail = (v: Violation): never => { throw new AppError(v.status, v.message, undefined, v.code); };
const gameNotFound = () => new AppError(404, "Game not found.", undefined, "GAME_NOT_FOUND");
const PROGRESS_MIN_INTERVAL_MS = 250;

/**
 * Live quiz engine. The SERVER owns the clock, the phase and the scores; phones only display what they are sent.
 *  - Every phase change is a conditional update (compare-and-set), so a timer, "everyone answered" and the host pressing a button can race
 *    and still produce exactly one reveal / one next question.
 *  - Players never receive the correct answer (or anything derived from it) before the reveal.
 *  - A host only ever reaches their own quizzes and games; a player only games of their own department and level.
 * Timers live in this process: run one instance (or sticky sessions + the Socket.IO Redis adapter) and call `resume()` at startup.
 */
export class QuizService {
  private timers = new Map<string, unknown>();
  private progress = new Map<string, { timer?: unknown; dirty: boolean }>();
  private counter = 0;
  constructor(private readonly d: QuizDeps) {}

  /* ============================== quizzes (host) ============================== */
  private quizDTO(q: { id: string; title: string; secondsPerQuestion: number; questions: { text: string; options: string[]; correctIndex: number }[]; createdAt: Date; updatedAt: Date }) {
    return { id: q.id, title: q.title, secondsPerQuestion: q.secondsPerQuestion, questions: q.questions, createdAt: q.createdAt, updatedAt: q.updatedAt };
  }
  async listQuizzes(host: QuizHost) {
    return (await this.d.store.listQuizzes(host.studentId, host.departmentId)).map((q) => ({
      id: q.id, title: q.title, questionCount: q.questions.length, secondsPerQuestion: q.secondsPerQuestion, timesHosted: q.timesHosted, createdAt: q.createdAt, updatedAt: q.updatedAt,
    }));
  }
  async createQuiz(host: QuizHost, input: QuizInput) {
    const v = validateQuiz(input);
    if (!v.ok) return fail(v.violation);
    const q = await this.d.store.createQuiz({ ownerId: host.studentId, departmentId: host.departmentId, level: host.level, ...v.quiz });
    return this.quizDTO(q);
  }
  private async ownQuiz(host: QuizHost, id: string) {
    return (await this.d.store.getQuiz(host.studentId, host.departmentId, id)) ?? fail({ status: 404, code: "QUIZ_NOT_FOUND", message: "Quiz not found." });
  }
  async getQuiz(host: QuizHost, id: string) { return this.quizDTO(await this.ownQuiz(host, id)); }
  async updateQuiz(host: QuizHost, id: string, input: QuizInput) {
    await this.ownQuiz(host, id);
    const v = validateQuiz(input);
    if (!v.ok) return fail(v.violation);
    const q = await this.d.store.updateQuiz(host.studentId, host.departmentId, id, v.quiz);
    return q ? this.quizDTO(q) : fail({ status: 404, code: "QUIZ_NOT_FOUND", message: "Quiz not found." });
  }
  async deleteQuiz(host: QuizHost, id: string) {
    await this.ownQuiz(host, id);
    if (await this.d.store.openGameOfQuiz(id)) throw new AppError(409, "A game of this quiz is still running.", undefined, "GAME_IN_PROGRESS");
    await this.d.store.deleteQuiz(host.studentId, host.departmentId, id); // finished games keep their own snapshot and results
  }

  /* ============================== state + delivery ============================== */
  private async load(gameId: string) { return (await this.d.store.getGame(gameId)) ?? (() => { throw gameNotFound(); })(); }
  private async snapshot(game: GameRec) {
    const [players, answers] = await Promise.all([
      this.d.store.listPlayers(game.id),
      game.status === "QUESTION" || game.status === "REVEAL" ? this.d.store.listAnswers(game.id, game.questionIndex) : Promise.resolve([] as AnswerRec[]),
    ]);
    return { players, answers };
  }
  private async hostState(game: GameRec): Promise<HostState> { const s = await this.snapshot(game); return hostView(game, s.players, s.answers, this.d.now()); }
  private async playerState(game: GameRec, me: PlayerRec): Promise<PlayerState> { const s = await this.snapshot(game); return playerView(game, s.players, s.answers, me, this.d.now()); }

  private send(studentId: string, event: string, payload: unknown) {
    try { this.d.emit(studentId, event, payload); } catch (err) { this.d.log?.warn("Quiz emit failed:", err instanceof Error ? err.message : err); }
  }
  /** Pushes the host's state and each player's own state (same shape as the GET endpoints). Delivery problems never affect the game. */
  private async broadcast(gameId: string) {
    try {
      const game = await this.d.store.getGame(gameId);
      if (!game) return;
      const s = await this.snapshot(game);
      const at = this.d.now();
      this.send(game.hostId, "quiz:state", hostView(game, s.players, s.answers, at));
      for (const p of s.players) this.send(p.studentId, "quiz:state", playerView(game, s.players, s.answers, p, at));
    } catch (err) { this.d.log?.warn("Quiz broadcast failed:", err instanceof Error ? err.message : err); }
  }
  private async lobbyChanged(gameId: string) {
    const game = await this.d.store.getGame(gameId);
    if (!game) return;
    const players = await this.d.store.listPlayers(gameId);
    this.send(game.hostId, "quiz:state", hostView(game, players, [], this.d.now()));
    for (const p of players) this.send(p.studentId, "quiz:lobby", { gameId, count: players.length }); // cheap: no names
  }
  /** At most ~4 progress events a second per game, always ending with the latest count. */
  private progressChanged(gameId: string, hostId: string) {
    const emitNow = async () => {
      const game = await this.d.store.getGame(gameId);
      if (!game || game.status !== "QUESTION") return;
      const [players, answers] = await Promise.all([this.d.store.listPlayers(gameId), this.d.store.listAnswers(gameId, game.questionIndex)]);
      this.send(hostId, "quiz:progress", { gameId, questionIndex: game.questionIndex, answered: answers.length, total: players.length });
    };
    const slot = this.progress.get(gameId);
    if (slot?.timer) { slot.dirty = true; return; }
    void emitNow();
    const entry: { timer?: unknown; dirty: boolean } = { dirty: false };
    entry.timer = this.d.scheduler.setTimeout(() => { entry.timer = undefined; if (entry.dirty) { entry.dirty = false; void emitNow(); } }, PROGRESS_MIN_INTERVAL_MS);
    this.progress.set(gameId, entry);
  }

  /* ============================== hosting ============================== */
  private async ownGame(host: QuizHost, gameId: string): Promise<GameRec> {
    const g = await this.d.store.getGame(gameId);
    if (!g || g.hostId !== host.studentId || g.departmentId !== host.departmentId) throw gameNotFound(); // someone else's game looks like a missing one
    return g;
  }
  private touch(gameId: string) { return this.d.store.casGame(gameId, {}, { lastHostActionAt: this.d.now() }); }

  async hostGame(host: QuizHost, quizId: string): Promise<HostState> {
    const quiz = await this.ownQuiz(host, quizId);
    if (await this.d.store.openGameOfHost(host.studentId)) throw new AppError(409, "You already have a game running. Finish or cancel it first.", undefined, "GAME_IN_PROGRESS");
    for (let attempt = 0; attempt < 10; attempt++) {
      const pin = generatePin(this.d.randomInt);
      if (await this.d.store.openGameByPin(pin)) continue;
      try {
        const game = await this.d.store.createGame({
          quizId: quiz.id, title: quiz.title, secondsPerQuestion: quiz.secondsPerQuestion, questions: quiz.questions, // snapshot: later edits don't touch this game
          hostId: host.studentId, hostName: host.name, departmentId: host.departmentId, level: quiz.level, pin, status: "LOBBY", open: true,
          questionIndex: -1, questionStartedAt: null, closing: false, lastHostActionAt: this.d.now(),
        });
        await this.d.store.bumpTimesHosted(quiz.id);
        return this.hostState(game);
      } catch (e) {
        if (e instanceof StoreDuplicateError) { if (await this.d.store.openGameOfHost(host.studentId)) throw new AppError(409, "You already have a game running.", undefined, "GAME_IN_PROGRESS"); continue; } // PIN raced: try another
        throw e;
      }
    }
    throw new AppError(503, "Couldn't create a game PIN. Please try again.", undefined, "PIN_UNAVAILABLE");
  }
  async listGames(host: QuizHost) {
    const games = await this.d.store.listGamesOfHost(host.studentId, host.departmentId);
    const counts = await this.d.store.countPlayers(games.map((g) => g.id));
    return games.map((g) => ({ id: g.id, title: g.title, status: g.status, pin: g.open ? g.pin : null, playerCount: counts.get(g.id) ?? 0, createdAt: g.createdAt, finishedAt: g.finishedAt }));
  }
  async getHostState(host: QuizHost, gameId: string) { return this.hostState(await this.ownGame(host, gameId)); }

  async start(host: QuizHost, gameId: string) {
    const g = await this.ownGame(host, gameId);
    const players = await this.d.store.listPlayers(gameId);
    const v = checkStart(g.status, players.length);
    if (v) return fail(v);
    const next = await this.d.store.casGame(gameId, { status: "LOBBY" }, { status: "QUESTION", questionIndex: 0, questionStartedAt: this.d.now(), closing: false, lastHostActionAt: this.d.now() });
    if (!next) return fail({ status: 409, code: "INVALID_STATE", message: "This game has already started." });
    this.armTimer(next);
    await this.broadcast(gameId);
    return this.hostState(next);
  }
  async endQuestion(host: QuizHost, gameId: string) {
    const g = await this.ownGame(host, gameId);
    const v = checkEndQuestion(g.status);
    if (v) return fail(v);
    await this.touch(gameId);
    if (!(await this.closeQuestion(gameId, g.questionIndex))) {
      const now = await this.load(gameId);
      if (now.status !== "REVEAL" && now.questionIndex === g.questionIndex) return fail({ status: 409, code: "INVALID_STATE", message: "There is no question running." });
    }
    return this.hostState(await this.load(gameId));
  }
  async next(host: QuizHost, gameId: string) {
    const g = await this.ownGame(host, gameId);
    const v = checkNext(g.status);
    if (v) return fail(v);
    const last = g.questionIndex >= g.questions.length - 1;
    let next: GameRec | null;
    if (!last) {
      next = await this.d.store.casGame(gameId, { status: "REVEAL", questionIndex: g.questionIndex }, { status: "QUESTION", questionIndex: g.questionIndex + 1, questionStartedAt: this.d.now(), closing: false, lastHostActionAt: this.d.now() });
      if (next) this.armTimer(next);
    } else {
      next = await this.d.store.casGame(gameId, { status: "REVEAL", questionIndex: g.questionIndex }, { status: "FINISHED", open: false, finishedAt: this.d.now(), lastHostActionAt: this.d.now() });
      if (next) await this.fixFinalRanks(gameId);
    }
    if (!next) return fail({ status: 409, code: "INVALID_STATE", message: "Show the answer before moving on." }); // a double click: the first one already moved on
    await this.broadcast(gameId);
    return this.hostState(next);
  }
  async cancel(host: QuizHost, gameId: string) {
    const g = await this.ownGame(host, gameId);
    const v = checkCancel(g.status);
    if (v) return fail(v);
    const next = await this.d.store.casGame(gameId, { status: ["LOBBY", "QUESTION", "REVEAL"] }, { status: "CANCELLED", open: false, closing: false, finishedAt: this.d.now() });
    if (!next) return fail({ status: 409, code: "INVALID_STATE", message: "This game is already over." });
    this.clearTimer(gameId);
    await this.broadcast(gameId);
    return this.hostState(next);
  }
  async kick(host: QuizHost, gameId: string, playerId: string) {
    const g = await this.ownGame(host, gameId);
    const v = checkLobbyOnly(g.status);
    if (v) return fail(v);
    const p = await this.d.store.getPlayer(gameId, playerId);
    if (!p) throw new AppError(404, "Player not found.", undefined, "NOT_FOUND");
    await this.d.store.removePlayer(gameId, playerId);
    await this.touch(gameId);
    this.send(p.studentId, "quiz:state", playerView({ ...g, status: "CANCELLED" }, [], [], p, this.d.now())); // the removed student's screen ends
    await this.lobbyChanged(gameId);
  }

  /* ============================== the clock ============================== */
  private armTimer(g: GameRec) {
    this.clearTimer(g.id);
    if (g.status !== "QUESTION" || !g.questionStartedAt) return;
    // The reveal comes after the answer grace period, so an answer sent just before time ran out is not lost to a slow network.
    const delay = Math.max(0, g.questionStartedAt.getTime() + g.secondsPerQuestion * 1000 + ANSWER_GRACE_MS - this.d.now().getTime());
    const index = g.questionIndex;
    this.timers.set(g.id, this.d.scheduler.setTimeout(() => { this.timers.delete(g.id); void this.closeQuestion(g.id, index); }, delay));
  }
  private clearTimer(gameId: string) { const t = this.timers.get(gameId); if (t !== undefined) { this.d.scheduler.clearTimeout(t); this.timers.delete(gameId); } }

  /**
   * QUESTION -> REVEAL, exactly once. The timer, "all answered" and the host button all call this; the first to claim it (closing = true) does the work,
   * the others return false. Scores are applied here, at the reveal, so nobody can read their result off a score change before time is up.
   */
  async closeQuestion(gameId: string, index: number): Promise<boolean> {
    const claimed = await this.d.store.casGame(gameId, { status: "QUESTION", questionIndex: index, closing: false }, { closing: true });
    if (!claimed) return false;
    this.clearTimer(gameId);
    try {
      const [players, answers] = await Promise.all([this.d.store.listPlayers(gameId), this.d.store.listAnswers(gameId, index)]);
      const byPlayer = new Map(answers.map((a) => [a.playerId, a]));
      const updated = players.map((p) => {
        const a = byPlayer.get(p.id);
        if (!a) return { ...p, streak: 0 }; // no answer: the streak resets
        return { ...p, score: p.score + a.points, streak: a.streakAfter, correctCount: p.correctCount + (a.correct ? 1 : 0), totalCorrectMs: p.totalCorrectMs + (a.correct ? a.elapsedMs : 0) };
      });
      const ranks = new Map(rankPlayers(updated.map((p) => ({ ...p, joinedAt: p.joinedAt.getTime() }))).map((p) => [p.id, p.rank]));
      await this.d.store.commitPlayers(gameId, updated.map((p) => ({ id: p.id, score: p.score, streak: p.streak, correctCount: p.correctCount, totalCorrectMs: p.totalCorrectMs, rank: ranks.get(p.id) as number })));
      await this.d.store.casGame(gameId, { status: "QUESTION", questionIndex: index, closing: true }, { status: "REVEAL", closing: false });
    } catch (err) {
      await this.d.store.casGame(gameId, { status: "QUESTION", questionIndex: index, closing: true }, { closing: false }).catch(() => undefined); // let the timer / host retry
      this.d.log?.warn("Closing a quiz question failed:", err instanceof Error ? err.message : err);
      return false;
    }
    await this.broadcast(gameId);
    return true;
  }
  private async fixFinalRanks(gameId: string) {
    const players = await this.d.store.listPlayers(gameId);
    const ranks = rankPlayers(players.map((p) => ({ ...p, joinedAt: p.joinedAt.getTime() })));
    await this.d.store.commitPlayers(gameId, ranks.map((p) => ({ id: p.id, score: p.score, streak: p.streak, correctCount: p.correctCount, totalCorrectMs: p.totalCorrectMs, rank: p.rank, finalRank: p.rank })));
  }

  /* ============================== players ============================== */
  private eligible(me: QuizPlayerIdentity, g: GameRec) {
    if (g.departmentId !== me.departmentId || g.level !== me.level) throw new AppError(403, "This game is for another class.", undefined, "NOT_ELIGIBLE");
  }
  private async myPlayer(me: QuizPlayerIdentity, gameId: string): Promise<{ game: GameRec; player: PlayerRec }> {
    const game = await this.d.store.getGame(gameId);
    const player = game ? await this.d.store.getPlayerByStudent(gameId, me.studentId) : null;
    // Not a player (or not even a game): the same answer, so game ids can't be probed. A removed student also lands here.
    if (!game || !player || game.departmentId !== me.departmentId) throw new AppError(403, "You are not in this game.", undefined, "NOT_ELIGIBLE");
    return { game, player };
  }

  async join(me: QuizPlayerIdentity, input: { pin: string; nickname: string }): Promise<PlayerState> {
    if (!isPin(input.pin)) throw new AppError(404, "No game found with that PIN.", undefined, "PIN_NOT_FOUND");
    const game = await this.d.store.openGameByPin(input.pin);
    if (!game) throw new AppError(404, "No game found with that PIN.", undefined, "PIN_NOT_FOUND");
    this.eligible(me, game); // wrong department / level
    if (game.hostId === me.studentId) throw new AppError(403, "You are hosting this game.", undefined, "NOT_ELIGIBLE");
    const existing = await this.d.store.getPlayerByStudent(game.id, me.studentId);
    if (existing) return this.playerState(game, existing); // the same student coming back gets their player back, in any phase
    if (game.status !== "LOBBY") throw new AppError(409, "This game has already started.", undefined, "GAME_ALREADY_STARTED");
    const nick = validateNickname(input.nickname);
    if (!nick.ok) return fail(nick.violation);
    const other = await this.d.store.openGameOfStudent(me.studentId);
    if (other && other.id !== game.id) throw new AppError(409, "You are already in another game. Leave it first.", undefined, "ALREADY_IN_GAME");
    if ((await this.d.store.countPlayers([game.id])).get(game.id)! >= MAX_PLAYERS_PER_GAME) throw new AppError(409, "This game is full.", undefined, "GAME_FULL");
    let player: PlayerRec;
    try {
      const at = this.d.now();
      player = await this.d.store.addPlayer({ gameId: game.id, studentId: me.studentId, nickname: nick.nickname, nicknameKey: nick.key, joinedAt: at, seq: ++this.counter });
    } catch (e) {
      if (e instanceof StoreDuplicateError) {
        if (e.message.includes("nickname")) throw new AppError(409, "That nickname is taken. Try another.", undefined, "NICKNAME_TAKEN");
        const again = await this.d.store.getPlayerByStudent(game.id, me.studentId); // two taps at once: return the first one
        if (again) return this.playerState(game, again);
      }
      throw e;
    }
    await this.lobbyChanged(game.id);
    return this.playerState(game, player);
  }
  async active(me: QuizPlayerIdentity): Promise<PlayerState | null> {
    const game = await this.d.store.openGameOfStudent(me.studentId);
    if (!game) return null;
    const player = await this.d.store.getPlayerByStudent(game.id, me.studentId);
    return player ? this.playerState(game, player) : null;
  }
  async getPlayerState(me: QuizPlayerIdentity, gameId: string) { const { game, player } = await this.myPlayer(me, gameId); return this.playerState(game, player); }

  /** Takes the answer and says only "accepted": correctness is revealed with the rest of the question's result. */
  async answer(me: QuizPlayerIdentity, gameId: string, input: { questionIndex: number; choice: number }) {
    const { game, player } = await this.myPlayer(me, gameId);
    const q = game.questions[game.questionIndex];
    const verdict = checkAnswer({
      phase: game.status, closing: game.closing, currentIndex: game.questionIndex, questionStartedAtMs: game.questionStartedAt ? game.questionStartedAt.getTime() : null,
      limitMs: game.secondsPerQuestion * 1000, nowMs: this.d.now().getTime(), questionIndex: input.questionIndex, choice: input.choice, optionCount: q ? q.options.length : 0,
    });
    if (!verdict.ok) return fail(verdict.violation);
    const scored = scoreAnswer({ correct: input.choice === q.correctIndex, elapsedMs: verdict.elapsedMs, limitMs: game.secondsPerQuestion * 1000, previousStreak: player.streak });
    try {
      await this.d.store.addAnswer({
        gameId, playerId: player.id, studentId: me.studentId, questionIndex: game.questionIndex, choice: input.choice, elapsedMs: scored.elapsedMs, correct: scored.correct,
        points: scored.points, streakBonus: scored.streakBonus, streakAfter: scored.streakAfter, seq: ++this.counter,
      });
    } catch (e) {
      if (e instanceof StoreDuplicateError) throw new AppError(409, "You have already answered this question.", undefined, "ALREADY_ANSWERED");
      throw e;
    }
    this.progressChanged(gameId, game.hostId);
    const [players, answers] = await Promise.all([this.d.store.listPlayers(gameId), this.d.store.listAnswers(gameId, game.questionIndex)]);
    if (answers.length >= players.length) void this.closeQuestion(gameId, game.questionIndex); // everyone has answered: no need to wait
    return { accepted: true as const };
  }
  async leave(me: QuizPlayerIdentity, gameId: string) {
    const { game, player } = await this.myPlayer(me, gameId);
    const v = checkLobbyOnly(game.status);
    if (v) return fail(v);
    await this.d.store.removePlayer(gameId, player.id);
    await this.lobbyChanged(gameId);
  }

  /* ============================== results ============================== */
  async results(me: QuizPlayerIdentity) {
    const rows = await this.d.store.finishedGamesOfStudent(me.studentId);
    const counts = await this.d.store.countPlayers(rows.map((r) => r.game.id));
    return rows.sort((a, b) => (b.game.finishedAt?.getTime() ?? 0) - (a.game.finishedAt?.getTime() ?? 0)).map(({ player, game }) => this.resultSummary(game, player, counts.get(game.id) ?? 0));
  }
  private resultSummary(game: GameRec, player: PlayerRec, playerCount: number) {
    return { gameId: game.id, title: game.title, playedAt: game.finishedAt ?? game.createdAt, rank: player.finalRank, playerCount, score: player.score, correctCount: player.correctCount, totalQuestions: game.questions.length };
  }
  async result(me: QuizPlayerIdentity, gameId: string) {
    const { game, player } = await this.myPlayer(me, gameId);
    if (game.status !== "FINISHED") throw new AppError(409, "The results are available when the game is finished.", undefined, "INVALID_STATE");
    const [players, answers] = await Promise.all([this.d.store.listPlayers(gameId), this.d.store.listAnswersOfPlayer(gameId, player.id)]);
    const view = playerView(game, players, [], player, this.d.now());
    const byQ = new Map(answers.map((a) => [a.questionIndex, a]));
    return {
      ...this.resultSummary(game, player, players.length), top: view.final?.top ?? [],
      questions: game.questions.map((q, index) => {
        const a = byQ.get(index);
        return { index, text: q.text, options: q.options, correctIndex: q.correctIndex, yourChoice: a ? a.choice : null, correct: Boolean(a?.correct), points: a?.points ?? 0 };
      }),
    };
  }

  /* ============================== housekeeping ============================== */
  /** Server (re)start: games survive in the database, so re-arm the clock of any question that is running. */
  async resume() {
    for (const g of await this.d.store.openGames()) {
      if (g.status === "QUESTION") {
        if (g.closing) await this.d.store.casGame(g.id, { status: "QUESTION", questionIndex: g.questionIndex, closing: true }, { closing: false }); // interrupted mid-reveal: redo it
        this.armTimer({ ...g, closing: false });
      }
    }
  }
  /** Cancels games the host abandoned (no host action for IDLE_CANCEL_MS). Call it every minute or so. */
  async sweepIdle(): Promise<number> {
    const cutoff = this.d.now().getTime() - IDLE_CANCEL_MS;
    let n = 0;
    for (const g of await this.d.store.openGames()) {
      if (!isOpen(g.status) || g.lastHostActionAt.getTime() > cutoff) continue;
      const done = await this.d.store.casGame(g.id, { status: ["LOBBY", "QUESTION", "REVEAL"] }, { status: "CANCELLED", open: false, closing: false, finishedAt: this.d.now() });
      if (done) { n++; this.clearTimer(g.id); await this.broadcast(g.id); }
    }
    return n;
  }
}
