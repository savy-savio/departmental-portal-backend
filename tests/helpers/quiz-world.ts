import { QuizService, type QuizHost, type QuizPlayerIdentity } from "../../src/services/quiz/quiz.service";
import type { QuizInput } from "../../src/services/quiz/rules";
import { QuizMemoryStore } from "./quiz-memory-store";

export const CSC = "d-csc", MLS = "d-mls";
export const host = (id = "rep1", dept = CSC, level = "200"): QuizHost => ({ studentId: id, departmentId: dept, name: `Rep ${id}`, level });
export const stu = (id: string, dept = CSC, level = "200"): QuizPlayerIdentity => ({ studentId: id, departmentId: dept, level });
export const settle = async () => { for (let i = 0; i < 12; i++) await new Promise<void>((r) => setImmediate(r)); };

/** A 3-question quiz: correct answers are index 1, 0 and 2. */
export const quizInput = (over: Partial<QuizInput> = {}): QuizInput => ({
  title: "Week 3 revision", secondsPerQuestion: 10,
  questions: [
    { text: "Which is a prime number?", options: ["4", "7", "9"], correctIndex: 1 },
    { text: "2 + 2 = ?", options: ["4", "5"], correctIndex: 0 },
    { text: "Capital of Nigeria?", options: ["Lagos", "Kano", "Abuja", "Ibadan"], correctIndex: 2 },
  ],
  ...over,
});

export function makeQuizWorld(opts: { pins?: number[]; emitThrows?: boolean } = {}) {
  const store = new QuizMemoryStore();
  let t = Date.parse("2026-10-20T10:00:00Z");
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 0;
  const emitted: { to: string; event: string; payload: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const pins = opts.pins ?? [111_111, 222_222, 333_333, 444_444, 555_555];
  let pi = 0;
  const warnings: unknown[][] = [];
  const svc = new QuizService({
    store, now: () => new Date(t),
    emit: (to, event, payload) => { if (opts.emitThrows) throw new Error("socket down"); emitted.push({ to, event, payload: JSON.parse(JSON.stringify(payload)) }); },
    scheduler: { setTimeout: (fn, ms) => { timers.set(++nextTimer, { at: t + ms, fn }); return nextTimer; }, clearTimeout: (h) => void timers.delete(h as number) },
    randomInt: () => pins[pi++ % pins.length], log: { warn: (...a) => void warnings.push(a) },
  });
  const world = {
    store, svc, emitted, warnings, timers,
    now: () => t,
    /** Moves the clock; due timers fire in order and the async work they start is allowed to finish. */
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = Math.max(t, due[1].at); due[1].fn(); await settle();
      }
      t = end; await settle();
    },
    eventsTo: (id: string, event?: string) => emitted.filter((e) => e.to === id && (!event || e.event === event)),
    /** rep1 writes a quiz, hosts it, and the given students join (PIN 111111). */
    async lobby(names: string[] = ["ada", "ben", "cy"], over: Partial<QuizInput> = {}) {
      const q = await svc.createQuiz(host(), quizInput(over));
      const game = await svc.hostGame(host(), q.id);
      for (const n of names) await svc.join(stu(n), { pin: game.pin, nickname: n.toUpperCase() });
      return { quiz: q, game };
    },
  };
  return world;
}
