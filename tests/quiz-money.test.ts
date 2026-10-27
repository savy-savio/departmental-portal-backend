import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { JACKPOT_MULTIPLIER, cashHeadline, formatMoney, scoreAnswer, validateQuiz, wealthTier } from "../src/services/quiz/rules";
import { quizInputSchema } from "../src/validators/quiz.validators";
import { host, makeQuizWorld, quizInput, settle, stu } from "./helpers/quiz-world";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

/* ============================ pure rules ============================ */
test("M1. Money is shown in whole dollars with thousands separators; odd input never throws", () => {
  assert.deepEqual([0, 5, 950, 1000, 12_500, 1_234_567, 999.6, -1500].map(formatMoney), ["$0", "$5", "$950", "$1,000", "$12,500", "$1,234,567", "$1,000", "-$1,500"]);
  assert.deepEqual([NaN, Infinity].map(formatMoney), ["$0", "$0"]);
});

test("M2. A JACKPOT question pays double (base and hot-streak bonus together); a normal question is unchanged", () => {
  const input = { correct: true, elapsedMs: 1000, limitMs: 10_000, previousStreak: 2 };
  assert.equal(JACKPOT_MULTIPLIER, 2);
  assert.equal(scoreAnswer(input).points, 1150); // 950 + 200
  assert.equal(scoreAnswer({ ...input, jackpot: false }).points, 1150);
  assert.equal(scoreAnswer({ ...input, jackpot: true }).points, 2300);
  // the streak bonus reported to clients is not doubled; only the total is
  assert.deepEqual([scoreAnswer({ ...input, jackpot: true }).base, scoreAnswer({ ...input, jackpot: true }).streakBonus], [950, 200]);
  // a wrong answer is worth nothing, jackpot or not, and still breaks the streak
  assert.deepEqual(scoreAnswer({ ...input, correct: false, jackpot: true }), { correct: false, elapsedMs: 1000, base: 0, streakAfter: 0, streakBonus: 0, points: 0 });
});

test("M3. Net-worth titles are judged against $1,000 a question, so they mean the same in a short and a long quiz", () => {
  const t = (score: number, n: number) => wealthTier(score, n).id;
  assert.equal(t(0, 10), "broke");
  assert.equal(t(1, 10), "pocket-change");
  assert.equal(t(1999, 10), "pocket-change");
  assert.deepEqual([2000, 4000, 6000, 8000, 10_000].map((s) => t(s, 10)), ["saving-up", "big-spender", "high-roller", "millionaire", "billionaire"]);
  assert.equal(t(3999, 10), "saving-up"); // just under the line
  // same share of the maximum = same title, whatever the length
  assert.equal(t(600, 1), t(30_000, 50));
  assert.equal(t(30_000, 50), "high-roller");
  // levels climb 0..6; negative money and an empty quiz are safe
  assert.deepEqual([0, 500, 2500, 4500, 6500, 8500, 12_000].map((s) => wealthTier(s, 10).level), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(wealthTier(-50, 10).id, "broke");
  assert.equal(wealthTier(5000, 0).id, "broke");
  assert.deepEqual(Object.keys(wealthTier(0, 3)).sort(), ["emoji", "id", "level", "title"]); // internal threshold is not leaked
});

test("M4. The cash-register headline: the biggest moment wins, and it is always the same for the same result", () => {
  const base = { answered: true, correct: true, points: 1050, streak: 1, jackpot: false, speedRank: 2 as number | null };
  assert.equal(cashHeadline(base), "💰 Cha-ching! +$1,050");
  assert.equal(cashHeadline({ ...base, speedRank: 1 }), "⚡ Fastest hands in the room! +$1,050");
  assert.equal(cashHeadline({ ...base, speedRank: 1, streak: 4 }), "🔥 4 in a row! +$1,050");
  assert.equal(cashHeadline({ ...base, speedRank: 1, streak: 4, jackpot: true, points: 2100 }), "🎰 JACKPOT! +$2,100");
  assert.equal(cashHeadline({ ...base, correct: false, points: 0, speedRank: null }), "💸 Ouch! No cash this round.");
  assert.equal(cashHeadline({ ...base, correct: false, points: 0, speedRank: null, jackpot: true }), "💥 Jackpot missed! No cash this round.");
  assert.equal(cashHeadline({ ...base, answered: false, correct: false, points: 0, speedRank: null }), "😴 Too slow! You left money on the table.");
  assert.equal(cashHeadline({ ...base, answered: false, correct: false, points: 0, speedRank: null, jackpot: true }), "😴 You slept through the JACKPOT!");
});

test("M5. A quiz can flag jackpot questions; the flag is kept only when on, and must be a true/false value", () => {
  const input = quizInput();
  input.questions[1] = { ...input.questions[1], jackpot: true };
  input.questions[2] = { ...input.questions[2], jackpot: false };
  const ok = validateQuiz(input);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.quiz.questions.map((q) => q.jackpot), [undefined, true, undefined]);
  if (ok.ok) assert.ok(!("jackpot" in ok.quiz.questions[0]) && !("jackpot" in ok.quiz.questions[2])); // older quizzes keep their exact shape
  const bad = quizInput();
  bad.questions[0] = { ...bad.questions[0], jackpot: "yes" as unknown as boolean };
  const r = validateQuiz(bad);
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual([r.violation.code, r.violation.status, r.violation.message], ["INVALID_QUIZ", 422, "Question 1: jackpot must be true or false."]);
});

