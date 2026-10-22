import { fastestCorrect, MAX_FINAL_ROWS_HOST, rankPlayers } from "./rules";
import type { AnswerRec, GameRec, HostState, LeaderRow, PlayerRec, PlayerState } from "./types";

const ranked = (players: PlayerRec[]) => rankPlayers(players.map((p) => ({ ...p, joinedAt: p.joinedAt.getTime() })));
/** Scores are only meaningful (and only shown) once at least one question has been revealed. */
const hasScores = (g: GameRec) => g.status === "REVEAL" || g.status === "FINISHED" || (g.status === "QUESTION" && g.questionIndex > 0);

function rows(list: ReturnType<typeof ranked>, limit: number, youId?: string): LeaderRow[] {
  return list.slice(0, limit).map((p) => ({ rank: p.rank, nickname: p.nickname, score: p.score, ...(youId && p.id === youId ? { you: true as const } : {}) }));
}
const endsAtOf = (g: GameRec) => new Date((g.questionStartedAt as Date).getTime() + g.secondsPerQuestion * 1000).toISOString();
const distributionOf = (optionCount: number, answers: AnswerRec[]) => { const d = new Array<number>(optionCount).fill(0); for (const a of answers) if (a.choice >= 0 && a.choice < optionCount) d[a.choice]++; return d; };
const timed = (answers: AnswerRec[]) => answers.map((a) => ({ playerId: a.playerId, correct: a.correct, elapsedMs: a.elapsedMs, receivedSeq: a.seq }));

/**
 * What ONE player sees. `answers` are the answers to the game's current question. The correct answer (and anything derived from it) is only
 * included in the REVEAL view: during the QUESTION a player gets text and options, nothing else.
 */
export function playerView(game: GameRec, players: PlayerRec[], answers: AnswerRec[], me: PlayerRec, serverTime: Date): PlayerState {
  const list = ranked(players);
  const mine = list.find((p) => p.id === me.id);
  const scored = hasScores(game);
  const state: PlayerState = {
    role: "player", gameId: game.id, title: game.title, phase: game.status, totalQuestions: game.questions.length, playerCount: players.length, serverTime: serverTime.toISOString(),
    me: { playerId: me.id, nickname: me.nickname, score: scored ? me.score : 0, rank: scored && mine ? mine.rank : null, streak: scored ? me.streak : 0 },
  };
  const q = game.questions[game.questionIndex];
  if (game.status === "QUESTION" && q) {
    state.question = { index: game.questionIndex, text: q.text, options: q.options, timeLimitSec: game.secondsPerQuestion, endsAt: endsAtOf(game), answered: answers.some((a) => a.playerId === me.id) };
  } else if (game.status === "REVEAL" && q) {
    const mineAns = answers.find((a) => a.playerId === me.id);
    const order = fastestCorrect(timed(answers));
    const names = new Map(players.map((p) => [p.id, p]));
    state.reveal = {
      questionIndex: game.questionIndex, text: q.text, options: q.options, correctIndex: q.correctIndex, yourChoice: mineAns ? mineAns.choice : null, correct: Boolean(mineAns?.correct),
      points: mineAns?.points ?? 0, streakBonus: mineAns?.streakBonus ?? 0, streak: me.streak, score: me.score, rank: mine ? mine.rank : null, topFive: rows(list, 5, me.id),
      distribution: distributionOf(q.options.length, answers), isLast: game.questionIndex === game.questions.length - 1,
      fastest: order.slice(0, 3).map((a) => ({ nickname: names.get(a.playerId)?.nickname ?? "", ms: a.elapsedMs, ...(a.playerId === me.id ? { you: true as const } : {}) })),
      yourTimeMs: mineAns ? mineAns.elapsedMs : null, yourSpeedRank: mineAns?.correct ? order.findIndex((a) => a.playerId === me.id) + 1 : null,
    };
  } else if (game.status === "FINISHED") {
    state.final = { rank: mine?.rank ?? null, score: me.score, correctCount: me.correctCount, totalQuestions: game.questions.length, playerCount: players.length, top: rows(list, 10, me.id) };
  }
  return state;
}

/** What the host sees: everything, including the correct answer during the question. */
export function hostView(game: GameRec, players: PlayerRec[], answers: AnswerRec[], serverTime: Date): HostState {
  const list = ranked(players);
  const state: HostState = {
    role: "host", gameId: game.id, quizId: game.quizId, title: game.title, pin: game.pin, phase: game.status, totalQuestions: game.questions.length, playerCount: players.length,
    serverTime: serverTime.toISOString(), players: [...players].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || a.seq - b.seq).map((p) => ({ id: p.id, nickname: p.nickname })),
  };
  const q = game.questions[game.questionIndex];
  if (game.status === "QUESTION" && q) {
    state.question = { index: game.questionIndex, text: q.text, options: q.options, timeLimitSec: game.secondsPerQuestion, endsAt: endsAtOf(game), correctIndex: q.correctIndex };
    state.answered = answers.length;
  } else if (game.status === "REVEAL" && q) {
    const names = new Map(players.map((p) => [p.id, p.nickname]));
    state.reveal = {
      questionIndex: game.questionIndex, text: q.text, options: q.options, correctIndex: q.correctIndex, distribution: distributionOf(q.options.length, answers),
      answeredCount: answers.length, topFive: rows(list, 5), isLast: game.questionIndex === game.questions.length - 1,
      fastest: fastestCorrect(timed(answers)).slice(0, 3).map((a) => ({ nickname: names.get(a.playerId) ?? "", ms: a.elapsedMs })),
    };
  } else if (game.status === "FINISHED") {
    state.final = { leaderboard: rows(list, MAX_FINAL_ROWS_HOST), playerCount: players.length };
  }
  return state;
}
export { ranked as rankedPlayers };
