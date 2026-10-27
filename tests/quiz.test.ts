import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ANSWER_GRACE_MS, basePoints, checkAnswer, checkCancel, checkEndQuestion, checkLobbyOnly, checkNext, checkStart, fastestCorrect, generatePin, pickLevel, rankPlayers,
  scoreAnswer, streakBonus, validateNickname, validateQuiz, type AnswerCheck,
} from "../src/services/quiz/rules";
import { CSC, MLS, host, makeQuizWorld, quizInput, settle, stu } from "./helpers/quiz-world";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
async function rejection(p: Promise<unknown>): Promise<{ status: number; code?: string; message: string }> {
  try { await p; } catch (e) { const x = e as { statusCode?: number; code?: string; message: string }; return { status: x.statusCode ?? 0, code: x.code, message: x.message }; }
  throw new Error("Expected a rejection");
}

/* ============================ pure rules ============================ */
test("1. Points: 1000 for an instant answer down to 500 at the last moment; the streak bonus is 0, 100, 200 ... capped at 500", () => {
  assert.deepEqual([0, 5000, 10000, 12000, -50].map((ms) => basePoints(ms, 10_000)), [1000, 750, 500, 500, 1000]);
  assert.deepEqual([0, 1, 2, 3, 6, 7, 20].map(streakBonus), [0, 0, 100, 200, 500, 500, 500]);
  assert.deepEqual(scoreAnswer({ correct: true, elapsedMs: 1000, limitMs: 10_000, previousStreak: 0 }), { correct: true, elapsedMs: 1000, base: 950, streakAfter: 1, streakBonus: 0, points: 950 });
  assert.deepEqual(scoreAnswer({ correct: true, elapsedMs: 1000, limitMs: 10_000, previousStreak: 2 }), { correct: true, elapsedMs: 1000, base: 950, streakAfter: 3, streakBonus: 200, points: 1150 });
  assert.deepEqual(scoreAnswer({ correct: false, elapsedMs: 1000, limitMs: 10_000, previousStreak: 4 }), { correct: false, elapsedMs: 1000, base: 0, streakAfter: 0, streakBonus: 0, points: 0 }); // wrong: nothing, streak resets
});
test("2. Ranking: higher score, then the lower total time over correct answers, then the earlier join; ranks are always unique", () => {
  const p = (id: string, score: number, totalCorrectMs: number, joinedAt: number) => ({ id, score, totalCorrectMs, joinedAt });
  const r = rankPlayers([p("a", 500, 9000, 1), p("b", 500, 7000, 2), p("c", 700, 20_000, 3), p("d", 500, 7000, 0)]);
  assert.deepEqual(r.map((x) => [x.id, x.rank]), [["c", 1], ["d", 2], ["b", 3], ["a", 4]]);
  assert.deepEqual(rankPlayers([p("x", 0, 0, 5), p("y", 0, 0, 5)]).map((x) => x.rank), [1, 2]); // even a complete tie gets distinct ranks
  assert.deepEqual(rankPlayers([]), []);
});
test("3. The fastest correct answers: wrong answers excluded, ties go to the one the server received first", () => {
  const a = (playerId: string, correct: boolean, elapsedMs: number, receivedSeq: number) => ({ playerId, correct, elapsedMs, receivedSeq });
  assert.deepEqual(fastestCorrect([a("w", false, 100, 1), a("x", true, 3000, 2), a("y", true, 2000, 4), a("z", true, 2000, 3)]).map((x) => x.playerId), ["z", "y", "x"]);
});
test("4. Nicknames: 2-20 visible characters in any language, emoji allowed; markup, control and invisible characters are not; the key is case-insensitive", () => {
  assert.deepEqual(validateNickname("  Ada   Obi "), { ok: true, nickname: "Ada Obi", key: "ada obi" });
  for (const good of ["Chidí", "Tolu_99", "O'Brien", "Anne-Marie", "Ọlá", "Иван", "李雷", "😀😀", "Ada 😎", "🇳🇬 Naija", "👍🏽 Ben", "👨\u200D👩\u200D👧 Fam", "1\uFE0F\u20E3 team", "Cafe\u0301"]) {
    assert.equal(validateNickname(good).ok, true, good);
  }
  // a combining accent and the precomposed letter are the same nickname
  assert.equal((validateNickname("Cafe\u0301") as { key: string }).key, (validateNickname("Caf\u00e9") as { key: string }).key);
  for (const bad of ["A", "😀", "", "   ", "x".repeat(21), "😀".repeat(21), "<b>hi</b>", "a<script>", "a&b", 'say "hi"', "a/b", "a\\b", "a{b}", "a\u0000b", "a\u200Bb", "a\u202Eb", "\u200D\u200D", "#\uFE0F", "👨\u200D".repeat(70), 42, null, undefined]) {
    const r = validateNickname(bad);
    assert.equal(r.ok, false, String(bad));
    if (!r.ok) assert.deepEqual([r.violation.status, r.violation.code], [422, "INVALID_NICKNAME"]);
  }
  assert.equal(validateNickname("😀".repeat(20)).ok, true); // 20 visible characters is the limit, however many code units they take
  assert.equal((validateNickname("ADA") as { key: string }).key, (validateNickname("ada") as { key: string }).key);
});
test("5. A quiz is validated: title, seconds, 1-50 questions, 2-4 distinct answers, one correct", () => {
  const ok = validateQuiz(quizInput({ title: "  Revision  " }));
  assert.ok(ok.ok && ok.quiz.title === "Revision" && ok.quiz.secondsPerQuestion === 10);
  assert.equal(validateQuiz({ ...quizInput(), secondsPerQuestion: undefined }).ok, true); // default 10
  const bad = (over: object) => { const r = validateQuiz({ ...quizInput(), ...over } as never); assert.equal(r.ok, false); return r.ok ? "" : r.violation.message; };
  assert.match(bad({ title: "ab" }), /title/);
  assert.match(bad({ secondsPerQuestion: 4 }), /Seconds/); assert.match(bad({ secondsPerQuestion: 61 }), /Seconds/);
  assert.match(bad({ questions: [] }), /1 to 50/);
  assert.match(bad({ questions: Array.from({ length: 51 }, () => quizInput().questions[0]) }), /1 to 50/);
  const one = (q: object) => bad({ questions: [{ ...quizInput().questions[0], ...q }] });
  assert.match(one({ text: "hi" }), /Question 1: the text/);
  assert.match(one({ options: ["only"] }), /2 to 4/); assert.match(one({ options: ["a", "b", "c", "d", "e"] }), /2 to 4/);
  assert.match(one({ options: ["same", "SAME"] }), /different/);
  assert.match(one({ options: ["a", ""] }), /1 to 100/);
  assert.match(one({ correctIndex: 3 }), /correct/); assert.match(one({ correctIndex: -1 }), /correct/); assert.match(one({ correctIndex: 1.5 }), /correct/);
});
test("6. Level choice, PIN generation and the simple state checks", () => {
  assert.deepEqual([pickLevel(["200"], "300"), pickLevel(["200", "300"], "300"), pickLevel(["400", "300"], "100"), pickLevel(["200", "200"], "100")], ["200", "300", "300", "200"]);
  assert.equal(generatePin(() => 123_456), "123456");
  assert.equal(generatePin((min, max) => { assert.deepEqual([min, max], [100_000, 1_000_000]); return min; }), "100000");
  assert.deepEqual([checkStart("LOBBY", 0)?.code, checkStart("LOBBY", 1), checkStart("QUESTION", 3)?.code], ["INVALID_STATE", null, "INVALID_STATE"]);
  assert.deepEqual([checkEndQuestion("QUESTION"), checkEndQuestion("REVEAL")?.code, checkNext("REVEAL"), checkNext("QUESTION")?.code, checkLobbyOnly("LOBBY"), checkLobbyOnly("REVEAL")?.code], [null, "INVALID_STATE", null, "INVALID_STATE", null, "INVALID_STATE"]);
  assert.deepEqual(["LOBBY", "QUESTION", "REVEAL"].map((p) => checkCancel(p as never)), [null, null, null]);
  assert.deepEqual(["FINISHED", "CANCELLED"].map((p) => checkCancel(p as never)?.code), ["INVALID_STATE", "INVALID_STATE"]);
});
test("7. Answer acceptance is decided by the server's clock: grace period, one question at a time, valid choices", () => {
  const base: AnswerCheck = { phase: "QUESTION", closing: false, currentIndex: 2, questionStartedAtMs: 1_000_000, limitMs: 10_000, nowMs: 1_002_000, questionIndex: 2, choice: 1, optionCount: 3 };
  const run = (o: Partial<AnswerCheck>) => checkAnswer({ ...base, ...o });
  assert.deepEqual(run({}), { ok: true, elapsedMs: 2000 });
  assert.deepEqual(run({ nowMs: 1_010_000 + ANSWER_GRACE_MS }), { ok: true, elapsedMs: 10_000 }); // exactly at the end of the grace: still accepted, time clamped
  const code = (o: Partial<AnswerCheck>) => { const r = run(o); return r.ok ? "OK" : `${r.violation.status} ${r.violation.code}`; };
  assert.equal(code({ nowMs: 1_011_001 }), "409 ANSWER_TOO_LATE");
  assert.equal(code({ phase: "REVEAL" }), "409 ANSWER_TOO_LATE");
  assert.equal(code({ closing: true }), "409 ANSWER_TOO_LATE");
  assert.equal(code({ questionIndex: 1 }), "409 INVALID_STATE");
  assert.equal(code({ phase: "LOBBY", currentIndex: -1, questionIndex: 0, questionStartedAtMs: null }), "409 INVALID_STATE"); // no question has started
  assert.equal(code({ phase: "FINISHED" }), "409 INVALID_STATE");
  assert.equal(code({ choice: 3 }), "422 INVALID_CHOICE"); assert.equal(code({ choice: -1 }), "422 INVALID_CHOICE");
  assert.equal(code({ choice: "1" }), "422 INVALID_ANSWER"); assert.equal(code({ questionIndex: 1.5 }), "422 INVALID_ANSWER");
  assert.equal(run({ nowMs: 999_000 }).ok && (run({ nowMs: 999_000 }) as { elapsedMs: number }).elapsedMs, 0); // a clock that ran backwards can't give a negative time
});