test("M6. The request validator accepts the jackpot flag and still rejects anything unknown", () => {
  const q = { text: "Capital of Nigeria?", options: ["Lagos", "Abuja"], correctIndex: 1 };
  assert.equal(quizInputSchema.safeParse({ title: "Geo", questions: [{ ...q, jackpot: true }] }).success, true);
  assert.equal(quizInputSchema.safeParse({ title: "Geo", questions: [{ ...q }] }).success, true);
  assert.equal(quizInputSchema.safeParse({ title: "Geo", questions: [{ ...q, jackpot: "yes" }] }).success, false);
  assert.equal(quizInputSchema.safeParse({ title: "Geo", questions: [{ ...q, bonus: 5 }] }).success, false);
});

test("M7. The jackpot flag is saved with a quiz and snapshotted into each game (models, store and validator all carry it)", () => {
  for (const f of ["src/models/Quiz.ts", "src/models/QuizGame.ts"]) assert.match(read(f), /jackpot: \{ type: Boolean, default: false \}/, f);
  assert.match(read("src/services/quiz/mongo-store.ts"), /q\.jackpot \? \{ jackpot: true \} : \{\}/);
  assert.match(read("src/validators/quiz.validators.ts"), /jackpot: z\.boolean\(\)\.optional\(\)/);
});

