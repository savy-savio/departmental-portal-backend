/** Pure live-quiz rules: scoring, ranking, validation, state-machine checks. The service never duplicates these; the tests pin them. */

export const PHASES = ["LOBBY", "QUESTION", "REVEAL", "FINISHED", "CANCELLED"] as const;
export type Phase = (typeof PHASES)[number];
export const OPEN_PHASES: readonly Phase[] = ["LOBBY", "QUESTION", "REVEAL"];
export const isOpen = (p: Phase) => OPEN_PHASES.includes(p);

export const ANSWER_GRACE_MS = 1000; // an answer sent just before time ran out may arrive just after
export const IDLE_CANCEL_MS = 30 * 60_000; // no host action for this long: the game is cancelled
export const MAX_PLAYERS_PER_GAME = 500;
export const MAX_FINAL_ROWS_HOST = 50;

/** A rule violation that the service turns into an HTTP error. */
export interface Violation { status: number; code: string; message: string }
const v = (status: number, code: string, message: string): Violation => ({ status, code, message });

/* ------------------------------ scoring (4a) ------------------------------ */
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** 1000 for an instant answer down to 500 at the last moment. */
export const basePoints = (elapsedMs: number, limitMs: number) => Math.round(1000 * (1 - clamp(elapsedMs, 0, limitMs) / limitMs / 2));
/** 0, 100, 200 ... capped at 500; `streak` counts consecutive correct answers including this one. */
export const streakBonus = (streak: number) => (streak >= 1 ? Math.min(500, 100 * (streak - 1)) : 0);

export interface ScoredAnswer { correct: boolean; elapsedMs: number; base: number; streakAfter: number; streakBonus: number; points: number }
export function scoreAnswer(i: { correct: boolean; elapsedMs: number; limitMs: number; previousStreak: number }): ScoredAnswer {
  const elapsedMs = clamp(Math.round(i.elapsedMs), 0, i.limitMs);
  if (!i.correct) return { correct: false, elapsedMs, base: 0, streakAfter: 0, streakBonus: 0, points: 0 }; // wrong: no points, streak resets
  const streakAfter = Math.max(0, i.previousStreak) + 1;
  const base = basePoints(elapsedMs, i.limitMs);
  const bonus = streakBonus(streakAfter);
  return { correct: true, elapsedMs, base, streakAfter, streakBonus: bonus, points: base + bonus };
}

/* ------------------------------ ranking ------------------------------ */
export interface Rankable { id: string; score: number; totalCorrectMs: number; joinedAt: number; seq?: number }
/** Higher score; then the LOWER total time over correct answers; then the earlier join; then insertion order. Ranks are unique (1..n). */
export function rankPlayers<T extends Rankable>(players: T[]): (T & { rank: number })[] {
  return [...players]
    .sort((a, b) => b.score - a.score || a.totalCorrectMs - b.totalCorrectMs || a.joinedAt - b.joinedAt || (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id))
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

export interface TimedAnswer { playerId: string; correct: boolean; elapsedMs: number; receivedSeq: number }
/** The correct answers, fastest first (a tie goes to the one the server received first). */
export const fastestCorrect = (answers: TimedAnswer[]) =>
  answers.filter((a) => a.correct).sort((a, b) => a.elapsedMs - b.elapsedMs || a.receivedSeq - b.receivedSeq);

/** One emoji "character" as people see it: pictograph (+ skin tone / variation selector), joined sequences (family, couple...), flags, keycaps. */
const EMOJI_UNIT = String.raw`\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?`;
const EMOJI = String.raw`(?:${EMOJI_UNIT}(?:\u200D${EMOJI_UNIT})*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)`;
/** Letters (+ combining marks), numbers, spaces and . _ ' -  in any language, plus emoji. Anything else (markup, control, invisible, bidi characters) fails. */
const NICKNAME_RE = new RegExp(String.raw`^(?:[\p{L}\p{M}\p{N} ._'\-]|${EMOJI})+$`, "u");
const MAX_NICKNAME_UNITS = 120; // raw length cap, so a long joined-emoji sequence can't be abused

/** Length as a person counts it (an emoji family is 1, not 8). Falls back to code points where Intl.Segmenter is missing. */
function graphemeCount(s: string): number {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: "grapheme" }) => { segment(x: string): Iterable<unknown> } }).Segmenter;
  return Seg ? [...new Seg(undefined, { granularity: "grapheme" }).segment(s)].length : [...s].length;
}

export function validateNickname(raw: unknown): { ok: true; nickname: string; key: string } | { ok: false; violation: Violation } {
  // NFC so "e" + combining accent and the single accented letter are the same nickname (and the same uniqueness key)
  const nickname = typeof raw === "string" ? raw.normalize("NFC").replace(/\s+/g, " ").trim() : "";
  const length = graphemeCount(nickname);
  if (length < 2 || length > 20 || nickname.length > MAX_NICKNAME_UNITS || !NICKNAME_RE.test(nickname)) {
    return { ok: false, violation: v(422, "INVALID_NICKNAME", "Choose a nickname of 2 to 20 letters, numbers or emoji.") };
  }
  return { ok: true, nickname, key: nickname.toLowerCase() };
}
export const isPin = (s: unknown): s is string => typeof s === "string" && /^\d{6}$/.test(s);
export const generatePin = (randomInt: (min: number, maxExclusive: number) => number) => String(randomInt(100_000, 1_000_000));

