import { z } from "zod";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

/** Mirrors the service's rules (title 3-100, 1-50 questions, 2-4 answers, one correct); the service re-checks, this gives early, strict 422s. */
const question = z.object({
  text: z.string().trim().min(3).max(300),
  options: z.array(z.string().trim().min(1).max(100)).min(2).max(4),
  correctIndex: z.number().int().min(0).max(3),
}).strict();
export const quizInputSchema = z.object({
  title: z.string().trim().min(3).max(100),
  secondsPerQuestion: z.number().int().min(5).max(60).optional(),
  questions: z.array(question).min(1).max(50),
}).strict();

export const quizIdParams = z.object({ id: objectId }).strict();
export const gameIdParams = z.object({ gameId: objectId }).strict();
export const gamePlayerParams = z.object({ gameId: objectId, playerId: objectId }).strict();

/** Students: a 6-digit PIN and a nickname. Identity, department and level come from the token. */
export const joinSchema = z.object({ pin: z.string().trim().regex(/^\d{6}$/, "The PIN is 6 digits"), nickname: z.string().min(1).max(200) }).strict(); // the service counts visible characters (2-20) and caps the raw length
export const answerSchema = z.object({ questionIndex: z.number().int().min(0).max(49), choice: z.number().int().min(0).max(3) }).strict();
