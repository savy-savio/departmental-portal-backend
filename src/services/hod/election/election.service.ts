import { AppError } from "../../../utils/AppError";
import { sniffImage } from "../../../utils/image";
import type { ElectorateMode } from "../../../utils/constants";
import { StoreDuplicateError } from "../store";
import type { HodActor, HodMeta, ListQuery, Page } from "../types";
import { isEditable, leadingCandidate, lifecycleOf, type ElectionLifecycle } from "../../election-rules";
import { allowedActions, checkElectorate, checkSchedule, readinessProblems } from "./rules";
import type { ElectionStore } from "./store";
import type { CandidateRec, ElectionRec, StudentRef } from "./types";

export interface ElectionNotify { kind: string; title: string; body: string; link?: string }
export interface ElectionDeps {
  store: ElectionStore;
  now: () => Date;
  uploadCandidatePhoto: (buffer: Buffer, electionId: string) => Promise<{ url: string; publicId: string }>;
  deleteCandidatePhoto: (publicId: string) => Promise<void>;
  /** Best-effort notification to every voter in the electorate. */
  notifyVoters: (e: ElectionRec, n: ElectionNotify) => Promise<void>;
}

const fullName = (a: { firstName: string; lastName?: string }) => `${a.firstName} ${a.lastName ?? ""}`.trim();
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const meta = (q: { page: number; limit: number }, total: number) => ({ page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) });
const dup = (e: unknown) => e instanceof StoreDuplicateError;

export interface ElectionInput {
  title: string; description?: string; academicSession?: string; votingOpensAt: Date; votingClosesAt: Date;
  electorate?: { mode: ElectorateMode; levels?: string[]; studentIds?: string[] };
}
export type ElectionUpdate = Partial<Omit<ElectionInput, "electorate">> & { description?: string | null; electorate?: { mode: ElectorateMode; levels?: string[]; studentIds?: string[] } };

/**
 * Departmental election administration for the HOD.
 * The department is ALWAYS actor.departmentId; every store call filters by it, so another department's election answers like a missing one (404, audited).
 * Structure (details, electorate, positions, candidates) is writable only while the election is a DRAFT or SCHEDULED: once voting opens, nothing about the ballot can move.
 * Candidates exist only because the HOD added them, and only APPROVED ones ever reach a ballot (student side filters on status).
 * Tallies are never revealed before voting closes; turnout (counts only) is visible once the election is published.
 */
export class ElectionAdminService {
  constructor(private readonly d: ElectionDeps) {}

  /* ------------------------------ plumbing ------------------------------ */
  private async audit(actor: HodActor, m: HodMeta, action: string, x: { resourceType?: string; resourceId?: string; detail?: Record<string, unknown> } = {}) {
    try {
      await this.d.store.addAudit({ actorId: actor.hodId, actorName: fullName(actor), role: "HOD", action, resourceType: x.resourceType, resourceId: x.resourceId, departmentId: actor.departmentId, ip: m.ip, detail: x.detail, at: this.d.now() });
    } catch { /* an audit failure must not turn a correct decision into a 500 */ }
  }
  private async notFound(actor: HodActor, m: HodMeta, what: string, type: string, id: string): Promise<never> {
    await this.audit(actor, m, "ACCESS_DENIED", { resourceType: type, resourceId: id, detail: { reason: "OUT_OF_SCOPE" } });
    throw new AppError(404, `${what} not found.`, undefined, "NOT_FOUND");
  }
  private async load(actor: HodActor, m: HodMeta, electionId: string): Promise<ElectionRec> {
    const e = await this.d.store.getElection(actor.departmentId, electionId);
    return e ?? this.notFound(actor, m, "Election", "ELECTION", electionId);
  }
  private life(e: ElectionRec): ElectionLifecycle { return lifecycleOf(e, this.d.now()); }
  private requireEditable(e: ElectionRec, what = "This election") {
    const l = this.life(e);
    if (!isEditable(l)) throw new AppError(409, `${what} can't be changed any more: it is ${l.toLowerCase()}. Elections can only be edited before voting starts.`, undefined, "ELECTION_LOCKED");
  }
  private async eligibleVoters(e: ElectionRec) {
    return this.d.store.countElectorate(e.departmentId, { academicSession: e.academicSession, electorateMode: e.electorateMode, eligibleLevels: e.eligibleLevels, eligibleStudentIds: e.eligibleStudentIds });
  }

