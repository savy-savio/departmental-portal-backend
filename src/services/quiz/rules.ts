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
// The quiz plays for MONEY: every "point" is one dollar, so a lightning-fast correct answer is worth $1,000. Stored numbers stay plain integers
// (score, points, streakBonus); `formatMoney` is how they are shown.
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** $1,000 for an instant answer down to $500 at the last moment. */
export const basePoints = (elapsedMs: number, limitMs: number) => Math.round(1000 * (1 - clamp(elapsedMs, 0, limitMs) / limitMs / 2));
/** The "hot streak" bonus: $0, $100, $200 ... capped at $500; `streak` counts consecutive correct answers including this one. */
export const streakBonus = (streak: number) => (streak >= 1 ? Math.min(500, 100 * (streak - 1)) : 0);
/** A JACKPOT question (flagged by the host) pays double: base and hot-streak bonus together. */
export const JACKPOT_MULTIPLIER = 2;

export interface ScoredAnswer { correct: boolean; elapsedMs: number; base: number; streakAfter: number; streakBonus: number; points: number }
export function scoreAnswer(i: { correct: boolean; elapsedMs: number; limitMs: number; previousStreak: number; jackpot?: boolean }): ScoredAnswer {
  const elapsedMs = clamp(Math.round(i.elapsedMs), 0, i.limitMs);
  if (!i.correct) return { correct: false, elapsedMs, base: 0, streakAfter: 0, streakBonus: 0, points: 0 }; // wrong: no money, streak resets
  const streakAfter = Math.max(0, i.previousStreak) + 1;
  const base = basePoints(elapsedMs, i.limitMs);
  const bonus = streakBonus(streakAfter);
  return { correct: true, elapsedMs, base, streakAfter, streakBonus: bonus, points: (base + bonus) * (i.jackpot ? JACKPOT_MULTIPLIER : 1) };
}

