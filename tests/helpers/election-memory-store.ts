import { randomUUID } from "node:crypto";
import { StoreDuplicateError } from "../../src/services/hod/store";
import type { ElectionStore } from "../../src/services/hod/election/store";
import type {
  CandidatePatch, CandidateRec, Electorate, ElectionFilter, ElectionPatch, ElectionRec, NewCandidate, NewElection, NewPosition, PositionRec, StructureCount, StudentRef, StudentSearch,
} from "../../src/services/hod/election/types";
import type { HodAuditRec, Page } from "../../src/services/hod/types";

export type StudentX = StudentRef & { departmentId: string };

/** In-memory ElectionStore applying the same department filters and uniqueness rules as the Mongo store. */
export class ElectionMemoryStore implements ElectionStore {
  sessions = new Map<string, string>();
  levels = new Map<string, string[]>();
  elections: ElectionRec[] = [];
  positions: PositionRec[] = [];
  candidates: (Omit<CandidateRec, "student">)[] = [];
  students: StudentX[] = [];
  /** who voted where (never what), and anonymous votes by candidate */
  participation: { electionId: string; positionId: string; studentId: string }[] = [];
  votes: { electionId: string; positionId: string; candidateId: string }[] = [];
  audit: HodAuditRec[] = [];

  async currentSession(d: string) { return this.sessions.get(d) ?? null; }
  async departmentLevels(d: string) { return this.levels.get(d) ?? []; }

