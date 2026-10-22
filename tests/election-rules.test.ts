import { test } from "node:test";
import assert from "node:assert/strict";
import { ElectionScope, VoterScope, isEligibleVoter, leadingCandidate, phaseOf, resultsVisible } from "../src/services/election-rules";

const T = (iso: string) => new Date(iso);
const election = (over: Partial<ElectionScope> = {}): ElectionScope => ({
  departmentId: "csc", academicSession: "2026/2027", eligibleLevels: [], status: "PUBLISHED",
  votingOpensAt: T("2026-10-10T08:00:00Z"), votingClosesAt: T("2026-10-10T18:00:00Z"), resultsPublished: false, ...over,
});
const voter: VoterScope = { departmentId: "csc", level: "200", academicSession: "2026/2027" };

test("phase follows the voting window", () => {
  const e = election();
  assert.equal(phaseOf(e, T("2026-10-10T07:59:00Z")), "UPCOMING");
  assert.equal(phaseOf(e, T("2026-10-10T12:00:00Z")), "OPEN");
  assert.equal(phaseOf(e, T("2026-10-10T18:00:01Z")), "CLOSED");
});

test("only students of the election's own department are eligible", () => {
  assert.equal(isEligibleVoter(voter, election()), true);
  assert.equal(isEligibleVoter({ ...voter, departmentId: "mls" }, election()), false);
});

test("level restriction and session match are enforced", () => {
  assert.equal(isEligibleVoter(voter, election({ eligibleLevels: ["200", "300"] })), true);
  assert.equal(isEligibleVoter({ ...voter, level: "100" }, election({ eligibleLevels: ["200", "300"] })), false);
  assert.equal(isEligibleVoter({ ...voter, academicSession: "2025/2026" }, election()), false);
});

test("drafts and cancelled elections are never eligible", () => {
  assert.equal(isEligibleVoter(voter, election({ status: "DRAFT" })), false);
  assert.equal(isEligibleVoter(voter, election({ status: "CANCELLED" })), false);
});

test("results need: published flag AND voting closed", () => {
  const closed = T("2026-10-11T00:00:00Z");
  assert.equal(resultsVisible(election({ resultsPublished: true }), closed), true);
  assert.equal(resultsVisible(election({ resultsPublished: false }), closed), false);
  assert.equal(resultsVisible(election({ resultsPublished: true }), T("2026-10-10T12:00:00Z")), false);
  assert.equal(resultsVisible(election({ resultsPublished: true, status: "CANCELLED" }), closed), false);
});

test("leading candidate handles ties and zero votes", () => {
  assert.equal(leadingCandidate([{ votes: 5 }, { votes: 2 }]).winner?.votes, 5);
  assert.deepEqual(leadingCandidate([{ votes: 4 }, { votes: 4 }]), { winner: null, isTie: true });
  assert.deepEqual(leadingCandidate([{ votes: 0 }, { votes: 0 }]), { winner: null, isTie: false });
  assert.deepEqual(leadingCandidate([]), { winner: null, isTie: false });
});

/* ---- electorate modes & lifecycle (HOD election management) ---- */
import { inElectorate, isEditable, lifecycleOf } from "../src/services/election-rules";
test("electorate: DEPARTMENT, LEVELS and GROUP are enforced by the rules the vote endpoint uses", () => {
  const v: VoterScope = { ...voter, studentId: "s1" };
  assert.equal(isEligibleVoter(v, election({ electorateMode: "DEPARTMENT" })), true);
  assert.equal(isEligibleVoter(v, election({ electorateMode: "LEVELS", eligibleLevels: ["200"] })), true);
  assert.equal(isEligibleVoter(v, election({ electorateMode: "LEVELS", eligibleLevels: ["300"] })), false);
  assert.equal(isEligibleVoter(v, election({ electorateMode: "LEVELS", eligibleLevels: [] })), false); // an empty level list never means "everyone" in LEVELS mode
  assert.equal(isEligibleVoter(v, election({ electorateMode: "GROUP", eligibleStudentIds: ["s1", "s2"] })), true);
  assert.equal(isEligibleVoter(v, election({ electorateMode: "GROUP", eligibleStudentIds: ["s2"] })), false);
  assert.equal(isEligibleVoter({ ...v, studentId: undefined }, election({ electorateMode: "GROUP", eligibleStudentIds: ["s1"] })), false);
  assert.equal(isEligibleVoter({ ...v, departmentId: "mls" }, election({ electorateMode: "GROUP", eligibleStudentIds: ["s1"] })), false);
  assert.equal(isEligibleVoter(v, election({ electorateMode: "GROUP", eligibleStudentIds: ["s1"], status: "DRAFT" })), false);
  assert.equal(inElectorate(v, { eligibleLevels: [] }), true); // legacy rows without a mode
});
test("lifecycle: Draft / Scheduled / Active / Closed / Cancelled, and when structure is editable", () => {
  const e = election();
  assert.equal(lifecycleOf({ ...e, status: "DRAFT" }, T("2026-10-10T12:00:00Z")), "DRAFT");
  assert.equal(lifecycleOf(e, T("2026-10-10T07:00:00Z")), "SCHEDULED");
  assert.equal(lifecycleOf(e, T("2026-10-10T12:00:00Z")), "ACTIVE");
  assert.equal(lifecycleOf(e, T("2026-10-10T19:00:00Z")), "CLOSED");
  assert.equal(lifecycleOf({ ...e, status: "CANCELLED" }, T("2026-10-10T12:00:00Z")), "CANCELLED");
  assert.deepEqual((["DRAFT", "SCHEDULED", "ACTIVE", "CLOSED", "CANCELLED"] as const).map(isEditable), [true, true, false, false, false]);
});