export interface QuestionInput { text: string; options: string[]; correctIndex: number }
export interface QuizInput { title: string; secondsPerQuestion?: number; questions: QuestionInput[] }
/** Cleans and validates a quiz. Returns the trimmed version or the first problem. */
export function validateQuiz(input: QuizInput): { ok: true; quiz: Required<QuizInput> } | { ok: false; violation: Violation } {
  const bad = (m: string) => ({ ok: false as const, violation: v(422, "INVALID_QUIZ", m) });
  const title = String(input.title ?? "").trim();
  if (title.length < 3 || title.length > 100) return bad("The title must be 3 to 100 characters.");
  const seconds = input.secondsPerQuestion ?? 10;
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 60) return bad("Seconds per question must be between 5 and 60.");
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 50) return bad("A quiz needs 1 to 50 questions.");
  const questions: QuestionInput[] = [];
  for (const [i, q] of input.questions.entries()) {
    const n = i + 1;
    const text = String(q?.text ?? "").trim();
    if (text.length < 3 || text.length > 300) return bad(`Question ${n}: the text must be 3 to 300 characters.`);
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) return bad(`Question ${n}: give 2 to 4 answers.`);
    const options = q.options.map((o) => String(o ?? "").trim());
    if (options.some((o) => o.length < 1 || o.length > 100)) return bad(`Question ${n}: every answer must be 1 to 100 characters.`);
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return bad(`Question ${n}: answers must be different from each other.`);
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= options.length) return bad(`Question ${n}: mark which answer is correct.`);
    questions.push({ text, options, correctIndex: q.correctIndex });
  }
  return { ok: true, quiz: { title, secondsPerQuestion: seconds, questions } };
}

/** A rep is appointed for a level; the quiz belongs to that level's class. With several appointments, prefer the rep's own level. */
export function pickLevel(appointmentLevels: string[], studentLevel: string): string {
  const levels = [...new Set(appointmentLevels)].sort();
  if (levels.length === 1) return levels[0];
  return levels.includes(studentLevel) ? studentLevel : (levels[0] ?? studentLevel);
}

/* ------------------------------ state machine ------------------------------ */
export const checkStart = (phase: Phase, playerCount: number): Violation | null =>
  phase !== "LOBBY" ? v(409, "INVALID_STATE", "This game has already started.") : playerCount < 1 ? v(409, "INVALID_STATE", "Wait for at least one player to join.") : null;
export const checkEndQuestion = (phase: Phase): Violation | null => (phase === "QUESTION" ? null : v(409, "INVALID_STATE", "There is no question running."));
export const checkNext = (phase: Phase): Violation | null => (phase === "REVEAL" ? null : v(409, "INVALID_STATE", "Show the answer before moving on."));
export const checkCancel = (phase: Phase): Violation | null => (isOpen(phase) ? null : v(409, "INVALID_STATE", "This game is already over."));
export const checkLobbyOnly = (phase: Phase): Violation | null => (phase === "LOBBY" ? null : v(409, "INVALID_STATE", "That is only possible before the game starts."));

export interface AnswerCheck {
  phase: Phase; closing: boolean; currentIndex: number; questionStartedAtMs: number | null; limitMs: number;
  nowMs: number; questionIndex: unknown; choice: unknown; optionCount: number;
}
/** Everything the server decides about an incoming answer. The phone's clock and claimed speed are never used. */
export function checkAnswer(c: AnswerCheck): { ok: true; elapsedMs: number } | { ok: false; violation: Violation } {
  if (!Number.isInteger(c.questionIndex) || !Number.isInteger(c.choice)) return { ok: false, violation: v(422, "INVALID_ANSWER", "Send the question number and your choice.") };
  if (!isOpen(c.phase) || c.questionIndex !== c.currentIndex) return { ok: false, violation: v(409, "INVALID_STATE", "That question is not running.") };
  if (c.phase !== "QUESTION" || c.closing || c.questionStartedAtMs === null) return { ok: false, violation: v(409, "ANSWER_TOO_LATE", "Time is up for this question.") };
  if (c.nowMs > c.questionStartedAtMs + c.limitMs + ANSWER_GRACE_MS) return { ok: false, violation: v(409, "ANSWER_TOO_LATE", "Time is up for this question.") };
  if ((c.choice as number) < 0 || (c.choice as number) >= c.optionCount) return { ok: false, violation: v(422, "INVALID_CHOICE", "That is not one of the answers.") };
  return { ok: true, elapsedMs: clamp(c.nowMs - c.questionStartedAtMs, 0, c.limitMs) };
}
