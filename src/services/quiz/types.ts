import type { Phase, QuestionInput } from "./rules";

export type { Phase, QuestionInput };
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
}
export type NewPlayer = Omit<PlayerRec, "id" | "score" | "streak" | "correctCount" | "totalCorrectMs" | "rank" | "finalRank">;
export interface AnswerRec { id: string; gameId: string; playerId: string; studentId: string; questionIndex: number; choice: number; elapsedMs: number; correct: boolean; points: number; streakBonus: number; streakAfter: number; seq: number }
export type NewAnswer = Omit<AnswerRec, "id">;
export interface PlayerCommit { id: string; score: number; streak: number; correctCount: number; totalCorrectMs: number; rank: number; finalRank?: number }
export type GameExpect = { status?: Phase | Phase[]; questionIndex?: number; closing?: boolean };
export type GamePatch = Partial<Pick<GameRec, "status" | "open" | "questionIndex" | "questionStartedAt" | "closing" | "lastHostActionAt" | "finishedAt">>;

/* ---- what clients receive (the app's contract) ---- */
export type LeaderRow = { rank: number; nickname: string; score: number; you?: true };
export interface PlayerState {
  role: "player"; gameId: string; title: string; phase: Phase; totalQuestions: number; playerCount: number; serverTime: string;
  me: { playerId: string; nickname: string; score: number; rank: number | null; streak: number };
  question?: { index: number; text: string; options: string[]; timeLimitSec: number; endsAt: string; answered: boolean };
  reveal?: {
    questionIndex: number; text: string; options: string[]; correctIndex: number; yourChoice: number | null; correct: boolean; points: number; streakBonus: number;
    streak: number; score: number; rank: number | null; topFive: LeaderRow[]; distribution: number[]; isLast: boolean;
    fastest: { nickname: string; ms: number; you?: true }[]; yourTimeMs: number | null; yourSpeedRank: number | null;
  };
  final?: { rank: number | null; score: number; correctCount: number; totalQuestions: number; playerCount: number; top: LeaderRow[] };
}
export interface HostState {
  role: "host"; gameId: string; quizId: string; title: string; pin: string; phase: Phase; totalQuestions: number; playerCount: number; serverTime: string;
  players: { id: string; nickname: string }[];
  question?: { index: number; text: string; options: string[]; timeLimitSec: number; endsAt: string; correctIndex: number };
  answered?: number;
  reveal?: { questionIndex: number; text: string; options: string[]; correctIndex: number; distribution: number[]; answeredCount: number; topFive: LeaderRow[]; isLast: boolean; fastest: { nickname: string; ms: number }[] };
  final?: { leaderboard: LeaderRow[]; playerCount: number };
}
