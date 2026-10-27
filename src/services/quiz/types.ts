import type { Phase, QuestionInput, QuestionType, WealthTier } from "./rules";

export type { Phase, QuestionInput, QuestionType, WealthTier };
export interface QuizRec { id: string; ownerId: string; departmentId: string; level: string; title: string; secondsPerQuestion: number; questions: QuestionInput[]; timesHosted: number; createdAt: Date; updatedAt: Date }
export interface GameRec {
  id: string; quizId: string; title: string; secondsPerQuestion: number; questions: QuestionInput[];
  hostId: string; hostName: string; departmentId: string; level: string; pin: string;
  status: Phase; open: boolean; questionIndex: number; questionStartedAt: Date | null; closing: boolean;
  lastHostActionAt: Date; createdAt: Date; finishedAt: Date | null;
}
export type NewGame = Omit<GameRec, "id" | "createdAt" | "finishedAt">;
export interface PlayerRec {
  id: string; gameId: string; studentId: string; nickname: string; nicknameKey: string; score: number; streak: number; correctCount: number;
  totalCorrectMs: number; rank: number | null; finalRank: number | null; joinedAt: Date; seq: number;
  /** Which question was paid out last (-1 = none yet) and what its cash drop did to this player (+ stole, - was robbed), for the reveal screen. */
  lastQuestion: number; lastDrop: number;
}
export type NewPlayer = Omit<PlayerRec, "id" | "score" | "streak" | "correctCount" | "totalCorrectMs" | "rank" | "finalRank" | "lastQuestion" | "lastDrop">;
export interface AnswerRec { id: string; gameId: string; playerId: string; studentId: string; questionIndex: number; choice: number; elapsedMs: number; correct: boolean; points: number; streakBonus: number; streakAfter: number; seq: number }
export type NewAnswer = Omit<AnswerRec, "id">;
export interface PlayerCommit {
  id: string; score: number; streak: number; correctCount: number; totalCorrectMs: number; rank: number; finalRank?: number;
  lastQuestion?: number; lastDrop?: number;
}
export type GameExpect = { status?: Phase | Phase[]; questionIndex?: number; closing?: boolean };
export type GamePatch = Partial<Pick<GameRec, "status" | "open" | "questionIndex" | "questionStartedAt" | "closing" | "lastHostActionAt" | "finishedAt">>;

/* ---- what clients receive (the app's contract) ---- */
/** `score` is the player's money in whole dollars; `scoreText` is the same, ready to show ("$12,500"); `tier` is their net-worth title. */
export type LeaderRow = { rank: number; nickname: string; score: number; scoreText: string; tier: WealthTier; you?: true };
/** A cash drop: the fastest correct player stole `amount` from the leader. `message` is written for whoever is reading it. */
export interface CashDropView { amount: number; amountText: string; thief: { nickname: string; you?: true }; victim: { nickname: string; you?: true }; message: string }

export interface PlayerState {
  role: "player"; gameId: string; title: string; phase: Phase; totalQuestions: number; playerCount: number; serverTime: string;
  me: { playerId: string; nickname: string; score: number; scoreText: string; tier: WealthTier; rank: number | null; streak: number };
  question?: { index: number; type: QuestionType; text: string; options: string[]; timeLimitSec: number; endsAt: string; answered: boolean; jackpot: boolean };
  reveal?: {
    questionIndex: number; text: string; options: string[]; correctIndex: number; yourChoice: number | null; correct: boolean; points: number; streakBonus: number;
    streak: number; score: number; rank: number | null; topFive: LeaderRow[]; distribution: number[]; isLast: boolean;
    /** Money view of this question's result. `headline` is the cash-register line; `levelUp` is set when this answer lifted the player into a new net-worth title. */
    pointsText: string; scoreText: string; jackpot: boolean; headline: string; tier: WealthTier; levelUp: WealthTier | null; levelDown: WealthTier | null;
    /** Everything that happened to this player's money on this question: the answer and any cash drop together. */
    change: number; changeText: string;
    type: QuestionType; cashDrop: CashDropView | null;
    fastest: { nickname: string; ms: number; you?: true }[]; yourTimeMs: number | null; yourSpeedRank: number | null;
  };
  final?: { rank: number | null; score: number; scoreText: string; tier: WealthTier; correctCount: number; totalQuestions: number; playerCount: number; top: LeaderRow[] };
}
export interface HostState {
  role: "host"; gameId: string; quizId: string; title: string; pin: string; phase: Phase; totalQuestions: number; playerCount: number; serverTime: string;
  players: { id: string; nickname: string }[];
  question?: { index: number; type: QuestionType; text: string; options: string[]; timeLimitSec: number; endsAt: string; correctIndex: number; jackpot: boolean };
  answered?: number;
  reveal?: { questionIndex: number; type: QuestionType; text: string; options: string[]; correctIndex: number; jackpot: boolean; cashDrop: CashDropView | null; distribution: number[]; answeredCount: number; topFive: LeaderRow[]; isLast: boolean; fastest: { nickname: string; ms: number }[] };
  final?: { leaderboard: LeaderRow[]; playerCount: number };
}
