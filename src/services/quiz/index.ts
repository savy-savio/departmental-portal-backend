import { randomInt } from "node:crypto";
import { realtime } from "../../realtime/instance";
import { logger } from "../../utils/logger";
import { MongoQuizStore } from "./mongo-store";
import { QuizService } from "./quiz.service";

/**
 * The live quiz engine. Events go to the students' personal Socket.IO rooms (the same connection the notifications use); timers are in-process.
 * server.ts calls `resume()` at startup and `sweepIdle()` every minute.
 */
export const quizService = new QuizService({
  store: new MongoQuizStore(),
  now: () => new Date(),
  emit: (studentId, event, payload) => realtime.emitToUser({ userType: "STUDENT", userId: studentId }, event, payload),
  scheduler: {
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; },
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  },
  randomInt: (min, maxExclusive) => randomInt(min, maxExclusive),
  log: logger,
});
