import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CASH_DROP_CAP, cashDropMessage, dropAmount, formatChange, settleQuestion, validateQuiz, type QuizInput, type SettleAnswer, type SettlePlayer } from "../src/services/quiz/rules";
import { quizInputSchema } from "../src/validators/quiz.validators";
import { MLS, host, makeQuizWorld, quizInput, settle, stu } from "./helpers/quiz-world";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
async function rejection(p: Promise<unknown>): Promise<{ status: number; code?: string; message: string }> {
  try { await p; } catch (e) { const x = e as { statusCode?: number; code?: string; message: string }; return { status: x.statusCode ?? 0, code: x.code, message: x.message }; }
  throw new Error("Expected a rejection");
}

/* ============================ pure rules: cash drops ============================ */
test("B1. A cash drop is 5% of the leader's cash, in whole tens, never more than $500, and nothing below $200", () => {
  assert.equal(CASH_DROP_CAP, 500);
  assert.deepEqual([0, 100, 199, 200, 209, 210, 950, 1900, 1999, 4000, 10_000, 50_000, 1_000_000].map(dropAmount), [0, 0, 0, 10, 10, 10, 40, 90, 90, 200, 500, 500, 500]);
  assert.deepEqual([-100, NaN, Infinity].map((n) => dropAmount(n)).slice(0, 1), [0]); // negative cash is never robbed
});

test("B2. Money changes are shown with their sign", () => {
  assert.deepEqual([1050, -500, 0, 1, 1_234_567].map(formatChange), ["+$1,050", "-$500", "$0", "+$1", "+$1,234,567"]);
  assert.equal(formatChange(NaN), "$0");
});

const sp = (id: string, score: number, over: Partial<SettlePlayer> = {}): SettlePlayer => ({
  id, score, streak: 0, correctCount: 0, totalCorrectMs: 0, joinedAt: Number(id.replace(/\D/g, "")), seq: 0, lastQuestion: -1, lastDrop: 0, ...over,
});
const sa = (playerId: string, correct: boolean, elapsedMs: number, points: number, receivedSeq = 1): SettleAnswer => ({ playerId, correct, elapsedMs, points, streakAfter: correct ? 1 : 0, receivedSeq });
const get = (r: ReturnType<typeof settleQuestion>, id: string) => r.players.find((p) => p.id === id)!;
const total = (ps: { score: number }[]) => ps.reduce((n, p) => n + p.score, 0);

test("B4. Cash drop: the fastest correct player steals from the leader; the money moves, none is created", () => {
  const players = [sp("p1", 2000), sp("p2", 500)];
  const r = settleQuestion(players, [sa("p1", false, 900, 0), sa("p2", true, 1000, 950)], 1);
  assert.deepEqual(r.drop, { thiefId: "p2", victimId: "p1", amount: 100 }); // 5% of the leader's $2,000
  assert.deepEqual([get(r, "p1").score, get(r, "p1").lastDrop, get(r, "p1").rank], [1900, -100, 1]);
  assert.deepEqual([get(r, "p2").score, get(r, "p2").lastDrop, get(r, "p2").rank, get(r, "p2").correctCount, get(r, "p2").totalCorrectMs], [1550, 100, 2, 1, 1000]);
  assert.equal(total(r.players), 2000 + 500 + 950); // conserved: only the answer's prize entered the game
  assert.ok(r.players.every((p) => p.lastQuestion === 1));
});

test("B5. Cash drop: no robbery when the fastest is the leader, when nobody was right, when the leader has too little, or with one player", () => {
  // the fastest correct player IS the leader
  let r = settleQuestion([sp("p1", 2000), sp("p2", 500)], [sa("p1", true, 500, 950), sa("p2", true, 1500, 900)], 1);
  assert.equal(r.drop, null); assert.deepEqual(r.players.map((p) => p.lastDrop), [0, 0]);
  // nobody was right
  r = settleQuestion([sp("p1", 2000), sp("p2", 500)], [sa("p1", false, 500, 0), sa("p2", false, 600, 0)], 1);
  assert.equal(r.drop, null);
  // the leader has less than $200 (5% would be under $10)
  r = settleQuestion([sp("p1", 150), sp("p2", 0)], [sa("p2", true, 500, 100)], 1);
  assert.equal(r.drop, null); assert.equal(get(r, "p1").score, 150);
  // a single player has nobody to rob
  r = settleQuestion([sp("p1", 2000)], [sa("p1", true, 500, 950)], 1);
  assert.equal(r.drop, null); assert.equal(get(r, "p1").score, 2950);
  // nobody answered at all
  assert.equal(settleQuestion([sp("p1", 2000), sp("p2", 500)], [], 1).drop, null);
});

