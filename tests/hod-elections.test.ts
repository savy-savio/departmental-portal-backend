import { test } from "node:test";
import assert from "node:assert/strict";
import { CSC, JPEG, MLS, PNG, hodC, hodM, makeElectionWorld, meta, mins, q, rejection } from "./helpers/election-world";

/* ============================ creating / editing ============================ */
test("1. A HOD creates a DRAFT election; the session defaults to the department's current one", async () => {
  const w = makeElectionWorld();
  const e = await w.svc.create(hodC, { title: "Departmental Student Election 2026", description: "Pick your executives", votingOpensAt: mins(60), votingClosesAt: mins(600) }, meta);
  assert.equal(e.status, "DRAFT");
  assert.equal(e.academicSession, "2026/2027");
  assert.deepEqual(e.electorate, { mode: "DEPARTMENT", levels: [], groupSize: 0, eligibleVoters: 5 }); // active students of the session: ada, ben, cy, dee, eli (fay pending, gus suspended, old other session)
  assert.equal(w.store.elections[0].createdByName, "Hope Chief");
  assert.equal(w.store.audit.at(-1)!.action, "ELECTION_CREATED");
});
test("2. Bad schedules are refused; titles are unique per department and session", async () => {
  const w = makeElectionWorld();
  assert.equal((await rejection(w.svc.create(hodC, { title: "X election", votingOpensAt: mins(60), votingClosesAt: mins(30) }))).status, 422);
  assert.equal((await rejection(w.svc.create(hodC, { title: "X election", votingOpensAt: mins(60), votingClosesAt: mins(62) }))).status, 422); // under the minimum window
  await w.svc.create(hodC, { title: "Same title", votingOpensAt: mins(60), votingClosesAt: mins(600) });
  assert.equal((await rejection(w.svc.create(hodC, { title: "Same title", votingOpensAt: mins(60), votingClosesAt: mins(600) }))).code, "DUPLICATE_ELECTION");
  await w.svc.create(hodM, { title: "Same title", votingOpensAt: mins(60), votingClosesAt: mins(600) }); // another department may reuse it
});
test("3. A draft can be edited freely, including the schedule and electorate", async () => {
  const w = makeElectionWorld();
  const e = await w.svc.create(hodC, { title: "Draft one", votingOpensAt: mins(60), votingClosesAt: mins(600) });
  const u = await w.svc.update(hodC, e.id, { title: "Draft renamed", description: "new", votingOpensAt: mins(-30), votingClosesAt: mins(900), electorate: { mode: "LEVELS", levels: ["200"] } }, meta);
  assert.equal(u.title, "Draft renamed");
  assert.equal(u.electorate.eligibleVoters, 3);
  assert.equal((await w.svc.update(hodC, e.id, { description: null })).description, null);
});

/* ============================ eligibility ============================ */
test("4. Electorate modes: department, levels (class) and an explicit group; all validated server-side", async () => {
  const w = makeElectionWorld();
  const mk = (electorate?: { mode: "DEPARTMENT" | "LEVELS" | "GROUP"; levels?: string[]; studentIds?: string[] }, title = Math.random().toString()) => w.svc.create(hodC, { title, votingOpensAt: mins(60), votingClosesAt: mins(600), electorate });
  assert.equal((await mk()).electorate.eligibleVoters, 5);
  assert.equal((await mk({ mode: "LEVELS", levels: ["100"] })).electorate.eligibleVoters, 1); // dee only (fay is pending)
  assert.equal((await mk({ mode: "LEVELS", levels: ["100", "300"] })).electorate.eligibleVoters, 2);
  assert.equal((await mk({ mode: "GROUP", studentIds: ["ada", "ben", "mia"].slice(0, 2) })).electorate.eligibleVoters, 2);
  for (const bad of [
    { mode: "LEVELS" as const }, { mode: "LEVELS" as const, levels: ["500"] }, { mode: "LEVELS" as const, levels: ["200"], studentIds: ["ada"] },
    { mode: "GROUP" as const }, { mode: "GROUP" as const, studentIds: ["ada", "mia"] }, // mia is MLS
    { mode: "DEPARTMENT" as const, levels: ["200"] },
  ]) assert.equal((await rejection(mk(bad))).code, "INVALID_ELECTORATE");
});
test("5. The voter group lists its members (paged) and never another department's students", async () => {
  const w = makeElectionWorld();
  const e = await w.svc.create(hodC, { title: "Exco", votingOpensAt: mins(60), votingClosesAt: mins(600), electorate: { mode: "GROUP", studentIds: ["ada", "ben", "cy"] } });
  const page = await w.svc.groupMembers(hodC, e.id, { page: 1, limit: 2 });
  assert.deepEqual([page.items.length, page.total, page.totalPages], [2, 3, 2]);
  assert.equal((await rejection(w.svc.groupMembers(hodM, e.id, { page: 1, limit: 2 }))).status, 404);
});

