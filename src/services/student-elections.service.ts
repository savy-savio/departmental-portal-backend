import type { DepartmentDocument } from "../models/Department";
import { Student } from "../models/Student";
import type { StudentDocument } from "../models/Student";
import { Election, ElectionDocument } from "../models/Election";
import { ElectionCandidate, ElectionCandidateDocument } from "../models/ElectionCandidate";
import { ElectionPosition } from "../models/ElectionPosition";
import { Vote, VoteParticipation } from "../models/Ballot";
import { AppError } from "../utils/AppError";
import type { CastVotesInput } from "../validators/student-elections.validators";
import { ElectionScope, ElectionPhase, isEligibleVoter, leadingCandidate, phaseOf, resultsVisible } from "./election-rules";
import { notify } from "./notification.service";

const idStr = (v: unknown) => String(v);

const electionScope = (e: ElectionDocument): ElectionScope => ({
  departmentId: idStr(e.department),
  academicSession: e.academicSession,
  eligibleLevels: e.eligibleLevels ?? [],
  electorateMode: e.electorateMode ?? "DEPARTMENT",
  eligibleStudentIds: (e.eligibleStudents ?? []).map(idStr),
  status: e.status,
  votingOpensAt: e.votingOpensAt,
  votingClosesAt: e.votingClosesAt,
  resultsPublished: e.resultsPublished,
});

const voterScope = (s: StudentDocument) => ({
  studentId: idStr(s._id),
  departmentId: idStr(s.department),
  level: s.level,
  academicSession: s.academicSession,
});

function electionDTO(e: ElectionDocument, phase: ElectionPhase, now: Date) {
  return {
    id: idStr(e._id),
    title: e.title,
    description: e.description ?? null,
    academicSession: e.academicSession,
    votingOpensAt: e.votingOpensAt,
    votingClosesAt: e.votingClosesAt,
    phase,
    resultsAvailable: resultsVisible(electionScope(e), now),
  };
}

/**
 * Loads an election only if this student is eligible for it. Other department / other level /
 * draft / wrong-session all look identical to a missing election (404), so nothing leaks.
 */
async function loadEligible(student: StudentDocument, department: DepartmentDocument, electionId: string): Promise<ElectionDocument> {
  const election = await Election.findOne({ _id: electionId, department: department._id, status: "PUBLISHED" });
  if (!election || !isEligibleVoter(voterScope(student), electionScope(election))) {
    throw new AppError(404, "Election not found.");
  }
  return election;
}