/* ============================ a whole game, for money ============================ */
test("M8. A game for money: jackpot announced with the question, double pay, level-ups, headlines and money text everywhere", async () => {
  const w = makeQuizWorld();
  const input = quizInput();
  input.questions[0] = { ...input.questions[0], jackpot: true }; // question 1 is the JACKPOT
  const { game } = await w.lobby(["ada", "ben", "cy"], input);
  const id = game.gameId;
  const ans = (who: string, q: number, choice: number) => w.svc.answer(stu(who), id, { questionIndex: q, choice });
  const state = (who: string) => w.svc.getPlayerState(stu(who), id);

  // the snapshot carries the flag; the host sees it too
  assert.equal(w.store.games[0].questions[0].jackpot, true);
  assert.equal(w.store.games[0].questions[1].jackpot, undefined);
  await w.svc.start(host(), id);
  assert.equal((await state("ada")).question!.jackpot, true); // players are told, so they can feel the pressure
  assert.equal((await w.svc.getHostState(host(), id)).question!.jackpot, true);
  assert.deepEqual([(await state("ada")).me.scoreText, (await state("ada")).me.tier.id], ["$0", "broke"]);

  // Question 1 (JACKPOT, correct = 1): ada right at 1 s, ben right at 3 s, cy wrong
  await w.advance(1000); await ans("ada", 0, 1);
  await w.advance(2000); await ans("ben", 0, 1);
  await w.advance(1000); await ans("cy", 0, 0); await settle();
  let ada = await state("ada"), ben = await state("ben"), cy = await state("cy");
  assert.deepEqual([ada.reveal!.points, ada.reveal!.pointsText, ada.reveal!.scoreText, ada.reveal!.jackpot], [1900, "$1,900", "$1,900", true]); // 950 x 2
  assert.deepEqual([ben.reveal!.points, ben.reveal!.pointsText], [1700, "$1,700"]); // 850 x 2
  assert.equal(ada.reveal!.headline, "🎰 JACKPOT! +$1,900");
  assert.equal(cy.reveal!.headline, "💥 Jackpot missed! No cash this round.");
  assert.deepEqual([ada.reveal!.tier.id, ada.reveal!.levelUp?.id, ben.reveal!.tier.id, ben.reveal!.levelUp?.id], ["high-roller", "high-roller", "big-spender", "big-spender"]);
  assert.deepEqual([cy.reveal!.tier.id, cy.reveal!.levelUp, cy.reveal!.scoreText], ["broke", null, "$0"]); // no money, no level-up
  assert.deepEqual(ada.reveal!.topFive.map((r) => [r.nickname, r.score, r.scoreText, r.tier.id]), [["ADA", 1900, "$1,900", "high-roller"], ["BEN", 1700, "$1,700", "big-spender"], ["CY", 0, "$0", "broke"]]);
  const hostReveal = (await w.svc.getHostState(host(), id)).reveal!;
  assert.deepEqual([hostReveal.jackpot, hostReveal.topFive[0].scoreText], [true, "$1,900"]);

  // Question 2 (normal, correct = 0): ada and ben at 1 s (ada first), cy right at 5 s. Streak 2 pays a $100 hot-streak bonus to ada and ben.
  await w.svc.next(host(), id);
  assert.equal((await state("ada")).question!.jackpot, false);
  await w.advance(1000); await ans("ada", 1, 0); await ans("ben", 1, 0);
  await w.advance(4000); await ans("cy", 1, 0); await settle();
  ada = await state("ada"); ben = await state("ben"); cy = await state("cy");
  assert.deepEqual([ada.reveal!.points, ada.reveal!.streakBonus, ada.reveal!.scoreText, ada.reveal!.jackpot], [1050, 100, "$2,950", false]); // NOT doubled
  assert.equal(ada.reveal!.headline, "⚡ Fastest hands in the room! +$1,050");
  assert.equal(ben.reveal!.headline, "💰 Cha-ching! +$1,050");
  assert.deepEqual([ada.reveal!.tier.id, ada.reveal!.levelUp?.id], ["millionaire", "millionaire"]); // 2950 of 3000
  assert.deepEqual([ben.reveal!.scoreText, ben.reveal!.tier.id, ben.reveal!.levelUp?.id], ["$2,750", "millionaire", "millionaire"]);
  assert.deepEqual([cy.reveal!.points, cy.reveal!.scoreText, cy.reveal!.tier.id, cy.reveal!.levelUp?.id], [750, "$750", "saving-up", "saving-up"]);

  // Question 3 (normal, correct = 2): ada right at 1 s (streak 3: +$200 -> $1,150) and holds on to millionaire -> billionaire; ben wrong; cy silent
  await w.svc.next(host(), id);
  await w.advance(1000); await ans("ada", 2, 2); await ans("ben", 2, 0);
  await w.svc.endQuestion(host(), id);
  ada = await state("ada"); ben = await state("ben"); cy = await state("cy");
  assert.equal(ada.reveal!.headline, "🔥 3 in a row! +$1,150");
  assert.deepEqual([ada.reveal!.scoreText, ada.reveal!.tier.id, ada.reveal!.levelUp?.id], ["$4,100", "billionaire", "billionaire"]);
  assert.deepEqual([ben.reveal!.headline, ben.reveal!.levelUp, ben.reveal!.tier.id], ["💸 Ouch! No cash this round.", null, "millionaire"]); // money kept, nothing gained
  assert.deepEqual([cy.reveal!.headline, cy.reveal!.levelUp, cy.reveal!.pointsText], ["😴 Too slow! You left money on the table.", null, "$0"]);

  // finish: the final screens and the results carry the money too
  const fin = await w.svc.next(host(), id);
  assert.deepEqual(fin.final!.leaderboard.map((r) => [r.rank, r.nickname, r.scoreText, r.tier.title]), [[1, "ADA", "$4,100", "Billionaire"], [2, "BEN", "$2,750", "Millionaire"], [3, "CY", "$750", "Saving Up"]]);
  ada = await state("ada");
  assert.deepEqual([ada.final!.score, ada.final!.scoreText, ada.final!.tier.id, ada.final!.top[0].scoreText], [4100, "$4,100", "billionaire", "$4,100"]);
  const list = await w.svc.results(stu("ada"));
  assert.deepEqual([list[0].score, list[0].scoreText, list[0].tier.id], [4100, "$4,100", "billionaire"]);
  const one = await w.svc.result(stu("ada"), id);
  assert.deepEqual(one.questions.map((q) => [q.points, q.pointsText, q.jackpot]), [[1900, "$1,900", true], [1050, "$1,050", false], [1150, "$1,150", false]]);
});