/* ============================ quizzes ============================ */
test("8. A rep's quizzes are their own: nobody else (same class, another class, another department) can see, edit, delete or host them", async () => {
  const w = makeQuizWorld();
  const q = await w.svc.createQuiz(host("rep1"), quizInput());
  assert.deepEqual((await w.svc.listQuizzes(host("rep1"))).map((x) => [x.title, x.questionCount, x.secondsPerQuestion, x.timesHosted]), [["Week 3 revision", 3, 10, 0]]);
  for (const other of [host("rep2"), host("rep3", MLS), host("rep4", CSC, "300")]) {
    assert.deepEqual(await w.svc.listQuizzes(other), []);
    for (const p of [w.svc.getQuiz(other, q.id), w.svc.updateQuiz(other, q.id, quizInput()), w.svc.deleteQuiz(other, q.id), w.svc.hostGame(other, q.id)]) assert.deepEqual([(await rejection(p)).status, (await rejection(p)).code], [404, "QUIZ_NOT_FOUND"]);
  }
  assert.equal(w.store.quizzes.length, 1);
  assert.equal((await rejection(w.svc.createQuiz(host("rep1"), quizInput({ title: "x" })))).code, "INVALID_QUIZ");
  const upd = await w.svc.updateQuiz(host("rep1"), q.id, quizInput({ title: "Renamed" }));
  assert.equal(upd.title, "Renamed");
  assert.equal(w.store.quizzes[0].level, "200"); // the class comes from the rep's appointment, not from the request
});

