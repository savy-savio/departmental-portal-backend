/** Pure election rules (no database) so they are unit-tested and reusable by the election-admin phase. */
export type ElectionPhase = "UPCOMING" | "OPEN" | "CLOSED";

export interface ElectionScope {
  departmentId: string;
  academicSession: string;
  eligibleLevels: string[];
  /** Absent / DEPARTMENT on legacy rows. LEVELS uses eligibleLevels; GROUP uses eligibleStudentIds. */
  electorateMode?: "DEPARTMENT" | "LEVELS" | "GROUP";
  eligibleStudentIds?: string[];
  status: "DRAFT" | "PUBLISHED" | "CANCELLED";
  votingOpensAt: Date;
  votingClosesAt: Date;
  resultsPublished: boolean;
}
export interface VoterScope {
  /** Needed for GROUP elections. */
  studentId?: string;
  departmentId: string;
  level: string;
  academicSession: string;
}

export function phaseOf(e: Pick<ElectionScope, "votingOpensAt" | "votingClosesAt">, now: Date): ElectionPhase {
  if (now < e.votingOpensAt) return "UPCOMING";
  if (now > e.votingClosesAt) return "CLOSED";
  return "OPEN";
}

/** Same department, published, the student's session matches, and (if levels are set) their level is listed. */
export function isEligibleVoter(voter: VoterScope, e: ElectionScope): boolean {
  if (e.status !== "PUBLISHED") return false;
  if (e.departmentId !== voter.departmentId) return false;
  if (e.academicSession !== voter.academicSession) return false;
  return inElectorate(voter, e);
}

/** The electorate rule alone (department, session and publication are checked by the caller / above). */
export function inElectorate(voter: VoterScope, e: Pick<ElectionScope, "electorateMode" | "eligibleLevels" | "eligibleStudentIds">): boolean {
  switch (e.electorateMode ?? "DEPARTMENT") {
    case "GROUP":
      return Boolean(voter.studentId) && (e.eligibleStudentIds ?? []).includes(voter.studentId!);
    case "LEVELS":
      return e.eligibleLevels.includes(voter.level);
    default:
      // Legacy rows: DEPARTMENT mode with a non-empty level list was the old "specific levels" setting.
      return e.eligibleLevels.length === 0 || e.eligibleLevels.includes(voter.level);
  }
}

/** Lifecycle shown to the HOD. DRAFT / CANCELLED are stored; SCHEDULED / ACTIVE / CLOSED follow the clock. */
export type ElectionLifecycle = "DRAFT" | "SCHEDULED" | "ACTIVE" | "CLOSED" | "CANCELLED";
export function lifecycleOf(e: Pick<ElectionScope, "status" | "votingOpensAt" | "votingClosesAt">, now: Date): ElectionLifecycle {
  if (e.status === "DRAFT") return "DRAFT";
  if (e.status === "CANCELLED") return "CANCELLED";
  const p = phaseOf(e, now);
  return p === "UPCOMING" ? "SCHEDULED" : p === "OPEN" ? "ACTIVE" : "CLOSED";
}
/** Structure (details, electorate, positions, candidates) is editable only until voting could begin: drafts and scheduled elections. */
export const isEditable = (l: ElectionLifecycle) => l === "DRAFT" || l === "SCHEDULED";

export function resultsVisible(e: ElectionScope, now: Date): boolean {
  return e.status === "PUBLISHED" && e.resultsPublished && phaseOf(e, now) === "CLOSED";
}

/** Winner(s) = candidates sharing the top vote count; a tie (or no votes) means no single winner. */
export function leadingCandidate<T extends { votes: number }>(sortedDesc: T[]): { winner: T | null; isTie: boolean } {
  if (!sortedDesc.length || sortedDesc[0].votes === 0) return { winner: null, isTie: false };
  const tied = sortedDesc.filter((c) => c.votes === sortedDesc[0].votes).length > 1;
  return { winner: tied ? null : sortedDesc[0], isTie: tied };
}