test("B6. Cash drop: the amount is capped at $500; a tie for fastest goes to whoever the server received first", () => {
  let r = settleQuestion([sp("p1", 100_000), sp("p2", 0)], [sa("p2", true, 500, 950)], 1);
  assert.equal(r.drop?.amount, 500);
  assert.deepEqual([get(r, "p1").score, get(r, "p2").score], [99_500, 1450]);
  r = settleQuestion([sp("p1", 3000), sp("p2", 0), sp("p3", 0)], [sa("p3", true, 700, 900, 2), sa("p2", true, 700, 900, 1)], 1);
  assert.equal(r.drop?.thiefId, "p2"); // same time, p2's answer arrived first
  assert.equal(r.drop?.amount, 150);
});

test("B9. Paying out the same question twice never pays twice: a player already settled for it is left exactly as stored, and no drop is made on a retry", () => {
  const settled = sp("p1", 1900, { lastQuestion: 1, lastDrop: -100 }); // an earlier attempt already got to p1
  const r = settleQuestion([settled, sp("p2", 500)], [sa("p1", false, 900, 0), sa("p2", true, 1000, 950)], 1);
  assert.equal(r.drop, null);
  assert.deepEqual([get(r, "p1").score, get(r, "p1").lastDrop], [1900, -100]); // untouched, not paid again
  assert.equal(get(r, "p2").score, 1450); // the one that was missed is paid now
});

test("B7. Cash drop messages are written for whoever is reading them", () => {
  assert.equal(cashDropMessage("THIEF", "CY", "ADA", 180), "🦹 You stole $180 from the leader, ADA!");
  assert.equal(cashDropMessage("VICTIM", "CY", "ADA", 180), "😱 CY stole $180 from you!");
  assert.equal(cashDropMessage("OTHER", "CY", "ADA", 180), "🦹 CY stole $180 from the leader, ADA!");
});

/* ============================ true / false questions ============================ */
const withQ = (...qs: QuizInput["questions"]): QuizInput => ({ title: "Facts", secondsPerQuestion: 10, questions: qs });

test("T1. A true/false question needs no answers: they are always True then False, and the type is kept only when it is true/false", () => {
  const ok = validateQuiz(withQ(
    { text: "The sun is a star.", type: "TRUE_FALSE", correctIndex: 0 },
    { text: "Water boils at 50 C at sea level.", type: "TRUE_FALSE", options: [" true ", "FALSE"], correctIndex: 1, jackpot: true },
    { text: "2 + 2 = ?", type: "MULTIPLE_CHOICE", options: ["4", "5"], correctIndex: 0 },
    { text: "Capital of Nigeria?", options: ["Lagos", "Abuja"], correctIndex: 1 },
  ));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.quiz.questions, [
    { text: "The sun is a star.", options: ["True", "False"], correctIndex: 0, type: "TRUE_FALSE" },
    { text: "Water boils at 50 C at sea level.", options: ["True", "False"], correctIndex: 1, type: "TRUE_FALSE", jackpot: true },
    { text: "2 + 2 = ?", options: ["4", "5"], correctIndex: 0 }, // multiple choice keeps its old shape
    { text: "Capital of Nigeria?", options: ["Lagos", "Abuja"], correctIndex: 1 },
  ]);
  // an empty list of answers is the same as leaving them out
  assert.equal(validateQuiz(withQ({ text: "The sun is a star.", type: "TRUE_FALSE", options: [], correctIndex: 0 })).ok, true);
});