/* ============================ hosting and joining ============================ */
test("9. Hosting gives a 6-digit PIN; one open game per rep; a PIN clash picks another; the quiz is snapshotted", async () => {
  const w = makeQuizWorld({ pins: [111_111, 111_111, 222_222] });
  const q = await w.svc.createQuiz(host("rep1"), quizInput());
  const other = await w.svc.createQuiz(host("rep2"), quizInput());
  const g1 = await w.svc.hostGame(host("rep1"), q.id);
  assert.deepEqual([g1.pin, g1.phase, g1.role, g1.players, g1.playerCount, g1.totalQuestions, g1.question], ["111111", "LOBBY", "host", [], 0, 3, undefined]);
  assert.equal((await rejection(w.svc.hostGame(host("rep1"), q.id))).code, "GAME_IN_PROGRESS");
  assert.equal((await w.svc.hostGame(host("rep2"), other.id)).pin, "222222"); // 111111 is in use by an open game, so the next one is taken
  assert.equal((await rejection(w.svc.deleteQuiz(host("rep1"), q.id))).code, "GAME_IN_PROGRESS");
  await w.svc.updateQuiz(host("rep1"), q.id, quizInput({ title: "Edited later", questions: [quizInput().questions[0]] }));
  assert.deepEqual([w.store.games[0].title, w.store.games[0].questions.length, w.store.quizzes[0].timesHosted], ["Week 3 revision", 3, 1]); // a running game keeps its snapshot
  assert.equal((await w.svc.listQuizzes(host("rep1")))[0].timesHosted, 1);
});
test("10. Joining: wrong PIN, wrong class or department, own game and bad nicknames are refused; the same student coming back keeps their player", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby([]);
  const join = (s: ReturnType<typeof stu>, nickname = "Nick", pin = game.pin) => w.svc.join(s, { pin, nickname });
  assert.equal((await rejection(join(stu("ada"), "Nick", "999999"))).code, "PIN_NOT_FOUND");
  assert.equal((await rejection(join(stu("ada"), "Nick", "12ab"))).code, "PIN_NOT_FOUND");
  assert.deepEqual([(await rejection(join(stu("dan", CSC, "300")))).code, (await rejection(join(stu("eve", MLS, "200")))).code, (await rejection(join(stu("rep1")))).code], ["NOT_ELIGIBLE", "NOT_ELIGIBLE", "NOT_ELIGIBLE"]);
  assert.equal((await rejection(join(stu("ada"), "x"))).code, "INVALID_NICKNAME");
  const first = await join(stu("ada"), "Ada");
  assert.deepEqual([first.role, first.phase, first.me.nickname, first.me.score, first.me.rank, first.playerCount], ["player", "LOBBY", "Ada", 0, null, 1]);
  assert.equal((await rejection(join(stu("ben"), "  ada "))).code, "NICKNAME_TAKEN"); // case-insensitive
  assert.equal((await join(stu("ada"), "Something else")).me.playerId, first.me.playerId); // re-joining returns the existing player (the nickname isn't changed)
  assert.equal(w.store.players.length, 1);
  assert.equal((await w.svc.active(stu("ada")))?.gameId, game.gameId);
  assert.equal(await w.svc.active(stu("ben")), null);
});
test("11. A student can be in one open game at a time; nobody joins a game that has started (except a returning player)", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada"]);
  const q2 = await w.svc.createQuiz(host("rep2"), quizInput());
  const g2 = await w.svc.hostGame(host("rep2"), q2.id);
  assert.equal((await rejection(w.svc.join(stu("ada"), { pin: g2.pin, nickname: "Ada" }))).code, "ALREADY_IN_GAME");
  await w.svc.start(host(), game.gameId);
  assert.equal((await rejection(w.svc.join(stu("ben"), { pin: game.pin, nickname: "Ben" }))).code, "GAME_ALREADY_STARTED");
  assert.equal((await w.svc.join(stu("ada"), { pin: game.pin, nickname: "Ada" })).phase, "QUESTION"); // coming back mid-game
  assert.equal(w.store.players.length, 1);
});
test("12. The lobby is live: the host gets the names, players only a head-count", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada"]);
  w.emitted.length = 0;
  await w.svc.join(stu("ben"), { pin: game.pin, nickname: "Ben" });
  const hostEv = w.eventsTo("rep1", "quiz:state");
  assert.deepEqual(hostEv.at(-1)!.payload.players.map((p: { nickname: string }) => p.nickname), ["ADA", "Ben"]);
  assert.deepEqual(w.eventsTo("ada", "quiz:lobby").at(-1)!.payload, { gameId: game.gameId, count: 2 });
  assert.ok(!JSON.stringify(w.eventsTo("ada", "quiz:lobby")).includes("Ben"), "no names in the player broadcast");
  await w.svc.leave(stu("ada"), game.gameId);
  assert.equal(w.eventsTo("rep1", "quiz:state").at(-1)!.payload.playerCount, 1);
});
test("13. Leaving and removing players only works in the lobby; a removed student's screen ends and they can't read the game any more", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada", "ben"]);
  const ben = w.store.players.find((p) => p.nickname === "BEN")!;
  w.emitted.length = 0;
  await w.svc.kick(host(), game.gameId, ben.id);
  assert.deepEqual([w.eventsTo("ben", "quiz:state")[0].payload.phase, w.eventsTo("ben", "quiz:state")[0].payload.me.nickname], ["CANCELLED", "BEN"]);
  assert.equal((await rejection(w.svc.getPlayerState(stu("ben"), game.gameId))).code, "NOT_ELIGIBLE");
  assert.equal((await rejection(w.svc.kick(host(), game.gameId, ben.id))).status, 404);
  assert.equal((await rejection(w.svc.kick(host("rep2"), game.gameId, w.store.players[0].id))).code, "GAME_NOT_FOUND");
  await w.svc.start(host(), game.gameId);
  assert.equal((await rejection(w.svc.leave(stu("ada"), game.gameId))).code, "INVALID_STATE");
  assert.equal((await rejection(w.svc.kick(host(), game.gameId, w.store.players[0].id))).code, "INVALID_STATE");
});