/* ============================ positions ============================ */
test("6. Positions: create, edit, reorder and remove before the election begins", async () => {
  const w = makeElectionWorld();
  const e = await w.svc.create(hodC, { title: "Positions", votingOpensAt: mins(60), votingClosesAt: mins(600) });
  const titles = ["President", "Vice President", "Secretary", "Treasurer", "Public Relations Officer"];
  const made = []; for (const title of titles) made.push(await w.svc.createPosition(hodC, e.id, { title }));
  assert.deepEqual(made.map((p) => p.order), [0, 1, 2, 3, 4]);
  assert.equal((await rejection(w.svc.createPosition(hodC, e.id, { title: "president" }))).code, "DUPLICATE_POSITION"); // case-insensitive
  await w.svc.updatePosition(hodC, e.id, made[2].id, { title: "General Secretary", description: "Keeps records" });
  const reordered = await w.svc.reorderPositions(hodC, e.id, [made[4].id, made[0].id, made[1].id, made[2].id, made[3].id]);
  assert.deepEqual(reordered.map((p) => p.title), ["Public Relations Officer", "President", "Vice President", "General Secretary", "Treasurer"]);
  assert.equal((await rejection(w.svc.reorderPositions(hodC, e.id, [made[0].id]))).code, "INVALID_ORDER"); // must send all
  assert.equal((await rejection(w.svc.updatePosition(hodC, e.id, made[1].id, { title: "Treasurer" }))).code, "DUPLICATE_POSITION");
  await w.svc.deletePosition(hodC, e.id, made[3].id);
  assert.equal((await w.svc.listPositions(hodC, e.id)).length, 4);
});
test("7. Removing a position removes its candidates (and their photos)", async () => {
  const w = makeElectionWorld();
  const { e, p, a } = await w.ready();
  await w.svc.setCandidatePhoto(hodC, e.id, a.id, JPEG);
  await w.svc.deletePosition(hodC, e.id, p.id);
  assert.equal(w.store.candidates.length, 0);
  assert.equal(w.deleted.length, 1);
});