test("T2. A bad true/false question is refused with a clear message", () => {
  const msg = (q: QuizInput["questions"][number]) => { const r = validateQuiz(withQ(q)); return r.ok ? "OK" : `${r.violation.status} ${r.violation.code} ${r.violation.message}`; };
  const base = { text: "The sun is a star.", type: "TRUE_FALSE" as const };
  assert.equal(msg({ ...base, options: ["False", "True"], correctIndex: 0 }), "422 INVALID_QUIZ Question 1: a true/false question has the two answers True and False, in that order.");
  assert.equal(msg({ ...base, options: ["Yes", "No"], correctIndex: 0 }), "422 INVALID_QUIZ Question 1: a true/false question has the two answers True and False, in that order.");
  assert.equal(msg({ ...base, options: ["True", "False", "Maybe"], correctIndex: 0 }), "422 INVALID_QUIZ Question 1: a true/false question has the two answers True and False, in that order.");
  assert.equal(msg({ ...base, correctIndex: 2 }), "422 INVALID_QUIZ Question 1: mark whether the statement is True or False.");
  assert.equal(msg({ ...base, correctIndex: -1 }), "422 INVALID_QUIZ Question 1: mark whether the statement is True or False.");
  assert.equal(msg({ ...base, type: "ESSAY" as never, correctIndex: 0 }), "422 INVALID_QUIZ Question 1: the type must be MULTIPLE_CHOICE or TRUE_FALSE.");
  assert.equal(msg({ text: "Pick one", correctIndex: 0 }), "422 INVALID_QUIZ Question 1: give 2 to 4 answers."); // multiple choice still needs its answers
  assert.equal(msg({ text: "ab", type: "TRUE_FALSE", correctIndex: 0 }), "422 INVALID_QUIZ Question 1: the text must be 3 to 300 characters.");
});

test("T3. The request validator: true/false needs no answers, and unknown fields are still refused", () => {
  const tf = { text: "The sun is a star.", type: "TRUE_FALSE", correctIndex: 1 };
  const parse = (q: unknown) => quizInputSchema.safeParse({ title: "Facts", questions: [q] }).success;
  assert.equal(parse(tf), true);
  assert.equal(parse({ ...tf, options: ["True", "False"] }), true);
  assert.equal(parse({ ...tf, correctIndex: 2 }), false);
  assert.equal(parse({ ...tf, type: "ESSAY" }), false);
  assert.equal(parse({ text: "Pick one", correctIndex: 0 }), false); // multiple choice without answers
  assert.equal(parse({ text: "Pick one", options: ["a"], correctIndex: 0 }), false);
  assert.equal(parse({ text: "Pick one", options: ["a", "b"], correctIndex: 0 }), true);
  assert.equal(parse({ ...tf, extra: 1 }), false);
});

/* ============================ wiring and persistence ============================ */
test("W1. The question type is saved by the models and the Mongo store, and the last-payout fields exist on the player", () => {
  for (const f of ["src/models/Quiz.ts", "src/models/QuizGame.ts"]) assert.match(read(f), /enum: \["MULTIPLE_CHOICE", "TRUE_FALSE"\]/, f);
  assert.match(read("src/services/quiz/mongo-store.ts"), /q\.type === "TRUE_FALSE"/);
  for (const f of ["lastQuestion", "lastDrop"]) assert.match(read("src/models/QuizPlayer.ts"), new RegExp(`${f}: \\{ type: Number`), f);
});

test("W2. The in-memory store used by the tests has every method the real store interface has (so the tests can't drift from production)", () => {
  const iface = read("src/services/quiz/store.ts").replace(/\/\*[\s\S]*?\*\//g, "");
  const methods = [...iface.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]);
  assert.ok(methods.length > 25 && methods.includes("commitPlayers"));
  for (const f of ["src/services/quiz/mongo-store.ts", "tests/helpers/quiz-memory-store.ts"]) {
    const src = read(f);
    for (const m of methods) assert.ok(new RegExp(`async ${m}\\(`).test(src), `${f} is missing ${m}`);
  }
});