/* ============================ playing ============================ */
test("14. Starting needs a player; the question goes to every phone WITHOUT the answer, and to the host with it", async () => {
  const w = makeQuizWorld();
  const q = await w.svc.createQuiz(host(), quizInput());
  const empty = await w.svc.hostGame(host(), q.id);
  assert.equal((await rejection(w.svc.start(host(), empty.gameId))).code, "INVALID_STATE");
  await w.svc.join(stu("ada"), { pin: empty.pin, nickname: "Ada" }); await w.svc.join(stu("ben"), { pin: empty.pin, nickname: "Ben" });
  w.emitted.length = 0;
  const t0 = w.now();
  const started = await w.svc.start(host(), empty.gameId);
  assert.equal((await rejection(w.svc.start(host(), empty.gameId))).code, "INVALID_STATE");
  assert.deepEqual([started.phase, started.question?.index, started.question?.correctIndex, started.answered], ["QUESTION", 0, 1, 0]);
  assert.equal(started.question!.endsAt, new Date(t0 + 10_000).toISOString());
  for (const id of ["ada", "ben"]) {
    const ev = w.eventsTo(id, "quiz:state").at(-1)!.payload;
    assert.deepEqual([ev.phase, ev.question.text, ev.question.options, ev.question.timeLimitSec, ev.question.answered], ["QUESTION", "Which is a prime number?", ["4", "7", "9"], 10, false]);
    assert.ok(!JSON.stringify(ev).includes("correctIndex") && ev.reveal === undefined, "no answer, no hint before the reveal");
    assert.ok(typeof ev.serverTime === "string");
  }
  assert.equal(w.eventsTo("rep1", "quiz:state").at(-1)!.payload.question.correctIndex, 1);
  const pull = await w.svc.getPlayerState(stu("ada"), empty.gameId);
  assert.ok(!JSON.stringify(pull).includes("correctIndex"));
});
test("15. An answer is accepted once, by the server's clock; the reply never says whether it was right", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada", "ben", "cy"]);
  await w.svc.start(host(), game.gameId);
  await w.advance(2000);
  assert.deepEqual(await w.svc.answer(stu("ada"), game.gameId, { questionIndex: 0, choice: 1 }), { accepted: true });
  assert.equal((await rejection(w.svc.answer(stu("ada"), game.gameId, { questionIndex: 0, choice: 0 }))).code, "ALREADY_ANSWERED"); // the first wins
  assert.equal(w.store.answers.length, 1);
  assert.equal(w.store.answers[0].elapsedMs, 2000); // measured by the server
  assert.equal((await rejection(w.svc.answer(stu("ben"), game.gameId, { questionIndex: 1, choice: 0 }))).code, "INVALID_STATE"); // not the current question
  assert.equal((await rejection(w.svc.answer(stu("ben"), game.gameId, { questionIndex: 0, choice: 5 }))).code, "INVALID_CHOICE");
  assert.equal((await rejection(w.svc.answer(stu("dan", CSC, "300"), game.gameId, { questionIndex: 0, choice: 0 }))).code, "NOT_ELIGIBLE"); // not a player
  // your own score does not move until the reveal
  const mine = await w.svc.getPlayerState(stu("ada"), game.gameId);
  assert.deepEqual([mine.me.score, mine.me.rank, mine.question?.answered, mine.reveal], [0, null, true, undefined]);
  assert.equal((await w.svc.getHostState(host(), game.gameId)).answered, 1);
});
test("16. Time: the reveal comes after the time limit plus a short grace, late answers are refused, answers inside the grace count", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada", "ben"]);
  await w.svc.start(host(), game.gameId);
  await w.advance(10_000);
  assert.equal((await w.svc.getHostState(host(), game.gameId)).phase, "QUESTION"); // the countdown has hit 0 but the grace is still open
  await w.advance(500);
  await w.svc.answer(stu("ada"), game.gameId, { questionIndex: 0, choice: 1 }); // sent just before time ran out, arrived just after
  assert.equal(w.store.answers[0].elapsedMs, 10_000); // clamped to the limit: it earns the minimum
  await w.advance(500);
  assert.equal((await w.svc.getHostState(host(), game.gameId)).phase, "REVEAL");
  assert.equal((await rejection(w.svc.answer(stu("ben"), game.gameId, { questionIndex: 0, choice: 1 }))).code, "ANSWER_TOO_LATE");
  assert.equal(w.timers.size, 0, "no timer left running for a revealed question");
});
test("17. When everyone has answered, the reveal happens at once; the host can also end a question early", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada", "ben"]);
  await w.svc.start(host(), game.gameId);
  await w.advance(1000);
  await w.svc.answer(stu("ada"), game.gameId, { questionIndex: 0, choice: 1 });
  assert.equal((await w.svc.getHostState(host(), game.gameId)).phase, "QUESTION");
  await w.svc.answer(stu("ben"), game.gameId, { questionIndex: 0, choice: 0 });
  await settle();
  assert.equal((await w.svc.getHostState(host(), game.gameId)).phase, "REVEAL");
  await w.svc.next(host(), game.gameId);
  await w.advance(500);
  const ended = await w.svc.endQuestion(host(), game.gameId); // nobody has answered: ending early is still allowed
  assert.deepEqual([ended.phase, ended.reveal?.answeredCount], ["REVEAL", 0]);
  assert.equal((await rejection(w.svc.endQuestion(host(), game.gameId))).code, "INVALID_STATE");
});
test("18. A timer, 'everyone answered' and the host button racing produce exactly ONE reveal and score each answer once", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada", "ben"]);
  await w.svc.start(host(), game.gameId);
  await w.advance(2000);
  await w.svc.answer(stu("ada"), game.gameId, { questionIndex: 0, choice: 1 });
  const results = await Promise.all([w.svc.closeQuestion(game.gameId, 0), w.svc.closeQuestion(game.gameId, 0), w.svc.closeQuestion(game.gameId, 0)]);
  assert.deepEqual(results.filter(Boolean).length, 1);
  assert.equal(w.store.players.find((p) => p.nickname === "ADA")!.score, 900); // not 1800
  assert.equal(await w.svc.closeQuestion(game.gameId, 0), false); // too late for a straggling timer
  assert.equal(w.eventsTo("ada", "quiz:state").filter((e) => e.payload.phase === "REVEAL").length, 1);
});