/* ============================ candidates ============================ */
test("8. Candidates are existing students added by the HOD: PENDING until approved, and only approved ones count", async () => {
  const w = makeElectionWorld();
  const e = await w.svc.create(hodC, { title: "Cands", votingOpensAt: mins(60), votingClosesAt: mins(600) });
  const p = await w.svc.createPosition(hodC, e.id, { title: "President" });
  const search = await w.svc.searchStudents(hodC, { page: 1, limit: 10, search: "ada" });
  assert.deepEqual(search.items.map((s) => s.id), ["ada"]);
  assert.ok(!("email" in search.items[0]) && !("phone" in search.items[0]));
  assert.equal((await w.svc.searchStudents(hodC, { page: 1, limit: 50 })).items.some((s) => ["fay", "gus", "mia"].includes(s.id)), false); // pending / suspended / other department
  const c = await w.svc.addCandidate(hodC, e.id, { positionId: p.id, studentId: "ada", manifesto: "More labs" }, meta);
  assert.equal(c.status, "PENDING");
  assert.equal((await w.svc.get(hodC, e.id)).counts.pendingCandidates, 1);
  const ok = await w.svc.decideCandidate(hodC, e.id, c.id, "APPROVED", meta);
  assert.equal(ok.status, "APPROVED");
  assert.equal(w.store.candidates[0].decidedByName, "Hope Chief");
  assert.equal((await rejection(w.svc.decideCandidate(hodC, e.id, c.id, "APPROVED"))).status, 409);
  assert.equal((await w.svc.decideCandidate(hodC, e.id, c.id, "REJECTED")).status, "REJECTED");
  assert.deepEqual(w.store.audit.map((a) => a.action).filter((a) => a.startsWith("ELECTION_CANDIDATE")), ["ELECTION_CANDIDATE_ADDED", "ELECTION_CANDIDATE_APPROVED", "ELECTION_CANDIDATE_REJECTED"]);
});
test("9. Only active students of the department can stand; a student stands for one position per election", async () => {
  const w = makeElectionWorld();
  const e = await w.svc.create(hodC, { title: "Rules", votingOpensAt: mins(60), votingClosesAt: mins(600) });
  const pres = await w.svc.createPosition(hodC, e.id, { title: "President" }), sec = await w.svc.createPosition(hodC, e.id, { title: "Secretary" });
  assert.equal((await rejection(w.svc.addCandidate(hodC, e.id, { positionId: pres.id, studentId: "mia" }))).status, 404); // other department
  assert.equal((await rejection(w.svc.addCandidate(hodC, e.id, { positionId: pres.id, studentId: "nobody" }))).status, 404);
  assert.equal((await rejection(w.svc.addCandidate(hodC, e.id, { positionId: pres.id, studentId: "gus" }))).code, "STUDENT_NOT_ACTIVE");
  assert.equal((await rejection(w.svc.addCandidate(hodC, e.id, { positionId: pres.id, studentId: "fay" }))).code, "STUDENT_NOT_ACTIVE");
  await w.svc.addCandidate(hodC, e.id, { positionId: pres.id, studentId: "ada" });
  assert.equal((await rejection(w.svc.addCandidate(hodC, e.id, { positionId: pres.id, studentId: "ada" }))).code, "DUPLICATE_CANDIDATE");
  assert.equal((await rejection(w.svc.addCandidate(hodC, e.id, { positionId: sec.id, studentId: "ada" }))).code, "DUPLICATE_CANDIDATE");
});
test("10. A rejected candidate can be re-added to the same position; removal deletes the record", async () => {
  const w = makeElectionWorld();
  const { e, p, a } = await w.ready();
  await w.svc.decideCandidate(hodC, e.id, a.id, "REJECTED");
  const again = await w.svc.addCandidate(hodC, e.id, { positionId: p.id, studentId: "ada", manifesto: "Second try", approve: true });
  assert.equal(again.id, a.id);
  assert.deepEqual([again.status, again.manifesto], ["APPROVED", "Second try"]);
  await w.svc.removeCandidate(hodC, e.id, a.id);
  assert.equal(w.store.candidates.some((c) => c.id === a.id), false);
});
test("11. A position id from a different election can't be used to attach a candidate", async () => {
  const w = makeElectionWorld();
  const one = await w.ready("Election one"), two = await w.ready("Election two");
  assert.equal((await rejection(w.svc.addCandidate(hodC, one.e.id, { positionId: two.p.id, studentId: "cy" }))).status, 404);
  assert.equal((await rejection(w.svc.decideCandidate(hodC, one.e.id, two.a.id, "REJECTED"))).status, 404);
});