/* ============================ a whole game with a cash drop ============================ */
test("G1. A game with a cash drop: paid by the server, and every screen tells the story", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada", "ben", "cy"]); // questions: right answers are 1, 0, 2
  const id = game.gameId;
  const ans = (who: string, q: number, choice: number) => w.svc.answer(stu(who), id, { questionIndex: q, choice });
  const state = (who: string) => w.svc.getPlayerState(stu(who), id);
  await w.svc.start(host(), id);

  // Question 1: ada right at 1 s ($950), ben right at 3 s ($850), cy wrong. Ada is fastest AND the leader, so nobody is robbed.
  await w.advance(1000); await ans("ada", 0, 1);
  await w.advance(2000); await ans("ben", 0, 1);
  await w.advance(1000); await ans("cy", 0, 0); await settle();
  let ada = await state("ada"), ben = await state("ben"), cy = await state("cy");
  assert.deepEqual([ada.me.score, ben.me.score, cy.me.score], [950, 850, 0]);
  assert.deepEqual([ada.reveal!.cashDrop, ben.reveal!.cashDrop, (await w.svc.getHostState(host(), id)).reveal!.cashDrop], [null, null, null]);

  // Question 2 (right = 0): ada right at 1 s (streak 2: +$100), ben wrong, cy right at 5 s. Ada is still the fastest and the leader: no drop.
  await w.svc.next(host(), id);
  await w.advance(1000); await ans("ada", 1, 0); await ans("ben", 1, 1);
  await w.advance(4000); await ans("cy", 1, 0); await settle();
  ada = await state("ada"); cy = await state("cy");
  assert.deepEqual([ada.me.score, (await state("ben")).me.score, cy.me.score], [2000, 850, 750]);
  assert.equal(ada.reveal!.cashDrop, null);

  // Question 3 (right = 2): cy right at 1 s (streak 2), ada right at 2 s (streak 3), ben wrong. Cy is fastest but not the leader: CASH DROP.
  await w.svc.next(host(), id);
  await w.advance(1000); await ans("cy", 2, 2);
  await w.advance(1000); await ans("ada", 2, 2); await ans("ben", 2, 0); await settle();
  ada = await state("ada"); ben = await state("ben"); cy = await state("cy");
  // before the drop: ada 2000+1100 = 3100, cy 750+1050 = 1800. The leader loses 5% of 3100 = $155 -> $150.
  assert.deepEqual([ada.me.score, cy.me.score, ben.me.score], [2950, 1950, 850]);
  assert.deepEqual([ada.reveal!.cashDrop!.amount, ada.reveal!.cashDrop!.amountText], [150, "$150"]);
  assert.deepEqual([ada.reveal!.cashDrop!.thief, ada.reveal!.cashDrop!.victim], [{ nickname: "CY" }, { nickname: "ADA", you: true }]);
  assert.equal(ada.reveal!.cashDrop!.message, "😱 CY stole $150 from you!");
  assert.equal(cy.reveal!.cashDrop!.message, "🦹 You stole $150 from the leader, ADA!");
  assert.deepEqual([cy.reveal!.cashDrop!.thief, cy.reveal!.cashDrop!.victim], [{ nickname: "CY", you: true }, { nickname: "ADA" }]);
  assert.equal(ben.reveal!.cashDrop!.message, "🦹 CY stole $150 from the leader, ADA!");
  assert.deepEqual([ada.reveal!.change, ada.reveal!.changeText, cy.reveal!.change, cy.reveal!.changeText, ben.reveal!.change], [950, "+$950", 1200, "+$1,200", 0]); // answer and drop together
  assert.deepEqual([ada.reveal!.points, cy.reveal!.points], [1100, 1050]); // the answer's own prize is unchanged by the drop
  assert.equal(cy.reveal!.headline, "⚡ Fastest hands in the room! +$1,050");
  assert.equal(ada.reveal!.headline, "🔥 3 in a row! +$1,100");
  assert.deepEqual([ada.reveal!.levelUp?.id, ada.reveal!.levelDown, cy.reveal!.levelUp?.id], ["millionaire", null, "high-roller"]);
  assert.deepEqual(ada.reveal!.topFive.map((r) => [r.nickname, r.scoreText]), [["ADA", "$2,950"], ["CY", "$1,950"], ["BEN", "$850"]]);
  const hostReveal = (await w.svc.getHostState(host(), id)).reveal!;
  assert.deepEqual([hostReveal.cashDrop!.message, hostReveal.cashDrop!.amountText], ["🦹 CY stole $150 from the leader, ADA!", "$150"]);
  // a drop only moves money: the three questions' prizes (950+850 + 1050+750 + 1050+1100 = 5750) are all the money there is
  assert.equal(w.store.players.reduce((n, p) => n + p.score, 0), 5750);
  const fin = await w.svc.next(host(), id);
  assert.deepEqual(fin.final!.leaderboard.map((r) => [r.rank, r.nickname, r.scoreText]), [[1, "ADA", "$2,950"], [2, "CY", "$1,950"], [3, "BEN", "$850"]]);
});

test("G2. A robbery can cost the leader their title, and the thief is lifted", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada", "ben"]);
  const id = game.gameId;
  w.store.players.find((p) => p.nickname === "ADA")!.score = 2410; // a leader just above the Millionaire line (80% of $3,000)
  await w.svc.start(host(), id);
  await w.advance(1000); await w.svc.answer(stu("ben"), id, { questionIndex: 0, choice: 1 }); await w.svc.answer(stu("ada"), id, { questionIndex: 0, choice: 0 }); await settle();
  const ada = await w.svc.getPlayerState(stu("ada"), id), ben = await w.svc.getPlayerState(stu("ben"), id);
  assert.deepEqual([ada.me.score, ben.me.score], [2290, 1070]); // ben: $950 prize + $120 (5% of $2,410, in tens)
  assert.deepEqual([ada.reveal!.change, ada.reveal!.changeText, ada.reveal!.headline], [-120, "-$120", "💸 Ouch! No cash this round."]);
  assert.deepEqual([ada.reveal!.levelUp, ada.reveal!.levelDown?.id, ada.reveal!.tier.id], [null, "high-roller", "high-roller"]); // demoted from millionaire
  assert.deepEqual([ben.reveal!.levelUp?.id, ben.reveal!.levelDown], ["saving-up", null]);
});