/* ============================ a whole game ============================ */
test("19. A full game: points, streaks, speed, ranks and distributions are all decided by the server", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada", "ben", "cy"]);
  const id = game.gameId;
  const ans = (who: string, q: number, choice: number) => w.svc.answer(stu(who), id, { questionIndex: q, choice });
  const state = (who: string) => w.svc.getPlayerState(stu(who), id);

  // Question 0 (correct = 1): ada right at 2 s, ben right at 3 s, cy wrong
  await w.svc.start(host(), id);
  await w.advance(2000); await ans("ada", 0, 1);
  await w.advance(1000); await ans("ben", 0, 1);
  await w.advance(1000); await ans("cy", 0, 0); await settle();
  let ada = await state("ada"), ben = await state("ben"), cy = await state("cy");
  assert.deepEqual([ada.phase, ada.reveal!.correctIndex, ada.reveal!.correct, ada.reveal!.points, ada.reveal!.streak, ada.me.score, ada.me.rank], ["REVEAL", 1, true, 900, 1, 900, 1]);
  assert.deepEqual([ben.reveal!.points, ben.me.rank, cy.reveal!.correct, cy.reveal!.points, cy.reveal!.yourChoice, cy.me.rank], [850, 2, false, 0, 0, 3]);
  assert.deepEqual([ada.reveal!.distribution, ada.reveal!.fastest, ada.reveal!.yourTimeMs, ada.reveal!.yourSpeedRank, ben.reveal!.yourSpeedRank, cy.reveal!.yourSpeedRank, cy.reveal!.yourTimeMs],
    [[1, 2, 0], [{ nickname: "ADA", ms: 2000, you: true }, { nickname: "BEN", ms: 3000 }], 2000, 1, 2, null, 4000]);
  assert.deepEqual(ada.reveal!.topFive.map((r) => [r.rank, r.nickname, r.score, r.you]), [[1, "ADA", 900, true], [2, "BEN", 850, undefined], [3, "CY", 0, undefined]]);
  assert.equal(ada.reveal!.isLast, false);
  const hostReveal = (await w.svc.getHostState(host(), id)).reveal!;
  assert.deepEqual([hostReveal.distribution, hostReveal.answeredCount, hostReveal.fastest.map((f) => f.nickname), hostReveal.topFive[0].you], [[1, 2, 0], 3, ["ADA", "BEN"], undefined]);

  // Question 1 (correct = 0): ada right at 1 s (streak 2: +100), ben wrong, cy silent
  await w.svc.next(host(), id);
  await w.advance(1000); await ans("ada", 1, 0); await ans("ben", 1, 1);
  await w.svc.endQuestion(host(), id);
  ada = await state("ada"); ben = await state("ben"); cy = await state("cy");
  assert.deepEqual([ada.reveal!.points, ada.reveal!.streakBonus, ada.reveal!.streak, ada.me.score, ada.me.rank], [1050, 100, 2, 1950, 1]);
  assert.deepEqual([ben.reveal!.points, ben.reveal!.streak, ben.me.score, cy.reveal!.yourChoice, cy.reveal!.yourTimeMs, cy.reveal!.streak, cy.reveal!.points], [0, 0, 850, null, null, 0, 0]);

  // Question 2 (correct = 2): everyone right; ada and ben equally fast (ada's answer arrived first), cy slower
  await w.svc.next(host(), id);
  await w.advance(500); await ans("ada", 2, 2); await ans("ben", 2, 2);
  await w.advance(1000); await ans("cy", 2, 2); await settle();
  ada = await state("ada"); ben = await state("ben"); cy = await state("cy");
  assert.deepEqual([ada.reveal!.points, ada.reveal!.streakBonus, ada.me.score], [1175, 200, 3125]); // 975 + streak-3 bonus
  assert.deepEqual([ben.reveal!.points, ben.reveal!.streakBonus, ben.me.score, ben.me.rank], [975, 0, 1825, 2]); // the streak restarted after the wrong answer
  assert.deepEqual([cy.reveal!.points, cy.me.score, cy.me.rank], [925, 925, 3]);
  assert.deepEqual(ada.reveal!.fastest.map((f) => [f.nickname, f.ms]), [["ADA", 500], ["BEN", 500], ["CY", 1500]]);
  assert.equal(ada.reveal!.isLast, true);

  // finish
  const fin = await w.svc.next(host(), id);
  assert.deepEqual([fin.phase, fin.final!.leaderboard.map((r) => [r.rank, r.nickname, r.score]), fin.final!.playerCount], ["FINISHED", [[1, "ADA", 3125], [2, "BEN", 1825], [3, "CY", 925]], 3]);
  ada = await state("ada");
  assert.deepEqual([ada.phase, ada.final!.rank, ada.final!.score, ada.final!.correctCount, ada.final!.totalQuestions, ada.final!.playerCount, ada.final!.top.length, ada.final!.top[0].you], ["FINISHED", 1, 3125, 3, 3, 3, 3, true]);
  assert.equal((await state("cy")).final!.correctCount, 1);
  assert.equal(w.store.games[0].open, false);
  assert.equal((await rejection(w.svc.next(host(), id))).code, "INVALID_STATE");

  // results afterwards
  const list = await w.svc.results(stu("ben"));
  assert.deepEqual(list.map((r) => [r.title, r.rank, r.playerCount, r.score, r.correctCount, r.totalQuestions]), [["Week 3 revision", 2, 3, 1825, 2, 3]]);
  const one = await w.svc.result(stu("ben"), id);
  assert.deepEqual(one.questions.map((q) => [q.yourChoice, q.correct, q.points]), [[1, true, 850], [1, false, 0], [2, true, 975]]);
  assert.deepEqual(one.questions[0].options, ["4", "7", "9"]);
  assert.equal(one.questions[0].correctIndex, 1);
  assert.equal(one.top.length, 3);
});
test("20. Results are only available once the game is finished, and only to its players", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada"]);
  await w.svc.start(host(), game.gameId);
  assert.equal((await rejection(w.svc.result(stu("ada"), game.gameId))).code, "INVALID_STATE");
  assert.deepEqual(await w.svc.results(stu("ada")), []);
  assert.equal((await rejection(w.svc.result(stu("ben"), game.gameId))).code, "NOT_ELIGIBLE");
});
test("21. A tie on score is broken by the faster total time, then by who joined first", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada", "ben"], { questions: [quizInput().questions[0]] });
  await w.svc.start(host(), game.gameId);
  // ada's answer is received first, so she is both the fastest and the leader: no cash drop (see the money tests) disturbs the tie
  await w.advance(1000); await w.svc.answer(stu("ada"), game.gameId, { questionIndex: 0, choice: 1 });
  await w.advance(0); await w.svc.answer(stu("ben"), game.gameId, { questionIndex: 0, choice: 1 }); await settle();
  const fin = await w.svc.next(host(), game.gameId);
  assert.deepEqual(fin.final!.leaderboard.map((r) => [r.rank, r.nickname, r.score]), [[1, "ADA", 950], [2, "BEN", 950]]); // identical times: the earlier join (ada) wins
});