/* ============================ candidate photos ============================ */
test("12. Photo upload: verified from bytes, replaces (and deletes) the previous one, can be removed", async () => {
  const w = makeElectionWorld();
  const { e, a } = await w.ready();
  assert.equal((await rejection(w.svc.setCandidatePhoto(hodC, e.id, a.id, Buffer.from("<script>alert(1)</script>")))).status, 415);
  assert.equal(w.uploaded.length, 0);
  const first = await w.svc.setCandidatePhoto(hodC, e.id, a.id, JPEG, meta);
  assert.equal(first.hasCustomPhoto, true);
  const second = await w.svc.setCandidatePhoto(hodC, e.id, a.id, PNG);
  assert.notEqual(second.photo, first.photo);
  assert.deepEqual(w.deleted, [w.uploaded[0]]); // old one cleaned up
  const gone = await w.svc.removeCandidatePhoto(hodC, e.id, a.id);
  assert.equal(gone.hasCustomPhoto, false);
  assert.deepEqual(w.deleted, [w.uploaded[0], w.uploaded[1]]);
});
test("13. A photo can be supplied while adding the candidate; a failed add doesn't leave an orphan upload", async () => {
  const w = makeElectionWorld();
  const e = await w.svc.create(hodC, { title: "Photos", votingOpensAt: mins(60), votingClosesAt: mins(600) });
  const p = await w.svc.createPosition(hodC, e.id, { title: "President" });
  const c = await w.svc.addCandidate(hodC, e.id, { positionId: p.id, studentId: "ada", photo: JPEG });
  assert.ok(c.photo?.startsWith("https://cdn.example/"));
  assert.equal((await rejection(w.svc.addCandidate(hodC, e.id, { positionId: p.id, studentId: "ben", photo: Buffer.from("not an image") }))).status, 415);
  assert.equal(w.uploaded.length, 1); // the bad file never reached storage
  assert.equal((await rejection(w.svc.addCandidate(hodC, e.id, { positionId: p.id, studentId: "ada", photo: JPEG }))).code, "DUPLICATE_CANDIDATE");
  assert.equal(w.uploaded.length, 1); // duplicate is rejected BEFORE uploading
});
test("14. Photo changes are blocked once voting is open", async () => {
  const w = makeElectionWorld();
  const { e, a } = await w.ready();
  await w.svc.openNow(hodC, e.id);
  assert.equal((await rejection(w.svc.setCandidatePhoto(hodC, e.id, a.id, JPEG))).code, "ELECTION_LOCKED");
});

