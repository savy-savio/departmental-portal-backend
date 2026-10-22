import type { AnswerRec, GameExpect, GamePatch, GameRec, NewAnswer, NewGame, NewPlayer, PlayerCommit, PlayerRec, QuestionInput, QuizRec } from "./types";

/**
 * Storage for the live quiz. Create methods throw StoreDuplicateError (from ../hod/store) for the unique rules:
 * "pin" (open games), "student" / "nickname" (one player per student, unique nickname per game) and "answer" (one per player per question).
 */
export interface QuizStore {
  listQuizzes(ownerId: string, departmentId: string): Promise<QuizRec[]>;
  getQuiz(ownerId: string, departmentId: string, quizId: string): Promise<QuizRec | null>;
  createQuiz(rec: { ownerId: string; departmentId: string; level: string; title: string; secondsPerQuestion: number; questions: QuestionInput[] }): Promise<QuizRec>;
  updateQuiz(ownerId: string, departmentId: string, quizId: string, patch: { title: string; secondsPerQuestion: number; questions: QuestionInput[] }): Promise<QuizRec | null>;
  deleteQuiz(ownerId: string, departmentId: string, quizId: string): Promise<boolean>;
  bumpTimesHosted(quizId: string): Promise<void>;

  createGame(rec: NewGame): Promise<GameRec>;
  getGame(gameId: string): Promise<GameRec | null>;
  openGameByPin(pin: string): Promise<GameRec | null>;
  openGameOfHost(hostId: string): Promise<GameRec | null>;
  openGameOfQuiz(quizId: string): Promise<GameRec | null>;
  listGamesOfHost(hostId: string, departmentId: string): Promise<GameRec[]>;
  openGames(): Promise<GameRec[]>;
  /** Conditional update: applies only if the game still matches `expect`. Returns the updated game, or null when nothing changed (someone else got there first). */
  casGame(gameId: string, expect: GameExpect, patch: GamePatch): Promise<GameRec | null>;

  addPlayer(rec: NewPlayer): Promise<PlayerRec>;
  listPlayers(gameId: string): Promise<PlayerRec[]>;
  getPlayerByStudent(gameId: string, studentId: string): Promise<PlayerRec | null>;
  getPlayer(gameId: string, playerId: string): Promise<PlayerRec | null>;
  removePlayer(gameId: string, playerId: string): Promise<boolean>;
  countPlayers(gameIds: string[]): Promise<Map<string, number>>;
  openGameOfStudent(studentId: string): Promise<GameRec | null>;
  commitPlayers(gameId: string, updates: PlayerCommit[]): Promise<void>;
  finishedGamesOfStudent(studentId: string): Promise<{ player: PlayerRec; game: GameRec }[]>;

  addAnswer(rec: NewAnswer): Promise<AnswerRec>;
  listAnswers(gameId: string, questionIndex: number): Promise<AnswerRec[]>;
  listAnswersOfPlayer(gameId: string, playerId: string): Promise<AnswerRec[]>;
}