/* ============================ cancel, idle, restart ============================ */
test("22. Cancelling works at any point before the end: everyone's screen ends and the PIN is free again", async () => {
  const w = makeQuizWorld({ pins: [111_111, 111_111] });
  const { game, quiz } = await w.lobby(["ada"]);
  await w.svc.start(host(), game.gameId);
  w.emitted.length = 0;
  const c = await w.svc.cancel(host(), game.gameId);
  assert.equal(c.phase, "CANCELLED");
  assert.equal(w.eventsTo("ada", "quiz:state").at(-1)!.payload.phase, "CANCELLED");
  assert.equal(w.timers.size, 0);
  assert.equal((await w.svc.listGames(host()))[0].pin, null); // no longer joinable
  assert.equal((await rejection(w.svc.cancel(host(), game.gameId))).code, "INVALID_STATE");
  assert.equal((await rejection(w.svc.join(stu("ben"), { pin: "111111", nickname: "Ben" }))).code, "PIN_NOT_FOUND");
  assert.equal((await w.svc.hostGame(host(), quiz.id)).pin, "111111"); // released and reusable; the rep is free to host again
  assert.equal(await w.svc.active(stu("ada")), null); // a cancelled game is no longer "active" for its players
});
test("23. A game the host abandoned is cancelled after 30 minutes without a host action; automatic reveals don't count as host activity", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada"]);
  await w.advance(29 * 60_000);
  assert.equal(await w.svc.sweepIdle(), 0);
  await w.svc.start(host(), game.gameId); // a host action resets the idle clock
  await w.advance(29 * 60_000); // the question's timer reveals the answer meanwhile
  assert.equal((await w.svc.getHostState(host(), game.gameId)).phase, "REVEAL");
  assert.equal(await w.svc.sweepIdle(), 0);
  await w.advance(2 * 60_000);
  assert.equal(await w.svc.sweepIdle(), 1);
  assert.equal(w.store.games[0].status, "CANCELLED");
  assert.equal(w.eventsTo("ada", "quiz:state").at(-1)!.payload.phase, "CANCELLED");
});
test("24. After a server restart the running question's clock is re-armed from the database", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada"]);
  await w.svc.start(host(), game.gameId);
  w.timers.clear(); // the process died: every in-memory timer is gone
  await w.advance(30_000);
  assert.equal((await w.svc.getHostState(host(), game.gameId)).phase, "QUESTION"); // nothing would ever reveal it...
  await w.svc.resume();
  await w.advance(1);
  assert.equal((await w.svc.getHostState(host(), game.gameId)).phase, "REVEAL"); // ...until resume() re-arms it (already overdue: immediately)
  // interrupted in the middle of a reveal: the claim is released and redone
  await w.svc.next(host(), game.gameId);
  w.store.games[0].closing = true; w.timers.clear();
  await w.svc.resume(); await w.advance(30_000);
  assert.equal((await w.svc.getHostState(host(), game.gameId)).phase, "REVEAL");
});