  async listElections(d: string, q: ElectionFilter, now: Date): Promise<Page<ElectionRec>> {
    let r = this.elections.filter((e) => e.departmentId === d);
    if (q.search) r = r.filter((e) => e.title.toLowerCase().includes(q.search!.toLowerCase()));
    const life = (e: ElectionRec) => e.status === "PUBLISHED" ? (now < e.votingOpensAt ? "SCHEDULED" : now > e.votingClosesAt ? "CLOSED" : "ACTIVE") : e.status;
    if (q.lifecycle) r = r.filter((e) => life(e) === q.lifecycle);
    r = [...r].sort((a, b) => b.votingOpensAt.getTime() - a.votingOpensAt.getTime());
    return { items: r.slice((q.page - 1) * q.limit, q.page * q.limit), total: r.length };
  }
  async getElection(d: string, id: string) { return this.elections.find((e) => e.id === id && e.departmentId === d) ?? null; }
  async createElection(rec: NewElection) {
    if (this.elections.some((e) => e.departmentId === rec.departmentId && e.academicSession === rec.academicSession && e.title === rec.title)) throw new StoreDuplicateError("election title");
    const e: ElectionRec = { ...rec, id: randomUUID(), createdAt: new Date(), updatedAt: new Date() };
    this.elections.push(e);
    return e;
  }
  async updateElection(d: string, id: string, patch: ElectionPatch) {
    const e = this.elections.find((x) => x.id === id && x.departmentId === d);
    if (!e) return null;
    const next = { ...e, ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined || k === "description")) };
    if (this.elections.some((x) => x.id !== id && x.departmentId === d && x.academicSession === next.academicSession && x.title === next.title)) throw new StoreDuplicateError("election title");
    Object.assign(e, next, { updatedAt: new Date() });
    return e;
  }
  async deleteElection(d: string, id: string) {
    this.candidates = this.candidates.filter((c) => !(c.electionId === id && c.departmentId === d));
    this.positions = this.positions.filter((p) => !(p.electionId === id && p.departmentId === d));
    this.elections = this.elections.filter((e) => !(e.id === id && e.departmentId === d));
  }
  async structureCounts(ids: string[]) {
    const m = new Map<string, StructureCount>();
    for (const id of ids) m.set(id, {
      positions: this.positions.filter((p) => p.electionId === id).length,
      approvedCandidates: this.candidates.filter((c) => c.electionId === id && c.status === "APPROVED").length,
      pendingCandidates: this.candidates.filter((c) => c.electionId === id && c.status === "PENDING").length,
    });
    return m;
  }

  async listPositions(d: string, eid: string) { return this.positions.filter((p) => p.electionId === eid && p.departmentId === d).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)); }
  async getPosition(d: string, id: string) { return this.positions.find((p) => p.id === id && p.departmentId === d) ?? null; }
  async createPosition(rec: NewPosition) {
    if (this.positions.some((p) => p.electionId === rec.electionId && p.title === rec.title)) throw new StoreDuplicateError("position title");
    const p: PositionRec = { ...rec, id: randomUUID() };
    this.positions.push(p);
    return p;
  }
  async updatePosition(d: string, id: string, patch: { title?: string; description?: string | null }) {
    const p = this.positions.find((x) => x.id === id && x.departmentId === d);
    if (!p) return null;
    if (patch.title !== undefined) p.title = patch.title;
    if (patch.description === null) p.description = undefined; else if (patch.description !== undefined) p.description = patch.description;
    return p;
  }
  async deletePosition(d: string, id: string) {
    this.candidates = this.candidates.filter((c) => !(c.positionId === id && c.departmentId === d));
    this.positions = this.positions.filter((p) => !(p.id === id && p.departmentId === d));
  }
  async setPositionOrder(d: string, eid: string, ids: string[]) { ids.forEach((id, order) => { const p = this.positions.find((x) => x.id === id && x.electionId === eid && x.departmentId === d); if (p) p.order = order; }); }

  private view(c: Omit<CandidateRec, "student">): CandidateRec {
    const s = this.students.find((x) => x.id === c.studentId);
    return { ...c, student: s ? { firstName: s.firstName, lastName: s.lastName, matricNumber: s.matricNumber, level: s.level, profilePhoto: s.profilePhoto } : { firstName: "Unknown", lastName: "", matricNumber: "", level: "" } };
  }
  async listCandidates(d: string, eid: string, pid?: string) { return this.candidates.filter((c) => c.electionId === eid && c.departmentId === d && (!pid || c.positionId === pid)).map((c) => this.view(c)); }
  async getCandidate(d: string, id: string) { const c = this.candidates.find((x) => x.id === id && x.departmentId === d); return c ? this.view(c) : null; }
  async candidaciesOfStudent(d: string, eid: string, sid: string) { return this.candidates.filter((c) => c.electionId === eid && c.departmentId === d && c.studentId === sid).map((c) => this.view(c)); }
  async createCandidate(rec: NewCandidate) {
    if (this.candidates.some((c) => c.positionId === rec.positionId && c.studentId === rec.studentId)) throw new StoreDuplicateError("candidate");
    const c = { ...rec, id: randomUUID() };
    this.candidates.push(c);
    return this.view(c);
  }
  async updateCandidate(d: string, id: string, patch: CandidatePatch | { clearPhoto: true }) {
    const c = this.candidates.find((x) => x.id === id && x.departmentId === d);
    if (!c) return null;
    if ("clearPhoto" in patch) { c.photo = undefined; c.photoPublicId = undefined; }
    else for (const [k, v] of Object.entries(patch)) (c as Record<string, unknown>)[k] = v;
    return this.view(c);
  }
  async deleteCandidate(d: string, id: string) { this.candidates = this.candidates.filter((c) => !(c.id === id && c.departmentId === d)); }

  async getStudent(d: string, id: string) { return this.students.find((s) => s.id === id && s.departmentId === d) ?? null; }
  async searchStudents(d: string, q: StudentSearch): Promise<Page<StudentRef>> {
    let r = this.students.filter((s) => s.departmentId === d && s.status === "ACTIVE");
    if (q.level) r = r.filter((s) => s.level === q.level);
    if (q.search) { const n = q.search.toLowerCase(); r = r.filter((s) => `${s.firstName} ${s.lastName} ${s.matricNumber}`.toLowerCase().includes(n)); }
    return { items: r.slice((q.page - 1) * q.limit, q.page * q.limit), total: r.length };
  }
  async studentsByIds(d: string, ids: string[]) { return ids.map((i) => this.students.find((s) => s.id === i && s.departmentId === d)).filter((s): s is StudentX => Boolean(s)); }
  async countStudentsInDepartment(d: string, ids: string[]) { return this.students.filter((s) => s.departmentId === d && ids.includes(s.id)).length; }
  async countElectorate(d: string, e: Electorate) {
    return this.students.filter((s) => s.departmentId === d && s.status === "ACTIVE" && s.academicSession === e.academicSession
      && (e.electorateMode === "GROUP" ? e.eligibleStudentIds.includes(s.id) : e.electorateMode === "LEVELS" ? e.eligibleLevels.includes(s.level) : true)).length;
  }

  async participationByPosition(eid: string) { const m = new Map<string, number>(); for (const p of this.participation.filter((x) => x.electionId === eid)) m.set(p.positionId, (m.get(p.positionId) ?? 0) + 1); return m; }
  async distinctVoters(eid: string) { return new Set(this.participation.filter((x) => x.electionId === eid).map((x) => x.studentId)).size; }
  async tallies(eid: string) { const m = new Map<string, number>(); for (const v of this.votes.filter((x) => x.electionId === eid)) m.set(v.candidateId, (m.get(v.candidateId) ?? 0) + 1); return m; }

  async addAudit(rec: HodAuditRec) { this.audit.push(rec); }
}