/* ============================ publish / open / close ============================ */
test("15. Publishing needs positions, an approved candidate in each, voters and a future start", async () => {
  const w = makeElectionWorld();
  const e = await w.svc.create(hodC, { title: "Not ready", votingOpensAt: mins(60), votingClosesAt: mins(600) });
  let r = await rejection(w.svc.publish(hodC, e.id));
  assert.equal(r.code, "ELECTION_NOT_READY");
  assert.deepEqual(r.details, ["Add at least one position."]);
  const p = await w.svc.createPosition(hodC, e.id, { title: "President" });
  await w.svc.addCandidate(hodC, e.id, { positionId: p.id, studentId: "ada" }); // pending only
  r = await rejection(w.svc.publish(hodC, e.id));
  assert.deepEqual(r.details, ['"President" has no approved candidate.']);
  assert.equal((await w.svc.readinessReport(hodC, e.id)).ready, false);
  const cand = w.store.candidates[0]; await w.svc.decideCandidate(hodC, e.id, cand.id, "APPROVED");
  assert.equal((await w.svc.readinessReport(hodC, e.id)).ready, true);
  w.clock.now = mins(61);
  assert.equal((await rejection(w.svc.publish(hodC, e.id))).code, "INVALID_SCHEDULE"); // start passed
});
test("16. Status lifecycle: Draft -> Scheduled -> Active -> Closed, following the clock and the HOD's actions", async () => {
  const w = makeElectionWorld();
  const { e } = await w.ready();
  assert.equal(e.status, "DRAFT");
  const pub = await w.svc.publish(hodC, e.id, meta);
  assert.equal(pub.status, "SCHEDULED");
  assert.equal(w.notes.length, 1);
  w.clock.now = mins(61); assert.equal((await w.svc.get(hodC, e.id)).status, "ACTIVE");
  w.clock.now = mins(60 * 24 + 1); assert.equal((await w.svc.get(hodC, e.id)).status, "CLOSED");
  assert.deepEqual((await w.svc.list(hodC, q({ status: undefined, lifecycle: "CLOSED" }))).items.map((x) => x.id), [e.id]);
  assert.equal((await w.svc.list(hodC, q({ lifecycle: "ACTIVE" }))).total, 0);
});
test("17. Open now begins voting immediately (from draft or scheduled); close now ends it", async () => {
  const w = makeElectionWorld();
  const { e } = await w.ready();
  const open = await w.svc.openNow(hodC, e.id, meta);
  assert.equal(open.status, "ACTIVE");
  assert.equal(w.store.elections[0].status, "PUBLISHED");
  assert.equal((await rejection(w.svc.openNow(hodC, e.id))).status, 409);
  w.clock.now = mins(10);
  const closed = await w.svc.closeNow(hodC, e.id, meta);
  assert.equal(closed.status, "CLOSED");
  assert.equal((await rejection(w.svc.closeNow(hodC, e.id))).status, 409);
  assert.ok(w.store.audit.some((a) => a.action === "ELECTION_OPENED") && w.store.audit.some((a) => a.action === "ELECTION_CLOSED"));
  // scheduled one opened early
  const two = await w.ready("Second"); await w.svc.publish(hodC, two.e.id);
  assert.equal((await w.svc.openNow(hodC, two.e.id)).status, "ACTIVE");
});
test("18. Once voting could begin, the ballot is frozen: details, electorate, positions and candidates", async () => {
  const w = makeElectionWorld();
  const { e, p, a } = await w.ready();
  await w.svc.publish(hodC, e.id);
  await w.svc.update(hodC, e.id, { title: "Still editable while scheduled" }); // scheduled: fine
  assert.equal((await rejection(w.svc.update(hodC, e.id, { votingOpensAt: mins(-5), votingClosesAt: mins(600) }))).status, 422); // can't back-date a scheduled start
  w.clock.now = mins(61); // active
  const locked = [
    w.svc.update(hodC, e.id, { title: "x" }), w.svc.createPosition(hodC, e.id, { title: "Treasurer" }), w.svc.updatePosition(hodC, e.id, p.id, { title: "y" }), w.svc.deletePosition(hodC, e.id, p.id),
    w.svc.reorderPositions(hodC, e.id, [p.id]), w.svc.addCandidate(hodC, e.id, { positionId: p.id, studentId: "cy" }), w.svc.updateCandidate(hodC, e.id, a.id, { manifesto: "z" }),
    w.svc.decideCandidate(hodC, e.id, a.id, "REJECTED"), w.svc.removeCandidate(hodC, e.id, a.id), w.svc.remove(hodC, e.id),
  ];
  for (const x of locked) assert.ok([409].includes((await rejection(x)).status));
  assert.equal(w.store.candidates.length, 2);
  w.clock.now = mins(60 * 24 + 1); // closed
  assert.equal((await rejection(w.svc.update(hodC, e.id, { title: "x" }))).code, "ELECTION_LOCKED");
});
test("19. Only drafts are deleted; scheduled / active elections are cancelled and keep their records", async () => {
  const w = makeElectionWorld();
  const d = await w.svc.create(hodC, { title: "Throwaway", votingOpensAt: mins(60), votingClosesAt: mins(600) });
  await w.svc.remove(hodC, d.id, meta);
  assert.equal(w.store.elections.length, 0);
  const { e } = await w.ready(); await w.svc.publish(hodC, e.id);
  assert.equal((await rejection(w.svc.remove(hodC, e.id))).status, 409);
  assert.equal((await w.svc.cancel(hodC, e.id, meta)).status, "CANCELLED");
  assert.equal(w.store.elections[0].status, "CANCELLED");
  assert.equal((await rejection(w.svc.cancel(hodC, e.id))).status, 409);
  assert.equal((await rejection(w.svc.update(hodC, e.id, { title: "x" }))).code, "ELECTION_LOCKED");
});