/* ============================ isolation and resilience ============================ */
test("25. Another rep can't see or run your game; students of another class can't read it", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["ada"]);
  for (const p of [w.svc.getHostState(host("rep2"), game.gameId), w.svc.start(host("rep2"), game.gameId), w.svc.next(host("rep2"), game.gameId), w.svc.endQuestion(host("rep2"), game.gameId), w.svc.cancel(host("rep2"), game.gameId), w.svc.getHostState(host("rep3", MLS), game.gameId)]) {
    assert.deepEqual([(await rejection(p)).status, (await rejection(p)).code], [404, "GAME_NOT_FOUND"]);
  }
  assert.deepEqual(await w.svc.listGames(host("rep2")), []);
  assert.equal((await rejection(w.svc.getPlayerState(stu("dan", CSC, "300"), game.gameId))).code, "NOT_ELIGIBLE");
  assert.equal((await rejection(w.svc.getPlayerState(stu("eve", MLS), game.gameId))).code, "NOT_ELIGIBLE");
  assert.equal((await rejection(w.svc.getPlayerState(stu("ada"), "does-not-exist"))).code, "NOT_ELIGIBLE"); // a missing game looks like a game you aren't in
  assert.equal((await rejection(w.svc.getHostState(host(), "does-not-exist"))).code, "GAME_NOT_FOUND");
  assert.equal(w.store.games[0].status, "LOBBY");
});
test("26. Live progress for the host is throttled and always ends with the latest count", async () => {
  const w = makeQuizWorld();
  const { game } = await w.lobby(["a1", "a2", "a3", "a4", "a5"]);
  await w.svc.start(host(), game.gameId);
  w.emitted.length = 0;
  for (const n of ["a1", "a2", "a3", "a4"]) await w.svc.answer(stu(n), game.gameId, { questionIndex: 0, choice: 1 });
  await settle();
  const early = w.eventsTo("rep1", "quiz:progress");
  assert.ok(early.length <= 2, `throttled (got ${early.length})`);
  assert.deepEqual(early[0].payload, { gameId: game.gameId, questionIndex: 0, answered: 1, total: 5 });
  await w.advance(300);
  assert.deepEqual(w.eventsTo("rep1", "quiz:progress").at(-1)!.payload, { gameId: game.gameId, questionIndex: 0, answered: 4, total: 5 });
});
test("27. A broken socket never affects the game", async () => {
  const w = makeQuizWorld({ emitThrows: true });
  const { game } = await w.lobby(["ada", "ben"]);
  await w.svc.start(host(), game.gameId);
  await w.advance(1000); await w.svc.answer(stu("ada"), game.gameId, { questionIndex: 0, choice: 1 }); await w.svc.answer(stu("ben"), game.gameId, { questionIndex: 0, choice: 1 }); await settle();
  assert.equal((await w.svc.getHostState(host(), game.gameId)).phase, "REVEAL");
  assert.ok(w.warnings.some((a) => String(a[0]).includes("Quiz emit failed")));
});