/* ------------------------------ money display ------------------------------ */
/** 12500 -> "$12,500". Whole dollars only; never throws on odd input. */
export function formatMoney(amount: number): string {
  const n = Math.round(Number.isFinite(amount) ? amount : 0);
  return `${n < 0 ? "-" : ""}$${String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** A change of money with its sign: +$1,050, -$500, $0. */
export function formatChange(amount: number): string {
  const n = Math.round(Number.isFinite(amount) ? amount : 0);
  return n > 0 ? `+${formatMoney(n)}` : formatMoney(n);
}

/** A player's "net worth" title. It is judged against the most a game could pay without bonuses ($1,000 a question), so it means the same in a 5-question quiz and a 50-question one, and players level up as the game goes on. */
export interface WealthTier { level: number; id: string; title: string; emoji: string }
const WEALTH_TIERS: (WealthTier & { from: number })[] = [
  { from: 0, level: 0, id: "broke", title: "Broke", emoji: "🪙" },
  { from: 0.000001, level: 1, id: "pocket-change", title: "Pocket Change", emoji: "💵" },
  { from: 0.2, level: 2, id: "saving-up", title: "Saving Up", emoji: "🐷" },
  { from: 0.4, level: 3, id: "big-spender", title: "Big Spender", emoji: "🛍️" },
  { from: 0.6, level: 4, id: "high-roller", title: "High Roller", emoji: "🎩" },
  { from: 0.8, level: 5, id: "millionaire", title: "Millionaire", emoji: "💎" },
  { from: 1, level: 6, id: "billionaire", title: "Billionaire", emoji: "👑" },
];
export function wealthTier(score: number, totalQuestions: number): WealthTier {
  const ratio = totalQuestions > 0 ? Math.max(0, score) / (totalQuestions * 1000) : 0;
  let hit = WEALTH_TIERS[0];
  for (const t of WEALTH_TIERS) if (ratio >= t.from) hit = t;
  const { level, id, title, emoji } = hit;
  return { level, id, title, emoji };
}

/** The one-line "cash register" message shown after each question. Deterministic, so the same result always reads the same. */
export function cashHeadline(i: { answered: boolean; correct: boolean; points: number; streak: number; jackpot: boolean; speedRank: number | null }): string {
  const money = formatMoney(i.points);
  if (!i.answered) return i.jackpot ? "😴 You slept through the JACKPOT!" : "😴 Too slow! You left money on the table.";
  if (!i.correct) return i.jackpot ? "💥 Jackpot missed! No cash this round." : "💸 Ouch! No cash this round.";
  if (i.jackpot) return `🎰 JACKPOT! +${money}`;
  if (i.streak >= 3) return `🔥 ${i.streak} in a row! +${money}`;
  if (i.speedRank === 1) return `⚡ Fastest hands in the room! +${money}`;
  return `💰 Cha-ching! +${money}`;
}

/* ------------------------------ cash drops ------------------------------ */
// After a question is paid out, the player who answered correctly FASTEST steals a small slice of the leader's cash. Nobody is robbed when the
// fastest player is the leader, when nobody was right, or when the leader has too little for a $10 slice. The money moves; none is created.
export const CASH_DROP_PERCENT = 5; // % of the leader's cash
export const CASH_DROP_CAP = 500; // never more than this
export const CASH_DROP_STEP = 10; // in whole tens, so the amounts read cleanly
export const dropAmount = (leaderCash: number) =>
  Math.min(CASH_DROP_CAP, Math.floor((Math.max(0, Math.floor(leaderCash)) * CASH_DROP_PERCENT) / (100 * CASH_DROP_STEP)) * CASH_DROP_STEP);

/** The line that tells everyone about a cash drop, from the point of view of whoever is reading it. */
export function cashDropMessage(role: "THIEF" | "VICTIM" | "OTHER", thief: string, victim: string, amount: number): string {
  const m = formatMoney(amount);
  if (role === "THIEF") return `🦹 You stole ${m} from the leader, ${victim}!`;
  if (role === "VICTIM") return `😱 ${thief} stole ${m} from you!`;
  return `🦹 ${thief} stole ${m} from the leader, ${victim}!`;
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

/* ------------------------------ paying out a question ------------------------------ */
export interface SettlePlayer extends Rankable {
  streak: number; correctCount: number; totalCorrectMs: number;
  /** Which question was paid out last (-1: none yet) and what its cash drop did to this player (+ stole, - was robbed), for the reveal screen. */
  lastQuestion: number; lastDrop: number;
}
export interface SettleAnswer { playerId: string; correct: boolean; elapsedMs: number; points: number; streakAfter: number; receivedSeq: number }
export interface Settlement {
  id: string; score: number; streak: number; correctCount: number; totalCorrectMs: number; rank: number;
  lastQuestion: number; lastDrop: number;
}
export interface CashDrop { thiefId: string; victimId: string; amount: number }

/**
 * Everything that happens to the money when a question closes, in this order: (1) each answer pays its points, (2) the fastest correct player
 * may steal from the leader, (3) ranks are fixed. Pure: no clock, no storage.
 *
 * A player who is already marked as settled for this question (an earlier attempt got part-way before a restart) is left exactly as stored, and
 * no cash drop is made on a retry, so nobody is ever paid twice.
 */
export function settleQuestion(players: SettlePlayer[], answers: SettleAnswer[], questionIndex: number): { players: Settlement[]; drop: CashDrop | null } {
  const byPlayer = new Map(answers.map((a) => [a.playerId, a]));
  const retry = players.some((p) => p.lastQuestion === questionIndex);

  const rows = players.map((p) => {
    if (p.lastQuestion === questionIndex) return { ...p, drop: p.lastDrop }; // already paid
    const a = byPlayer.get(p.id);
    if (!a) return { ...p, streak: 0, drop: 0 }; // no answer: the streak resets
    return {
      ...p, score: p.score + a.points, streak: a.streakAfter, correctCount: p.correctCount + (a.correct ? 1 : 0),
      totalCorrectMs: p.totalCorrectMs + (a.correct ? a.elapsedMs : 0), drop: 0,
    };
  });

  let drop: CashDrop | null = null;
  if (!retry && rows.length >= 2) {
    const leader = rankPlayers(rows)[0];
    const thief = fastestCorrect(answers)[0];
    if (thief && thief.playerId !== leader.id) {
      const amount = dropAmount(leader.score);
      const from = rows.find((r) => r.id === leader.id);
      const to = rows.find((r) => r.id === thief.playerId);
      if (amount > 0 && from && to) {
        from.score -= amount; from.drop = -amount;
        to.score += amount; to.drop = amount;
        drop = { thiefId: to.id, victimId: from.id, amount };
      }
    }
  }

  const ranks = new Map(rankPlayers(rows).map((r) => [r.id, r.rank]));
  return {
    drop,
    players: rows.map((r) => ({
      id: r.id, score: r.score, streak: r.streak, correctCount: r.correctCount, totalCorrectMs: r.totalCorrectMs, rank: ranks.get(r.id) as number,
      lastQuestion: questionIndex, lastDrop: r.drop,
    })),
  };
}

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

export const QUESTION_TYPES = ["MULTIPLE_CHOICE", "TRUE_FALSE"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
/** A true/false question always has exactly these two answers, in this order: index 0 is True, index 1 is False. */
export const TRUE_FALSE_OPTIONS = ["True", "False"] as const;
/** What clients are told. Older questions have no stored type: they are multiple choice. */
export const questionTypeOf = (q: { type?: QuestionType }): QuestionType => q.type ?? "MULTIPLE_CHOICE";

/** A stored question. `jackpot` (double money) and `type: "TRUE_FALSE"` are omitted when off, so older quizzes look exactly as before. */
export interface QuestionInput { text: string; options: string[]; correctIndex: number; jackpot?: boolean; type?: QuestionType }
/** What a host may send: a true/false question does not need `options` (they are always True and False). */
export type QuestionDraft = Omit<QuestionInput, "options"> & { options?: string[] };
export interface QuizInput { title: string; secondsPerQuestion?: number; questions: QuestionDraft[] }
export interface ValidQuiz { title: string; secondsPerQuestion: number; questions: QuestionInput[] }
/** Cleans and validates a quiz. Returns the trimmed version or the first problem. */
export function validateQuiz(input: QuizInput): { ok: true; quiz: ValidQuiz } | { ok: false; violation: Violation } {
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
    const type = q?.type ?? "MULTIPLE_CHOICE";
    if (!(QUESTION_TYPES as readonly unknown[]).includes(type)) return bad(`Question ${n}: the type must be MULTIPLE_CHOICE or TRUE_FALSE.`);
    let options: string[];
    if (type === "TRUE_FALSE") {
      // The two answers are fixed. A host may leave them out; if they are sent they must be exactly True then False, so index 0 always means True.
      if (q.options !== undefined && !(Array.isArray(q.options) && q.options.length === 0)) {
        const given = Array.isArray(q.options) ? q.options.map((o) => String(o ?? "").trim().toLowerCase()) : [];
        if (given.length !== 2 || given[0] !== "true" || given[1] !== "false") return bad(`Question ${n}: a true/false question has the two answers True and False, in that order.`);
      }
      options = [...TRUE_FALSE_OPTIONS];
      if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 1) return bad(`Question ${n}: mark whether the statement is True or False.`);
    } else {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) return bad(`Question ${n}: give 2 to 4 answers.`);
      options = q.options.map((o) => String(o ?? "").trim());
      if (options.some((o) => o.length < 1 || o.length > 100)) return bad(`Question ${n}: every answer must be 1 to 100 characters.`);
      if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return bad(`Question ${n}: answers must be different from each other.`);
      if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= options.length) return bad(`Question ${n}: mark which answer is correct.`);
    }
    if (q.jackpot !== undefined && typeof q.jackpot !== "boolean") return bad(`Question ${n}: jackpot must be true or false.`);
    questions.push({ text, options, correctIndex: q.correctIndex, ...(type === "TRUE_FALSE" ? { type: "TRUE_FALSE" as const } : {}), ...(q.jackpot === true ? { jackpot: true } : {}) });
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