  /** Verifies the electorate input and (for a group) that every chosen student belongs to THIS department. */
  private async resolveElectorate(actor: HodActor, input: { mode: ElectorateMode; levels?: string[]; studentIds?: string[] }) {
    const levels = await this.d.store.departmentLevels(actor.departmentId);
    const r = checkElectorate(input, levels);
    if (!r.ok) throw new AppError(422, r.reason, undefined, "INVALID_ELECTORATE");
    if (r.mode === "GROUP" && (await this.d.store.countStudentsInDepartment(actor.departmentId, r.studentIds)) !== r.studentIds.length) {
      throw new AppError(422, "One or more selected students aren't in your department.", undefined, "INVALID_ELECTORATE");
    }
    return r;
  }

  /* ------------------------------ DTOs ------------------------------ */
  private candidateDTO(c: CandidateRec) {
    return {
      id: c.id, positionId: c.positionId, studentId: c.studentId, status: c.status, manifesto: c.manifesto ?? null,
      photo: c.photo ?? c.student.profilePhoto ?? null, hasCustomPhoto: Boolean(c.photo),
      student: { firstName: c.student.firstName, lastName: c.student.lastName, name: fullName(c.student), matricNumber: c.student.matricNumber, level: c.student.level },
      decidedBy: c.decidedByName ?? null, decidedAt: c.decidedAt ?? null,
    };
  }
  private electionDTO(e: ElectionRec, extra: { positions?: number; approvedCandidates?: number; pendingCandidates?: number; eligibleVoters?: number } = {}) {
    const lifecycle = this.life(e);
    return {
      id: e.id, title: e.title, description: e.description ?? null, academicSession: e.academicSession,
      status: lifecycle, votingOpensAt: e.votingOpensAt, votingClosesAt: e.votingClosesAt, resultsPublished: e.resultsPublished,
      electorate: { mode: e.electorateMode, levels: e.eligibleLevels, groupSize: e.eligibleStudentIds.length, eligibleVoters: extra.eligibleVoters ?? null },
      counts: { positions: extra.positions ?? 0, approvedCandidates: extra.approvedCandidates ?? 0, pendingCandidates: extra.pendingCandidates ?? 0 },
      actions: allowedActions(lifecycle, e.resultsPublished),
      createdBy: e.createdByName, createdAt: e.createdAt, updatedAt: e.updatedAt,
    };
  }
  private async fullDTO(e: ElectionRec) {
    const [counts, eligibleVoters] = await Promise.all([this.d.store.structureCounts([e.id]), this.eligibleVoters(e)]);
    const c = counts.get(e.id);
    return this.electionDTO(e, { ...c, eligibleVoters });
  }

  /* ------------------------------ elections ------------------------------ */
  async list(actor: HodActor, q: ListQuery & { lifecycle?: ElectionLifecycle }) {
    const p: Page<ElectionRec> = await this.d.store.listElections(actor.departmentId, q, this.d.now());
    const counts = await this.d.store.structureCounts(p.items.map((e) => e.id));
    return { items: p.items.map((e) => this.electionDTO(e, counts.get(e.id))), ...meta(q, p.total) };
  }

  async get(actor: HodActor, electionId: string, m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    const [positions, candidates, dto] = await Promise.all([this.d.store.listPositions(actor.departmentId, e.id), this.d.store.listCandidates(actor.departmentId, e.id), this.fullDTO(e)]);
    return {
      ...dto,
      positions: positions.map((p) => ({
        id: p.id, title: p.title, description: p.description ?? null, order: p.order,
        candidates: candidates.filter((c) => c.positionId === p.id).map((c) => this.candidateDTO(c)),
      })),
    };
  }

  async create(actor: HodActor, input: ElectionInput, m: HodMeta = {}) {
    const session = input.academicSession ?? (await this.d.store.currentSession(actor.departmentId));
    if (!session) throw new AppError(422, "Set the department's current academic term first, or provide an academicSession.", undefined, "NO_ACADEMIC_SESSION");
    const err = checkSchedule(input.votingOpensAt, input.votingClosesAt, this.d.now(), false);
    if (err) throw new AppError(422, err);
    const el = await this.resolveElectorate(actor, input.electorate ?? { mode: "DEPARTMENT" });
    try {
      const rec = await this.d.store.createElection({
        departmentId: actor.departmentId, title: input.title, description: input.description, academicSession: session,
        electorateMode: el.mode, eligibleLevels: el.levels, eligibleStudentIds: el.studentIds,
        votingOpensAt: input.votingOpensAt, votingClosesAt: input.votingClosesAt, status: "DRAFT", resultsPublished: false,
        createdByName: fullName(actor), createdByRole: "HOD",
      });
      await this.audit(actor, m, "ELECTION_CREATED", { resourceType: "ELECTION", resourceId: rec.id, detail: { title: rec.title, session: rec.academicSession } });
      return this.fullDTO(rec);
    } catch (e) {
      if (dup(e)) throw new AppError(409, "You already have an election with that title for this academic session.", undefined, "DUPLICATE_ELECTION");
      throw e;
    }
  }