/* ============================ wiring ============================ */
test("28. Routes, validation and limits: every quiz route is authenticated, strict, rate-limited, and the live ones skip the per-IP limit", () => {
  const stuRoutes = read("src/routes/student.routes.ts").split(/\nrouter\./).filter((c) => /^(get|post)\(\s*"\/quiz\//.test(c));
  assert.equal(stuRoutes.length, 7);
  for (const c of stuRoutes) assert.ok(c.includes("authenticateStudent") && /Quiz(Read|Join|Answer)Limiter/.test(c), c.slice(0, 70));
  const repRoutes = read("src/routes/representative.routes.ts").split(/\nrouter\./).filter((c) => /^(get|post|put|delete)\(\s*"\/quiz/.test(c));
  assert.equal(repRoutes.length, 13);
  for (const c of repRoutes) assert.ok(c.includes("...rep") && c.includes("requireRepresentativePermission("), c.slice(0, 70));
  assert.deepEqual([repRoutes.filter((c) => c.includes('"quiz:manage"')).length, repRoutes.filter((c) => c.includes('"quiz:host"')).length], [5, 8]);
  const v = strip(read("src/validators/quiz.validators.ts"));
  assert.ok((v.match(/\.strict\(\)/g) ?? []).length >= 6);
  assert.ok(!/studentId|departmentId|level|elapsed|score|points|correct(?!Index)|rank|serverTime|timestamp/i.test(v.replace(/correctIndex/g, "")), "nothing identity-, time- or score-like can be supplied by a client");
  const rl = strip(read("src/middleware/rateLimiters.ts"));
  assert.match(rl, /"\/api\/v1\/student\/quiz\/", "\/api\/v1\/representative\/quiz-games"/);
  assert.match(rl, /export const globalLimiter = make\(15 \* MIN, 6000, "Too many requests\. Please slow down\.", isLiveQuizRequest\)/);
  const ctl = strip(read("src/controllers/quiz-host.controller.ts") + read("src/controllers/student-quiz.controller.ts"));
  assert.ok(!/req\.(body|query|params)\.(studentId|departmentId|level|hostId)/.test(ctl));
  assert.match(strip(read("src/server.ts")), /quizService\.resume\(\)/);
  assert.match(strip(read("src/server.ts")), /quizService\.sweepIdle\(\)/);
});
test("29. Quiz permissions are in the rep permission table for both roles, and the events use the existing student sockets", () => {
  const p = read("src/services/representative/policy.ts");
  assert.equal((p.match(/"quiz:manage", "quiz:host"/g) ?? []).length, 3); // the permission list, the Course Rep and the Assistant
  const i = strip(read("src/services/quiz/index.ts"));
  assert.match(i, /realtime\.emitToUser\(\{ userType: "STUDENT", userId: studentId \}, event, payload\)/);
  const s = strip(read("src/services/quiz/quiz.service.ts"));
  for (const ev of ["quiz:state", "quiz:lobby", "quiz:progress"]) assert.ok(s.includes(`"${ev}"`), ev);
  assert.ok(!/Campus (Hub|Market)/i.test(s));
});