/* ============================ turnout / results ============================ */
function castVotes(w: ReturnType<typeof makeElectionWorld>, electionId: string, positionId: string, voter: string, candidateId: string) {
  w.store.participation.push({ electionId, positionId, studentId: voter });
  w.store.votes.push({ electionId, positionId, candidateId });
}
test("20. Turnout (counts only) is visible while voting; tallies stay hidden until the election closes", async () => {
  const w = makeElectionWorld();
  const { e, p, a, b } = await w.ready();
  assert.equal((await rejection(w.svc.turnout(hodC, e.id))).status, 409); // draft
  await w.svc.openNow(hodC, e.id);
  castVotes(w, e.id, p.id, "cy", a.id); castVotes(w, e.id, p.id, "dee", a.id); castVotes(w, e.id, p.id, "eli", b.id);
  const t = await w.svc.turnout(hodC, e.id);
  assert.deepEqual([t.eligibleVoters, t.votersWhoVoted, t.turnoutPercentage, t.notYetVoted], [5, 3, 60, 2]);
  assert.deepEqual(t.positions[0], { id: p.id, title: "President", votesCast: 3, turnoutPercentage: 60 });
  assert.ok(!JSON.stringify(t).includes(a.id)); // nothing about candidates
  const early = await rejection(w.svc.results(hodC, e.id));
  assert.deepEqual([early.status, early.code], [403, "RESULTS_NOT_AVAILABLE"]);
});
test("21. After closing: ranked results, winner, ties and turnout; releasing them to students is a separate step", async () => {
  const w = makeElectionWorld();
  const { e, p, a, b } = await w.ready();
  await w.svc.openNow(hodC, e.id);
  castVotes(w, e.id, p.id, "cy", a.id); castVotes(w, e.id, p.id, "dee", a.id); castVotes(w, e.id, p.id, "eli", b.id);
  assert.equal((await rejection(w.svc.setResultsPublished(hodC, e.id, true))).status, 409); // still open
  w.clock.now = mins(5); await w.svc.closeNow(hodC, e.id);
  const r = await w.svc.results(hodC, e.id, meta);
  assert.deepEqual([r.eligibleVoters, r.votersWhoVoted, r.turnoutPercentage], [5, 3, 60]);
  const pos = r.positions[0];
  assert.deepEqual(pos.candidates.map((c) => [c.student.name, c.votes, c.percentage]), [["Ada Obi", 2, 66.7], ["Ben Musa", 1, 33.3]]);
  assert.deepEqual([pos.winnerId, pos.isTie, pos.totalVotes], [a.id, false, 3]);
  assert.equal(r.election.resultsPublished, false);
  const rel = await w.svc.setResultsPublished(hodC, e.id, true, meta);
  assert.equal(rel.resultsPublished, true);
  assert.equal(w.store.elections[0].resultsPublished, true);
  assert.equal(w.notes.at(-1)!.title, "Election results");
  castVotes(w, e.id, p.id, "ada", b.id); // 2-2 tie
  assert.deepEqual([(await w.svc.results(hodC, e.id)).positions[0].isTie, (await w.svc.results(hodC, e.id)).positions[0].winnerId], [true, null]);
});
test("22. A cancelled election has no results; unapproved candidates never appear in results", async () => {
  const w = makeElectionWorld();
  const { e, p, a } = await w.ready();
  const pending = await w.svc.addCandidate(hodC, e.id, { positionId: p.id, studentId: "cy" });
  await w.svc.openNow(hodC, e.id);
  castVotes(w, e.id, p.id, "dee", a.id);
  w.clock.now = mins(5); await w.svc.closeNow(hodC, e.id);
  assert.ok((await w.svc.results(hodC, e.id)).positions[0].candidates.every((c) => c.id !== pending.id));
  const x = await w.ready("Another"); await w.svc.publish(hodC, x.e.id); await w.svc.cancel(hodC, x.e.id);
  assert.equal((await rejection(w.svc.results(hodC, x.e.id))).code, "RESULTS_NOT_AVAILABLE");
});

