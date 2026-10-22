import { LEVEL_REGEX, MAX_ELECTION_GROUP_SIZE, type ElectorateMode } from "../../../utils/constants";
import { isEditable, type ElectionLifecycle } from "../../election-rules";

export const MIN_VOTING_MINUTES = 5;

/** Cleaned electorate, or a message explaining what is wrong (the service adds the department-membership check for GROUP). */
export function checkElectorate(i: { mode: ElectorateMode; levels?: string[]; studentIds?: string[] }, deptLevels: string[]):
  { ok: true; mode: ElectorateMode; levels: string[]; studentIds: string[] } | { ok: false; reason: string } {
  const levels = [...new Set(i.levels ?? [])];
  const studentIds = [...new Set(i.studentIds ?? [])];
  if (i.mode === "DEPARTMENT") {
    if (levels.length || studentIds.length) return { ok: false, reason: "An election open to the entire department can't also list levels or students." };
    return { ok: true, mode: "DEPARTMENT", levels: [], studentIds: [] };
  }
  if (i.mode === "LEVELS") {
    if (!levels.length) return { ok: false, reason: "Choose at least one level." };
    if (studentIds.length) return { ok: false, reason: "A level-based election can't also list individual students." };
    const bad = levels.find((l) => !LEVEL_REGEX.test(l) || !deptLevels.includes(l));
    if (bad) return { ok: false, reason: `Level ${bad} isn't offered by your department.` };
    return { ok: true, mode: "LEVELS", levels, studentIds: [] };
  }
  if (!studentIds.length) return { ok: false, reason: "Choose at least one student for the voter group." };
  if (levels.length) return { ok: false, reason: "A voter group can't also list levels." };
  if (studentIds.length > MAX_ELECTION_GROUP_SIZE) return { ok: false, reason: `A voter group can have at most ${MAX_ELECTION_GROUP_SIZE} students.` };
  return { ok: true, mode: "GROUP", levels: [], studentIds };
}

/** Voting window rules. `requireFuture` is true for anything that is scheduled (not for drafts the HOD is still shaping). */
export function checkSchedule(opens: Date, closes: Date, now: Date, requireFuture: boolean): string | null {
  if (Number.isNaN(opens.getTime()) || Number.isNaN(closes.getTime())) return "Enter a valid start and end date/time.";
  if (closes.getTime() - opens.getTime() < MIN_VOTING_MINUTES * 60_000) return `Voting must stay open for at least ${MIN_VOTING_MINUTES} minutes.`;
  if (requireFuture && opens <= now) return "The start time must be in the future. To begin voting right away, use Open now.";
  if (requireFuture && closes <= now) return "The end time must be in the future.";
  return null;
}

export interface ReadinessInput {
  positions: { title: string; approvedCandidates: number }[];
  eligibleVoters: number;
}
/** Everything that must be true before voting can be scheduled or opened. Returns every problem at once. */
export function readinessProblems(i: ReadinessInput): string[] {
  const out: string[] = [];
  if (!i.positions.length) out.push("Add at least one position.");
  for (const p of i.positions) if (p.approvedCandidates < 1) out.push(`"${p.title}" has no approved candidate.`);
  if (i.eligibleVoters < 1) out.push("No active student matches the voter eligibility settings.");
  return out;
}

export type ElectionAction = "edit" | "publish" | "open" | "close" | "cancel" | "delete" | "publishResults";
export function allowedActions(l: ElectionLifecycle, resultsPublished: boolean): Record<ElectionAction, boolean> {
  return {
    edit: isEditable(l), publish: l === "DRAFT", open: l === "DRAFT" || l === "SCHEDULED", close: l === "ACTIVE",
    cancel: l === "SCHEDULED" || l === "ACTIVE", delete: l === "DRAFT", publishResults: l === "CLOSED" && !resultsPublished,
  };
}