  /** Details, electorate and schedule: only before voting starts. The department, creator and status are not parameters. */
  async update(actor: HodActor, electionId: string, patch: ElectionUpdate, m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    this.requireEditable(e);
    const scheduled = this.life(e) === "SCHEDULED";
    const opens = patch.votingOpensAt ?? e.votingOpensAt, closes = patch.votingClosesAt ?? e.votingClosesAt;
    if (patch.votingOpensAt || patch.votingClosesAt) {
      const err = checkSchedule(opens, closes, this.d.now(), scheduled);
      if (err) throw new AppError(422, err);
    }
    const set: Parameters<ElectionStore["updateElection"]>[2] = {};
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.description !== undefined) set.description = patch.description ?? undefined;
    if (patch.academicSession !== undefined) set.academicSession = patch.academicSession;
    if (patch.votingOpensAt) set.votingOpensAt = patch.votingOpensAt;
    if (patch.votingClosesAt) set.votingClosesAt = patch.votingClosesAt;
    if (patch.electorate) {
      const el = await this.resolveElectorate(actor, patch.electorate);
      Object.assign(set, { electorateMode: el.mode, eligibleLevels: el.levels, eligibleStudentIds: el.studentIds });
    }
    try {
      const rec = await this.d.store.updateElection(actor.departmentId, e.id, set);
      if (!rec) return this.notFound(actor, m, "Election", "ELECTION", electionId);
      await this.audit(actor, m, "ELECTION_UPDATED", { resourceType: "ELECTION", resourceId: rec.id, detail: { fields: Object.keys(patch) } });
      return this.fullDTO(rec);
    } catch (err) {
      if (dup(err)) throw new AppError(409, "You already have an election with that title for this academic session.", undefined, "DUPLICATE_ELECTION");
      throw err;
    }
  }

  /** Drafts only: a draft can't hold votes. A scheduled / active / closed election is cancelled or kept, never erased. */
  async remove(actor: HodActor, electionId: string, m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    if (this.life(e) !== "DRAFT") throw new AppError(409, "Only a draft election can be deleted. Cancel a scheduled or active election instead.", undefined, "ELECTION_LOCKED");
    for (const c of await this.d.store.listCandidates(actor.departmentId, e.id)) if (c.photoPublicId) await this.d.deleteCandidatePhoto(c.photoPublicId).catch(() => undefined);
    await this.d.store.deleteElection(actor.departmentId, e.id);
    await this.audit(actor, m, "ELECTION_DELETED", { resourceType: "ELECTION", resourceId: e.id, detail: { title: e.title } });
  }

  /* ------------------------------ lifecycle ------------------------------ */
  private async readiness(e: ElectionRec) {
    const [positions, candidates, eligibleVoters] = await Promise.all([this.d.store.listPositions(e.departmentId, e.id), this.d.store.listCandidates(e.departmentId, e.id), this.eligibleVoters(e)]);
    return readinessProblems({
      eligibleVoters,
      positions: positions.map((p) => ({ title: p.title, approvedCandidates: candidates.filter((c) => c.positionId === p.id && c.status === "APPROVED").length })),
    });
  }
  private async assertReady(e: ElectionRec) {
    const problems = await this.readiness(e);
    if (problems.length) throw new AppError(422, "This election isn't ready yet.", problems, "ELECTION_NOT_READY");
  }

  /** Checklist for the dashboard: what still blocks publishing. */
  async readinessReport(actor: HodActor, electionId: string, m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    const problems = await this.readiness(e);
    const sched = checkSchedule(e.votingOpensAt, e.votingClosesAt, this.d.now(), true);
    return { ready: problems.length === 0 && !sched, problems: sched ? [...problems, sched] : problems };
  }

  /** DRAFT -> SCHEDULED. Voters can then see it; it opens by itself at the start time. */
  async publish(actor: HodActor, electionId: string, m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    if (this.life(e) !== "DRAFT") throw new AppError(409, "Only a draft election can be published.", undefined, "INVALID_TRANSITION");
    const sched = checkSchedule(e.votingOpensAt, e.votingClosesAt, this.d.now(), true);
    if (sched) throw new AppError(422, sched, undefined, "INVALID_SCHEDULE");
    await this.assertReady(e);
    const rec = (await this.d.store.updateElection(actor.departmentId, e.id, { status: "PUBLISHED" }))!;
    await this.audit(actor, m, "ELECTION_PUBLISHED", { resourceType: "ELECTION", resourceId: e.id });
    await this.d.notifyVoters(rec, { kind: "SYSTEM", title: "New election", body: `"${rec.title}" has been scheduled. Voting opens ${rec.votingOpensAt.toISOString()}.`, link: "/student/elections" }).catch(() => undefined);
    return this.fullDTO(rec);
  }

  /** Begin voting now (from DRAFT or SCHEDULED): publishes if needed and moves the start time to this moment. */
  async openNow(actor: HodActor, electionId: string, m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    const l = this.life(e);
    if (l !== "DRAFT" && l !== "SCHEDULED") throw new AppError(409, `An election that is ${l.toLowerCase()} can't be opened.`, undefined, "INVALID_TRANSITION");
    const now = this.d.now();
    const sched = checkSchedule(now, e.votingClosesAt, now, false);
    if (sched || e.votingClosesAt <= now) throw new AppError(422, "The end time is too close or already past. Edit the schedule first.", undefined, "INVALID_SCHEDULE");
    await this.assertReady(e);
    const rec = (await this.d.store.updateElection(actor.departmentId, e.id, { status: "PUBLISHED", votingOpensAt: now }))!;
    if (l === "DRAFT") await this.audit(actor, m, "ELECTION_PUBLISHED", { resourceType: "ELECTION", resourceId: e.id });
    await this.audit(actor, m, "ELECTION_OPENED", { resourceType: "ELECTION", resourceId: e.id, detail: { early: l === "SCHEDULED" } });
    await this.d.notifyVoters(rec, { kind: "SYSTEM", title: "Voting is open", body: `Voting in "${rec.title}" is now open.`, link: "/student/elections" }).catch(() => undefined);
    return this.fullDTO(rec);
  }

  /** End voting now. Votes already cast stay; no new vote is accepted from this moment. */
  async closeNow(actor: HodActor, electionId: string, m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    if (this.life(e) !== "ACTIVE") throw new AppError(409, "Only an active election can be closed.", undefined, "INVALID_TRANSITION");
    const now = this.d.now();
    // The window is inclusive of its end instant, so end it one millisecond ago: the election reads CLOSED immediately (never earlier than its start).
    const endedAt = new Date(Math.max(e.votingOpensAt.getTime(), now.getTime() - 1));
    const rec = (await this.d.store.updateElection(actor.departmentId, e.id, { votingClosesAt: endedAt }))!;
    await this.audit(actor, m, "ELECTION_CLOSED", { resourceType: "ELECTION", resourceId: e.id, detail: { early: now < e.votingClosesAt } });
    return this.fullDTO(rec);
  }

  /** Called off before or during voting. Votes are kept for the record but the election disappears from students and has no results. */
  async cancel(actor: HodActor, electionId: string, m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    const l = this.life(e);
    if (l !== "SCHEDULED" && l !== "ACTIVE") throw new AppError(409, "Only a scheduled or active election can be cancelled (delete a draft instead).", undefined, "INVALID_TRANSITION");
    const rec = (await this.d.store.updateElection(actor.departmentId, e.id, { status: "CANCELLED", resultsPublished: false }))!;
    await this.audit(actor, m, "ELECTION_CANCELLED", { resourceType: "ELECTION", resourceId: e.id, detail: { wasActive: l === "ACTIVE" } });
    return this.fullDTO(rec);
  }

  /* ------------------------------ turnout / results ------------------------------ */
  /** Counts only; available once published. Never shows who voted for whom. */
  async turnout(actor: HodActor, electionId: string, m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    const l = this.life(e);
    if (l === "DRAFT") throw new AppError(409, "There is no turnout for an election that hasn't been published.", undefined, "INVALID_TRANSITION");
    const [positions, byPosition, voted, eligible] = await Promise.all([
      this.d.store.listPositions(actor.departmentId, e.id), this.d.store.participationByPosition(e.id), this.d.store.distinctVoters(e.id), this.eligibleVoters(e),
    ]);
    return {
      electionId: e.id, status: l, eligibleVoters: eligible, votersWhoVoted: voted, turnoutPercentage: pct(voted, eligible), notYetVoted: Math.max(0, eligible - voted),
      positions: positions.map((p) => ({ id: p.id, title: p.title, votesCast: byPosition.get(p.id) ?? 0, turnoutPercentage: pct(byPosition.get(p.id) ?? 0, eligible) })),
    };
  }

  /** Candidate tallies exist for the HOD only after voting has closed (nobody can read a running count and steer the outcome). */
  async results(actor: HodActor, electionId: string, m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    const l = this.life(e);
    if (l !== "CLOSED") throw new AppError(403, l === "ACTIVE" || l === "SCHEDULED" ? "Results are available after the election closes." : "This election has no results.", undefined, "RESULTS_NOT_AVAILABLE");
    const [positions, candidates, tallies, byPosition, voted, eligible] = await Promise.all([
      this.d.store.listPositions(actor.departmentId, e.id), this.d.store.listCandidates(actor.departmentId, e.id), this.d.store.tallies(e.id),
      this.d.store.participationByPosition(e.id), this.d.store.distinctVoters(e.id), this.eligibleVoters(e),
    ]);
    return {
      election: { id: e.id, title: e.title, academicSession: e.academicSession, votingOpensAt: e.votingOpensAt, votingClosesAt: e.votingClosesAt, resultsPublished: e.resultsPublished },
      eligibleVoters: eligible, votersWhoVoted: voted, turnoutPercentage: pct(voted, eligible),
      positions: positions.map((p) => {
        const ranked = candidates.filter((c) => c.positionId === p.id && c.status === "APPROVED")
          .map((c) => ({ ...this.candidateDTO(c), votes: tallies.get(c.id) ?? 0 })).sort((a, b) => b.votes - a.votes);
        const { winner, isTie } = leadingCandidate(ranked);
        const cast = byPosition.get(p.id) ?? 0;
        return { id: p.id, title: p.title, totalVotes: ranked.reduce((s, c) => s + c.votes, 0), turnoutPercentage: pct(cast, eligible), isTie, winnerId: winner?.id ?? null, candidates: ranked.map((c) => ({ ...c, percentage: pct(c.votes, cast) })) };
      }),
    };
  }

  /** Releases (or withdraws) the results to eligible students. Only after the election has closed. */
  async setResultsPublished(actor: HodActor, electionId: string, published: boolean, m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    if (this.life(e) !== "CLOSED") throw new AppError(409, "Results can only be released after the election has closed.", undefined, "INVALID_TRANSITION");
    const rec = (await this.d.store.updateElection(actor.departmentId, e.id, { resultsPublished: published }))!;
    await this.audit(actor, m, "ELECTION_RESULTS_PUBLISHED", { resourceType: "ELECTION", resourceId: e.id, detail: { published } });
    if (published) await this.d.notifyVoters(rec, { kind: "SYSTEM", title: "Election results", body: `Results for "${rec.title}" are now available.`, link: "/student/elections" }).catch(() => undefined);
    return this.fullDTO(rec);
  }

  /* ------------------------------ positions ------------------------------ */
  async listPositions(actor: HodActor, electionId: string, m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    return (await this.d.store.listPositions(actor.departmentId, e.id)).map((p) => ({ id: p.id, title: p.title, description: p.description ?? null, order: p.order }));
  }
  async createPosition(actor: HodActor, electionId: string, input: { title: string; description?: string }, m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    this.requireEditable(e);
    const existing = await this.d.store.listPositions(actor.departmentId, e.id);
    if (existing.some((p) => p.title.toLowerCase() === input.title.toLowerCase())) throw new AppError(409, "This election already has a position with that title.", undefined, "DUPLICATE_POSITION");
    try {
      const p = await this.d.store.createPosition({ electionId: e.id, departmentId: actor.departmentId, title: input.title, description: input.description, order: existing.reduce((mx, x) => Math.max(mx, x.order), -1) + 1 });
      await this.audit(actor, m, "ELECTION_POSITION_CREATED", { resourceType: "ELECTION_POSITION", resourceId: p.id, detail: { electionId: e.id, title: p.title } });
      return { id: p.id, title: p.title, description: p.description ?? null, order: p.order };
    } catch (err) {
      if (dup(err)) throw new AppError(409, "This election already has a position with that title.", undefined, "DUPLICATE_POSITION");
      throw err;
    }
  }
  private async loadPosition(actor: HodActor, m: HodMeta, electionId: string, positionId: string) {
    const e = await this.load(actor, m, electionId);
    const p = await this.d.store.getPosition(actor.departmentId, positionId);
    if (!p || p.electionId !== e.id) return this.notFound(actor, m, "Position", "ELECTION_POSITION", positionId);
    return { e, p };
  }
  async updatePosition(actor: HodActor, electionId: string, positionId: string, patch: { title?: string; description?: string | null }, m: HodMeta = {}) {
    const { e, p } = await this.loadPosition(actor, m, electionId, positionId);
    this.requireEditable(e);
    if (patch.title && patch.title.toLowerCase() !== p.title.toLowerCase()) {
      const others = await this.d.store.listPositions(actor.departmentId, e.id);
      if (others.some((x) => x.id !== p.id && x.title.toLowerCase() === patch.title!.toLowerCase())) throw new AppError(409, "This election already has a position with that title.", undefined, "DUPLICATE_POSITION");
    }
    try {
      const rec = await this.d.store.updatePosition(actor.departmentId, p.id, { title: patch.title, description: patch.description });
      if (!rec) return this.notFound(actor, m, "Position", "ELECTION_POSITION", positionId);
      await this.audit(actor, m, "ELECTION_POSITION_UPDATED", { resourceType: "ELECTION_POSITION", resourceId: p.id, detail: { fields: Object.keys(patch) } });
      return { id: rec.id, title: rec.title, description: rec.description ?? null, order: rec.order };
    } catch (err) {
      if (dup(err)) throw new AppError(409, "This election already has a position with that title.", undefined, "DUPLICATE_POSITION");
      throw err;
    }
  }
  /** Removes the position and its candidates (their photos are deleted too). */
  async deletePosition(actor: HodActor, electionId: string, positionId: string, m: HodMeta = {}) {
    const { e, p } = await this.loadPosition(actor, m, electionId, positionId);
    this.requireEditable(e);
    for (const c of await this.d.store.listCandidates(actor.departmentId, e.id, p.id)) if (c.photoPublicId) await this.d.deleteCandidatePhoto(c.photoPublicId).catch(() => undefined);
    await this.d.store.deletePosition(actor.departmentId, p.id);
    await this.audit(actor, m, "ELECTION_POSITION_DELETED", { resourceType: "ELECTION_POSITION", resourceId: p.id, detail: { electionId: e.id, title: p.title } });
  }
  /** `orderedIds` must be exactly the election's positions, in the new order. */
  async reorderPositions(actor: HodActor, electionId: string, orderedIds: string[], m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    this.requireEditable(e);
    const current = await this.d.store.listPositions(actor.departmentId, e.id);
    const same = orderedIds.length === current.length && new Set(orderedIds).size === orderedIds.length && orderedIds.every((id) => current.some((p) => p.id === id));
    if (!same) throw new AppError(422, "Send every position of this election exactly once.", undefined, "INVALID_ORDER");
    await this.d.store.setPositionOrder(actor.departmentId, e.id, orderedIds);
    await this.audit(actor, m, "ELECTION_POSITIONS_REORDERED", { resourceType: "ELECTION", resourceId: e.id });
    return this.listPositions(actor, e.id, m);
  }

  /* ------------------------------ candidates ------------------------------ */
  /** Minimal student search for picking a candidate or voter-group member: same department, active students, no contact details. */
  async searchStudents(actor: HodActor, q: { page: number; limit: number; search?: string; level?: string }) {
    const p = await this.d.store.searchStudents(actor.departmentId, q);
    return { items: p.items.map((s: StudentRef) => ({ id: s.id, name: fullName(s), firstName: s.firstName, lastName: s.lastName, matricNumber: s.matricNumber, level: s.level, profilePhoto: s.profilePhoto ?? null })), ...meta(q, p.total) };
  }
  async groupMembers(actor: HodActor, electionId: string, q: { page: number; limit: number }, m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    if (e.electorateMode !== "GROUP") return { items: [], ...meta(q, 0) };
    const ids = e.eligibleStudentIds.slice((q.page - 1) * q.limit, q.page * q.limit);
    const rows = await this.d.store.studentsByIds(actor.departmentId, ids);
    return { items: rows.map((s) => ({ id: s.id, name: fullName(s), matricNumber: s.matricNumber, level: s.level, status: s.status })), ...meta(q, e.eligibleStudentIds.length) };
  }

  private async loadCandidate(actor: HodActor, m: HodMeta, electionId: string, candidateId: string) {
    const e = await this.load(actor, m, electionId);
    const c = await this.d.store.getCandidate(actor.departmentId, candidateId);
    if (!c || c.electionId !== e.id) return this.notFound(actor, m, "Candidate", "ELECTION_CANDIDATE", candidateId);
    return { e, c };
  }
  async listCandidates(actor: HodActor, electionId: string, positionId: string | undefined, m: HodMeta = {}) {
    const e = await this.load(actor, m, electionId);
    return (await this.d.store.listCandidates(actor.departmentId, e.id, positionId)).map((c) => this.candidateDTO(c));
  }
  private checkPhoto(buffer: Buffer) {
    if (!sniffImage(buffer)) throw new AppError(415, "Only JPEG, PNG or WebP images are allowed.", undefined, "UNSUPPORTED_FILE_TYPE");
  }

  /**
   * Adds an EXISTING student of this department as a candidate. Students can never add themselves: there is no student-side route, and a
   * candidate row only ever comes from here. It starts PENDING (not on any ballot) unless the HOD approves it in the same step.
   * One student may stand for one position per election.
   */
  async addCandidate(actor: HodActor, electionId: string, input: { positionId: string; studentId: string; manifesto?: string; approve?: boolean; photo?: Buffer }, m: HodMeta = {}) {
    const { e, p } = await this.loadPosition(actor, m, electionId, input.positionId);
    this.requireEditable(e, "The candidate list");
    const student = await this.d.store.getStudent(actor.departmentId, input.studentId);
    if (!student) return this.notFound(actor, m, "Student", "STUDENT", input.studentId);
    if (student.status !== "ACTIVE") throw new AppError(422, "Only an active student can be a candidate.", undefined, "STUDENT_NOT_ACTIVE");
    const mine = await this.d.store.candidaciesOfStudent(actor.departmentId, e.id, student.id);
    const live = mine.find((c) => c.status === "PENDING" || c.status === "APPROVED");
    if (live) throw new AppError(409, live.positionId === p.id ? "This student is already a candidate for this position." : "This student is already a candidate for another position in this election.", undefined, "DUPLICATE_CANDIDATE");
    if (input.photo) this.checkPhoto(input.photo);

    const status = input.approve ? "APPROVED" : "PENDING";
    const decided = input.approve ? { decidedByName: fullName(actor), decidedAt: this.d.now() } : {};
    const photo = input.photo ? await this.d.uploadCandidatePhoto(input.photo, e.id) : undefined;
    try {
      // A rejected / withdrawn row for the same position is revived rather than duplicated.
      const revive = mine.find((c) => c.positionId === p.id);
      const rec = revive
        ? (await this.d.store.updateCandidate(actor.departmentId, revive.id, { manifesto: input.manifesto, status, ...decided, ...(photo ? { photo: photo.url, photoPublicId: photo.publicId } : {}) }))!
        : await this.d.store.createCandidate({ electionId: e.id, positionId: p.id, departmentId: actor.departmentId, studentId: student.id, manifesto: input.manifesto, status, photo: photo?.url, photoPublicId: photo?.publicId, ...decided });
      if (revive?.photoPublicId && photo) await this.d.deleteCandidatePhoto(revive.photoPublicId).catch(() => undefined);
      await this.audit(actor, m, "ELECTION_CANDIDATE_ADDED", { resourceType: "ELECTION_CANDIDATE", resourceId: rec.id, detail: { electionId: e.id, positionId: p.id, studentId: student.id, status, withPhoto: Boolean(photo) } });
      if (input.approve) await this.audit(actor, m, "ELECTION_CANDIDATE_APPROVED", { resourceType: "ELECTION_CANDIDATE", resourceId: rec.id });
      return this.candidateDTO(rec);
    } catch (err) {
      if (photo) await this.d.deleteCandidatePhoto(photo.publicId).catch(() => undefined);
      if (dup(err)) throw new AppError(409, "This student is already a candidate for this position.", undefined, "DUPLICATE_CANDIDATE");
      throw err;
    }
  }

  async updateCandidate(actor: HodActor, electionId: string, candidateId: string, patch: { manifesto?: string | null }, m: HodMeta = {}) {
    const { e, c } = await this.loadCandidate(actor, m, electionId, candidateId);
    this.requireEditable(e, "The candidate list");
    const rec = await this.d.store.updateCandidate(actor.departmentId, c.id, { manifesto: patch.manifesto ?? undefined });
    if (!rec) return this.notFound(actor, m, "Candidate", "ELECTION_CANDIDATE", candidateId);
    await this.audit(actor, m, "ELECTION_CANDIDATE_UPDATED", { resourceType: "ELECTION_CANDIDATE", resourceId: c.id, detail: { fields: Object.keys(patch) } });
    return this.candidateDTO(rec);
  }

  /** Approve / reject. Only APPROVED candidates ever appear on a ballot. */
  async decideCandidate(actor: HodActor, electionId: string, candidateId: string, decision: "APPROVED" | "REJECTED", m: HodMeta = {}) {
    const { e, c } = await this.loadCandidate(actor, m, electionId, candidateId);
    this.requireEditable(e, "The candidate list");
    if (c.status === decision) throw new AppError(409, `This candidate is already ${decision.toLowerCase()}.`, undefined, "INVALID_TRANSITION");
    if (decision === "APPROVED") {
      const s = await this.d.store.getStudent(actor.departmentId, c.studentId);
      if (!s || s.status !== "ACTIVE") throw new AppError(422, "Only an active student can be an approved candidate.", undefined, "STUDENT_NOT_ACTIVE");
    }
    const rec = (await this.d.store.updateCandidate(actor.departmentId, c.id, { status: decision, decidedByName: fullName(actor), decidedAt: this.d.now() }))!;
    await this.audit(actor, m, decision === "APPROVED" ? "ELECTION_CANDIDATE_APPROVED" : "ELECTION_CANDIDATE_REJECTED", { resourceType: "ELECTION_CANDIDATE", resourceId: c.id, detail: { electionId: e.id } });
    return this.candidateDTO(rec);
  }

  async removeCandidate(actor: HodActor, electionId: string, candidateId: string, m: HodMeta = {}) {
    const { e, c } = await this.loadCandidate(actor, m, electionId, candidateId);
    this.requireEditable(e, "The candidate list");
    await this.d.store.deleteCandidate(actor.departmentId, c.id);
    if (c.photoPublicId) await this.d.deleteCandidatePhoto(c.photoPublicId).catch(() => undefined);
    await this.audit(actor, m, "ELECTION_CANDIDATE_REMOVED", { resourceType: "ELECTION_CANDIDATE", resourceId: c.id, detail: { electionId: e.id, studentId: c.studentId } });
  }

  /** Upload or replace the candidate's campaign photo (JPEG / PNG / WebP, verified from the bytes). */
  async setCandidatePhoto(actor: HodActor, electionId: string, candidateId: string, buffer: Buffer, m: HodMeta = {}) {
    const { e, c } = await this.loadCandidate(actor, m, electionId, candidateId);
    this.requireEditable(e, "The candidate list");
    this.checkPhoto(buffer);
    const saved = await this.d.uploadCandidatePhoto(buffer, e.id);
    let rec: CandidateRec | null;
    try {
      rec = await this.d.store.updateCandidate(actor.departmentId, c.id, { photo: saved.url, photoPublicId: saved.publicId });
    } catch (err) { await this.d.deleteCandidatePhoto(saved.publicId).catch(() => undefined); throw err; }
    if (!rec) { await this.d.deleteCandidatePhoto(saved.publicId).catch(() => undefined); return this.notFound(actor, m, "Candidate", "ELECTION_CANDIDATE", candidateId); }
    if (c.photoPublicId && c.photoPublicId !== saved.publicId) await this.d.deleteCandidatePhoto(c.photoPublicId).catch(() => undefined);
    await this.audit(actor, m, "ELECTION_CANDIDATE_PHOTO_CHANGED", { resourceType: "ELECTION_CANDIDATE", resourceId: c.id });
    return this.candidateDTO(rec);
  }
  async removeCandidatePhoto(actor: HodActor, electionId: string, candidateId: string, m: HodMeta = {}) {
    const { e, c } = await this.loadCandidate(actor, m, electionId, candidateId);
    this.requireEditable(e, "The candidate list");
    const rec = (await this.d.store.updateCandidate(actor.departmentId, c.id, { clearPhoto: true }))!;
    if (c.photoPublicId) await this.d.deleteCandidatePhoto(c.photoPublicId).catch(() => undefined);
    await this.audit(actor, m, "ELECTION_CANDIDATE_PHOTO_CHANGED", { resourceType: "ELECTION_CANDIDATE", resourceId: c.id, detail: { removed: true } });
    return this.candidateDTO(rec);
  }
}