/* ============================ a true/false game ============================ */
test("G4. True/false in play: two big answers, no answer leak, wrong choices refused, and the type reaches every screen", async () => {
  const w = makeQuizWorld();
  const input = withQ(
    { text: "The sun is a star.", type: "TRUE_FALSE", correctIndex: 0 },
    { text: "Water boils at 50 C at sea level.", type: "TRUE_FALSE", correctIndex: 1, jackpot: true },
  );
  const { quiz, game } = await w.lobby(["ada", "ben", "cy"], input);
  const id = game.gameId;
  const ans = (who: string, q: number, choice: number) => w.svc.answer(stu(who), id, { questionIndex: q, choice });
  const state = (who: string) => w.svc.getPlayerState(stu(who), id);

  // the host sees the saved question with its fixed answers
  assert.deepEqual((await w.svc.getQuiz(host(), quiz.id)).questions[0], { text: "The sun is a star.", options: ["True", "False"], correctIndex: 0, type: "TRUE_FALSE" });
  assert.equal(w.store.games[0].questions[1].type, "TRUE_FALSE"); // snapshotted into the game
  assert.equal(w.store.games[0].questions[1].jackpot, true); // and it can be a jackpot too

  await w.svc.start(host(), id);
  const q = (await state("ada")).question!;
  assert.deepEqual([q.type, q.options, q.jackpot], ["TRUE_FALSE", ["True", "False"], false]);
  assert.ok(!("correctIndex" in q)); // the answer is not sent to phones
  assert.deepEqual([(await w.svc.getHostState(host(), id)).question!.type, (await w.svc.getHostState(host(), id)).question!.correctIndex], ["TRUE_FALSE", 0]);
  await w.advance(1000); await ans("ada", 0, 0);
  assert.equal((await rejection(ans("cy", 0, 2))).code, "INVALID_CHOICE"); // there is no third answer
  assert.equal((await rejection(ans("cy", 0, -1))).code, "INVALID_CHOICE");
  await ans("ben", 0, 1); await ans("cy", 0, 0); await settle();
  let ada = await state("ada"); const ben = await state("ben");
  assert.deepEqual([ada.reveal!.type, ada.reveal!.options, ada.reveal!.correctIndex, ada.reveal!.correct, ben.reveal!.correct, ben.reveal!.yourChoice], ["TRUE_FALSE", ["True", "False"], 0, true, false, 1]);
  assert.equal((await w.svc.getHostState(host(), id)).reveal!.type, "TRUE_FALSE");

  // question 2: a true/false JACKPOT (right = False) pays double
  await w.svc.next(host(), id);
  assert.deepEqual([(await state("ada")).question!.type, (await state("ada")).question!.jackpot], ["TRUE_FALSE", true]);
  await w.advance(1000); await ans("ada", 1, 1); await ans("ben", 1, 0); await ans("cy", 1, 1); await settle();
  ada = await state("ada");
  assert.deepEqual([ada.reveal!.jackpot, ada.reveal!.points], [true, 2100]); // (950 base + 100 streak bonus) x 2
  const fin = await w.svc.next(host(), id);
  assert.equal(fin.phase, "FINISHED");
  const review = await w.svc.result(stu("ada"), id);
  assert.deepEqual(review.questions.map((x) => [x.type, x.options, x.jackpot]), [["TRUE_FALSE", ["True", "False"], false], ["TRUE_FALSE", ["True", "False"], true]]);
});

test("G5. Quizzes saved before true/false and bets existed play exactly as before", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada", "ben"], { questions: quizInput().questions.map((q) => ({ text: q.text, options: q.options, correctIndex: q.correctIndex })) });
  assert.ok(w.store.games[0].questions.every((q) => !("type" in q) && !("jackpot" in q)));
  await w.svc.start(host(), game.gameId);
  assert.equal((await w.svc.getPlayerState(stu("ada"), game.gameId)).question!.type, "MULTIPLE_CHOICE"); // clients are always told
});