/* ============================ department isolation ============================ */
test("23. A CSC HOD cannot see or touch an MLS election, position or candidate (404, audited)", async () => {
  const w = makeElectionWorld();
  const mls = await w.svc.create(hodM, { title: "MLS Election", votingOpensAt: mins(60), votingClosesAt: mins(600) });
  const pos = await w.svc.createPosition(hodM, mls.id, { title: "President" });
  const cand = await w.svc.addCandidate(hodM, mls.id, { positionId: pos.id, studentId: "mia", approve: true });
  const attempts = [
    w.svc.get(hodC, mls.id), w.svc.update(hodC, mls.id, { title: "hijack" }), w.svc.remove(hodC, mls.id), w.svc.publish(hodC, mls.id), w.svc.openNow(hodC, mls.id), w.svc.closeNow(hodC, mls.id),
    w.svc.cancel(hodC, mls.id), w.svc.turnout(hodC, mls.id), w.svc.results(hodC, mls.id), w.svc.setResultsPublished(hodC, mls.id, true), w.svc.readinessReport(hodC, mls.id),
    w.svc.listPositions(hodC, mls.id), w.svc.createPosition(hodC, mls.id, { title: "Treasurer" }), w.svc.updatePosition(hodC, mls.id, pos.id, { title: "x" }), w.svc.deletePosition(hodC, mls.id, pos.id),
    w.svc.reorderPositions(hodC, mls.id, [pos.id]), w.svc.listCandidates(hodC, mls.id, undefined), w.svc.addCandidate(hodC, mls.id, { positionId: pos.id, studentId: "ada" }),
    w.svc.decideCandidate(hodC, mls.id, cand.id, "REJECTED"), w.svc.removeCandidate(hodC, mls.id, cand.id), w.svc.setCandidatePhoto(hodC, mls.id, cand.id, JPEG), w.svc.updateCandidate(hodC, mls.id, cand.id, { manifesto: "x" }),
  ];
  for (const x of attempts) assert.equal((await rejection(x)).status, 404);
  assert.equal(w.store.elections[0].title, "MLS Election");
  assert.equal(w.store.candidates[0].status, "APPROVED");
  assert.ok(w.store.audit.filter((a) => a.action === "ACCESS_DENIED").length >= attempts.length);
  assert.equal((await w.svc.list(hodC, q())).total, 0);
  assert.equal((await w.svc.list(hodM, q())).total, 1);
});
test("24. A position or candidate of another department can't be reached through your own election", async () => {
  const w = makeElectionWorld();
  const mls = await w.svc.create(hodM, { title: "MLS Election", votingOpensAt: mins(60), votingClosesAt: mins(600) });
  const mlsPos = await w.svc.createPosition(hodM, mls.id, { title: "President" });
  const mine = await w.svc.create(hodC, { title: "Mine", votingOpensAt: mins(60), votingClosesAt: mins(600) });
  assert.equal((await rejection(w.svc.addCandidate(hodC, mine.id, { positionId: mlsPos.id, studentId: "ada" }))).status, 404);
  assert.equal((await rejection(w.svc.updatePosition(hodC, mine.id, mlsPos.id, { title: "x" }))).status, 404);
});
test("25. Listing is filtered by status and paginated", async () => {
  const w = makeElectionWorld();
  for (let i = 0; i < 3; i++) await w.svc.create(hodC, { title: `Draft ${i}`, votingOpensAt: mins(60), votingClosesAt: mins(600) });
  const live = await w.ready("Live"); await w.svc.openNow(hodC, live.e.id);
  assert.equal((await w.svc.list(hodC, q())).total, 4);
  assert.equal((await w.svc.list(hodC, q({ lifecycle: "DRAFT" }))).total, 3);
  const page = await w.svc.list(hodC, q({ limit: 2, page: 2 }));
  assert.deepEqual([page.items.length, page.totalPages], [2, 2]);
  assert.deepEqual((await w.svc.list(hodC, q({ search: "live" }))).items.map((i) => i.title), ["Live"]);
  assert.equal(page.items[0].actions.edit, true);
});