async function candidateViews(candidates: ElectionCandidateDocument[]) {
  const students = await Student.find({ _id: { $in: candidates.map((c) => c.student) } }).select("firstName lastName level profilePhoto");
  const byId = new Map(students.map((s) => [idStr(s._id), s]));
  return candidates
    .map((c) => {
      const s = byId.get(idStr(c.student));
      return {
        id: idStr(c._id),
        positionId: idStr(c.position),
        name: s ? `${s.firstName} ${s.lastName}` : "Unknown",
        sortKey: s ? `${s.lastName} ${s.firstName}`.toLowerCase() : "",
        level: s?.level ?? null,
        photo: c.photo ?? s?.profilePhoto ?? null,
        manifesto: c.manifesto ?? null,
      };
    })
    // Alphabetical: no candidate gets a better spot on the ballot than another.
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

/* ------------------------------ list ------------------------------ */
export async function listElections(student: StudentDocument, department: DepartmentDocument) {
  const elections = await Election.find({
    department: department._id,
    status: "PUBLISHED",
    academicSession: student.academicSession,
    $or: [
      { electorateMode: "GROUP", eligibleStudents: student._id },
      { electorateMode: "LEVELS", eligibleLevels: student.level },
      // DEPARTMENT mode, and legacy rows that predate electorateMode (empty levels = everyone, else the listed levels).
      { electorateMode: { $in: ["DEPARTMENT", null] }, eligibleLevels: { $size: 0 } },
      { electorateMode: { $in: ["DEPARTMENT", null] }, eligibleLevels: student.level },
    ],
  }).sort({ votingOpensAt: -1 });

  const ids = elections.map((e) => e._id);
  const [positions, mine] = await Promise.all([
    ElectionPosition.aggregate<{ _id: unknown; n: number }>([{ $match: { election: { $in: ids } } }, { $group: { _id: "$election", n: { $sum: 1 } } }]),
    VoteParticipation.aggregate<{ _id: unknown; n: number }>([{ $match: { election: { $in: ids }, student: student._id } }, { $group: { _id: "$election", n: { $sum: 1 } } }]),
  ]);
  const positionCount = new Map<string, number>(positions.map((p) => [idStr(p._id), p.n]));
  const votedCount = new Map<string, number>(mine.map((p) => [idStr(p._id), p.n]));
  const now = new Date();

  return elections.map((e) => {
    const total = positionCount.get(idStr(e._id)) ?? 0;
    const voted = votedCount.get(idStr(e._id)) ?? 0;
    return { ...electionDTO(e, phaseOf(e, now), now), positionCount: total, votedCount: voted, hasVotedAll: total > 0 && voted >= total };
  });
}

/* ------------------------------ detail ------------------------------ */
export async function getElection(student: StudentDocument, department: DepartmentDocument, electionId: string) {
  const election = await loadEligible(student, department, electionId);
  const now = new Date();

  const [positions, candidates, mine] = await Promise.all([
    ElectionPosition.find({ election: election._id }).sort({ order: 1, title: 1 }),
    ElectionCandidate.find({ election: election._id, status: "APPROVED" }),
    VoteParticipation.find({ election: election._id, student: student._id }).select("position"),
  ]);
  const votedPositions = new Set(mine.map((m) => idStr(m.position)));
  const views = await candidateViews(candidates);

  return {
    ...electionDTO(election, phaseOf(election, now), now),
    positions: positions.map((p) => ({
      id: idStr(p._id),
      title: p.title,
      description: p.description ?? null,
      hasVoted: votedPositions.has(idStr(p._id)),
      // Candidate sort keys are internal; strip them from the response.
      candidates: views.filter((c) => c.positionId === idStr(p._id)).map(({ sortKey: _k, positionId: _p, ...c }) => c),
    })),
  };
}

/* ------------------------------ vote ------------------------------ */
export async function castVotes(student: StudentDocument, department: DepartmentDocument, electionId: string, input: CastVotesInput) {
  const election = await loadEligible(student, department, electionId);
  const phase = phaseOf(election, new Date());
  if (phase === "UPCOMING") throw new AppError(403, "Voting has not opened yet.");
  if (phase === "CLOSED") throw new AppError(403, "Voting has closed.");

  const positionIds = input.votes.map((v) => v.positionId);
  if (new Set(positionIds).size !== positionIds.length) throw new AppError(422, "You can only vote once per position.");

  // Every position and candidate must belong to THIS election, and the candidate must stand for THAT position.
  const [positions, candidates] = await Promise.all([
    ElectionPosition.find({ _id: { $in: positionIds }, election: election._id }),
    ElectionCandidate.find({ _id: { $in: input.votes.map((v) => v.candidateId) }, election: election._id, status: "APPROVED" }),
  ]);
  if (positions.length !== positionIds.length) throw new AppError(422, "One of the selected positions is not part of this election.");
  const candidateById = new Map(candidates.map((c) => [idStr(c._id), c]));
  for (const v of input.votes) {
    const c = candidateById.get(v.candidateId);
    if (!c || idStr(c.position) !== v.positionId) throw new AppError(422, "One of the selected candidates is not standing for that position.");
  }

  // Fast, friendly pre-check; the unique index below is what actually guarantees one vote per position.
  const already = await VoteParticipation.countDocuments({ student: student._id, position: { $in: positionIds } });
  if (already > 0) throw new AppError(409, "You have already voted for one of these positions.");

  const created: { participationId: unknown; voteId: string }[] = [];
  try {
    for (const v of input.votes) {
      // 1) claim the slot (unique on position+student), 2) record the anonymous vote.
      const participation = await VoteParticipation.create({
        election: election._id, position: v.positionId, student: student._id, department: department._id,
      });
      try {
        const vote = await Vote.create({ election: election._id, position: v.positionId, candidate: v.candidateId });
        created.push({ participationId: participation._id, voteId: vote._id });
      } catch (err) {
        await VoteParticipation.deleteOne({ _id: participation._id });
        throw err;
      }
    }
  } catch (err) {
    // All-or-nothing for this request: undo anything already recorded.
    for (const c of created) {
      await Vote.deleteOne({ _id: c.voteId }).catch(() => undefined);
      await VoteParticipation.deleteOne({ _id: c.participationId }).catch(() => undefined);
    }
    if ((err as { code?: number }).code === 11000) throw new AppError(409, "You have already voted for one of these positions.");
    throw err;
  }

  // Deliberately says nothing about WHO was voted for.
  await notify({
    recipient: student._id, department: department._id, kind: "SYSTEM",
    title: "Vote recorded", body: `Your vote in "${election.title}" has been recorded.`, link: "/student/elections",
  });
  return { votedPositionIds: positionIds, message: "Your vote has been recorded." };
}

/* ------------------------------ results ------------------------------ */
export async function getResults(student: StudentDocument, department: DepartmentDocument, electionId: string) {
  const election = await loadEligible(student, department, electionId);
  const now = new Date();
  if (!resultsVisible(electionScope(election), now)) {
    throw new AppError(403, "Results are not available yet.");
  }

  const mode = election.electorateMode ?? "DEPARTMENT";
  const levelFilter =
    mode === "GROUP" ? { _id: { $in: election.eligibleStudents } } : mode === "LEVELS" || election.eligibleLevels.length ? { level: { $in: election.eligibleLevels } } : {};
  const [positions, candidates, tallies, turnout, eligibleVoters] = await Promise.all([
    ElectionPosition.find({ election: election._id }).sort({ order: 1, title: 1 }),
    ElectionCandidate.find({ election: election._id, status: "APPROVED" }),
    Vote.aggregate<{ _id: unknown; votes: number }>([{ $match: { election: election._id } }, { $group: { _id: "$candidate", votes: { $sum: 1 } } }]),
    VoteParticipation.aggregate<{ _id: unknown; n: number }>([{ $match: { election: election._id } }, { $group: { _id: "$position", n: { $sum: 1 } } }]),
    Student.countDocuments({ department: department._id, academicSession: election.academicSession, status: "ACTIVE", ...levelFilter }),
  ]);

  const votesFor = new Map<string, number>(tallies.map((t) => [idStr(t._id), t.votes]));
  const turnoutFor = new Map<string, number>(turnout.map((t) => [idStr(t._id), t.n]));
  const views = await candidateViews(candidates);

  return {
    ...electionDTO(election, "CLOSED", now),
    eligibleVoters,
    positions: positions.map((p) => {
      const ranked = views
        .filter((c) => c.positionId === idStr(p._id))
        .map(({ sortKey: _k, positionId: _p, ...c }) => ({ ...c, votes: votesFor.get(c.id) ?? 0 }))
        .sort((a, b) => b.votes - a.votes);
      const { winner, isTie } = leadingCandidate(ranked);
      const voted = turnoutFor.get(idStr(p._id)) ?? 0;
      return {
        id: idStr(p._id),
        title: p.title,
        totalVotes: ranked.reduce((a, c) => a + c.votes, 0),
        turnoutPercentage: eligibleVoters ? Math.round((voted / eligibleVoters) * 1000) / 10 : null,
        isTie,
        winnerId: winner?.id ?? null,
        candidates: ranked,
      };
    }),
  };
}
