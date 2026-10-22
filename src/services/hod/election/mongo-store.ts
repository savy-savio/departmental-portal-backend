import { Types, type FilterQuery } from "mongoose";
import { AcademicTerm } from "../../../models/AcademicTerm";
import { Department } from "../../../models/Department";
import { Election, type ElectionDocument } from "../../../models/Election";
import { ElectionCandidate, type ElectionCandidateDocument } from "../../../models/ElectionCandidate";
import { ElectionPosition, type ElectionPositionDocument } from "../../../models/ElectionPosition";
import { Vote, VoteParticipation } from "../../../models/Ballot";
import { HodAuditLog } from "../../../models/HodAuditLog";
import { Student, type StudentDocument } from "../../../models/Student";
import { StoreDuplicateError } from "../store";
import type { HodAuditRec, Page } from "../types";
import type { ElectionStore } from "./store";
import type {
  CandidatePatch, CandidateRec, Electorate, ElectionFilter, ElectionPatch, ElectionRec, NewCandidate, NewElection, NewPosition, PositionRec, StructureCount, StudentRef, StudentSearch,
} from "./types";

const id = (v: unknown) => String(v);
const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stamps = (d: unknown) => d as { createdAt: Date; updatedAt: Date };
const oid = (v: string) => new Types.ObjectId(v);

const toElection = (e: ElectionDocument): ElectionRec => ({
  id: id(e._id), departmentId: id(e.department), title: e.title, description: e.description ?? undefined, academicSession: e.academicSession,
  electorateMode: e.electorateMode ?? "DEPARTMENT", eligibleLevels: e.eligibleLevels ?? [], eligibleStudentIds: (e.eligibleStudents ?? []).map(id),
  votingOpensAt: e.votingOpensAt, votingClosesAt: e.votingClosesAt, status: e.status, resultsPublished: e.resultsPublished,
  createdByName: e.createdByName, createdByRole: e.createdByRole, createdAt: stamps(e).createdAt, updatedAt: stamps(e).updatedAt,
});
const toPosition = (p: ElectionPositionDocument): PositionRec => ({ id: id(p._id), electionId: id(p.election), departmentId: id(p.department), title: p.title, description: p.description ?? undefined, order: p.order });
const toStudentRef = (s: StudentDocument): StudentRef => ({ id: id(s._id), firstName: s.firstName, lastName: s.lastName, matricNumber: s.matricNumber, level: s.level, status: s.status, academicSession: s.academicSession, profilePhoto: s.profilePhoto ?? undefined });
const toCandidate = (c: ElectionCandidateDocument, s?: StudentDocument): CandidateRec => ({
  id: id(c._id), electionId: id(c.election), positionId: id(c.position), departmentId: id(c.department), studentId: id(c.student), manifesto: c.manifesto ?? undefined,
  photo: c.photo ?? undefined, photoPublicId: c.photoPublicId ?? undefined, status: c.status, decidedByName: c.decidedByName ?? undefined, decidedAt: c.decidedAt ?? undefined,
  student: s ? { firstName: s.firstName, lastName: s.lastName, matricNumber: s.matricNumber, level: s.level, profilePhoto: s.profilePhoto ?? undefined } : { firstName: "Unknown", lastName: "", matricNumber: "", level: "" },
});

/** Students who may vote in an election of this department. Mirrors isEligibleVoter() on the student side. */
function electorateFilter(departmentId: string, e: Electorate): FilterQuery<unknown> {
  const f: FilterQuery<unknown> = { department: departmentId, status: "ACTIVE", academicSession: e.academicSession };
  if (e.electorateMode === "GROUP") f._id = { $in: e.eligibleStudentIds.map(oid) };
  else if (e.electorateMode === "LEVELS") f.level = { $in: e.eligibleLevels };
  return f;
}

/** MongoDB implementation. EVERY query includes the department, so another department's ids behave like missing ones. */
export class MongoElectionStore implements ElectionStore {
  private async candidates(docs: ElectionCandidateDocument[]): Promise<CandidateRec[]> {
    const students = await Student.find({ _id: { $in: docs.map((c) => c.student) } });
    const byId = new Map(students.map((s) => [id(s._id), s]));
    return docs.map((c) => toCandidate(c, byId.get(id(c.student))));
  }

  async currentSession(departmentId: string) { const t = await AcademicTerm.findOne({ department: departmentId, isCurrent: true }); return t?.academicSession ?? null; }
  async departmentLevels(departmentId: string) { return (await Department.findById(departmentId))?.levels ?? []; }

  /* ---- elections ---- */
  async listElections(departmentId: string, q: ElectionFilter, now: Date): Promise<Page<ElectionRec>> {
    const f: FilterQuery<unknown> = { department: departmentId };
    if (q.search) f.title = new RegExp(esc(q.search), "i");
    switch (q.lifecycle) {
      case "DRAFT": f.status = "DRAFT"; break;
      case "CANCELLED": f.status = "CANCELLED"; break;
      case "SCHEDULED": f.status = "PUBLISHED"; f.votingOpensAt = { $gt: now }; break;
      case "ACTIVE": f.status = "PUBLISHED"; f.votingOpensAt = { $lte: now }; f.votingClosesAt = { $gte: now }; break;
      case "CLOSED": f.status = "PUBLISHED"; f.votingClosesAt = { $lt: now }; break;
      default: break;
    }
    const sort: Record<string, 1 | -1> = q.sort === "title" ? { title: q.order === "desc" ? -1 : 1 } : { votingOpensAt: q.order === "asc" ? 1 : -1 };
    const [total, rows] = await Promise.all([Election.countDocuments(f), Election.find(f).sort(sort).skip((q.page - 1) * q.limit).limit(q.limit)]);
    return { items: rows.map(toElection), total };
  }
  async getElection(departmentId: string, electionId: string) { const e = await Election.findOne({ _id: electionId, department: departmentId }); return e ? toElection(e) : null; }
  async createElection(rec: NewElection) {
    try {
      const e = await Election.create({
        department: rec.departmentId, title: rec.title, description: rec.description, academicSession: rec.academicSession, electorateMode: rec.electorateMode,
        eligibleLevels: rec.eligibleLevels, eligibleStudents: rec.eligibleStudentIds, votingOpensAt: rec.votingOpensAt, votingClosesAt: rec.votingClosesAt,
        status: rec.status, resultsPublished: rec.resultsPublished, createdByName: rec.createdByName, createdByRole: rec.createdByRole,
      });
      return toElection(e);
    } catch (err) { if (isDup(err)) throw new StoreDuplicateError("election title"); throw err; }
  }
  async updateElection(departmentId: string, electionId: string, patch: ElectionPatch) {
    const $set: Record<string, unknown> = {}; const $unset: Record<string, ""> = {};
    for (const [k, v] of Object.entries(patch)) {
      const key = k === "eligibleStudentIds" ? "eligibleStudents" : k;
      if (v === undefined) { if (k === "description") $unset.description = ""; continue; }
      $set[key] = v;
    }
    try {
      // `department`, `createdBy*` are never in $set (and `department` is immutable in the schema).
      const e = await Election.findOneAndUpdate({ _id: electionId, department: departmentId }, { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) }, { new: true, runValidators: true });
      return e ? toElection(e) : null;
    } catch (err) { if (isDup(err)) throw new StoreDuplicateError("election title"); throw err; }
  }
  async deleteElection(departmentId: string, electionId: string) {
    await Promise.all([ElectionCandidate.deleteMany({ election: electionId, department: departmentId }), ElectionPosition.deleteMany({ election: electionId, department: departmentId })]);
    await Election.deleteOne({ _id: electionId, department: departmentId });
  }
  async structureCounts(electionIds: string[]) {
    const out = new Map<string, StructureCount>();
    if (!electionIds.length) return out;
    const ids = electionIds.map(oid);
    const [pos, cand] = await Promise.all([
      ElectionPosition.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { election: { $in: ids } } }, { $group: { _id: "$election", n: { $sum: 1 } } }]),
      ElectionCandidate.aggregate<{ _id: { e: Types.ObjectId; s: string }; n: number }>([{ $match: { election: { $in: ids }, status: { $in: ["APPROVED", "PENDING"] } } }, { $group: { _id: { e: "$election", s: "$status" }, n: { $sum: 1 } } }]),
    ]);
    for (const e of electionIds) out.set(e, { positions: 0, approvedCandidates: 0, pendingCandidates: 0 });
    for (const p of pos) out.get(id(p._id))!.positions = p.n;
    for (const c of cand) { const row = out.get(id(c._id.e))!; if (c._id.s === "APPROVED") row.approvedCandidates = c.n; else row.pendingCandidates = c.n; }
    return out;
  }

  /* ---- positions ---- */
  async listPositions(departmentId: string, electionId: string) { return (await ElectionPosition.find({ election: electionId, department: departmentId }).sort({ order: 1, title: 1 })).map(toPosition); }
  async getPosition(departmentId: string, positionId: string) { const p = await ElectionPosition.findOne({ _id: positionId, department: departmentId }); return p ? toPosition(p) : null; }
  async createPosition(rec: NewPosition) {
    try { return toPosition(await ElectionPosition.create({ election: rec.electionId, department: rec.departmentId, title: rec.title, description: rec.description, order: rec.order })); }
    catch (err) { if (isDup(err)) throw new StoreDuplicateError("position title"); throw err; }
  }
  async updatePosition(departmentId: string, positionId: string, patch: { title?: string; description?: string | null }) {
    const $set: Record<string, unknown> = {}; const $unset: Record<string, ""> = {};
    if (patch.title !== undefined) $set.title = patch.title;
    if (patch.description === null) $unset.description = ""; else if (patch.description !== undefined) $set.description = patch.description;
    try {
      const p = await ElectionPosition.findOneAndUpdate({ _id: positionId, department: departmentId }, { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) }, { new: true, runValidators: true });
      return p ? toPosition(p) : null;
    } catch (err) { if (isDup(err)) throw new StoreDuplicateError("position title"); throw err; }
  }
  async deletePosition(departmentId: string, positionId: string) {
    await ElectionCandidate.deleteMany({ position: positionId, department: departmentId });
    await ElectionPosition.deleteOne({ _id: positionId, department: departmentId });
  }
  async setPositionOrder(departmentId: string, electionId: string, orderedIds: string[]) {
    if (!orderedIds.length) return;
    await ElectionPosition.bulkWrite(orderedIds.map((pid, order) => ({ updateOne: { filter: { _id: pid, election: electionId, department: departmentId }, update: { $set: { order } } } })));
  }

  /* ---- candidates ---- */
  async listCandidates(departmentId: string, electionId: string, positionId?: string) {
    const docs = await ElectionCandidate.find({ election: electionId, department: departmentId, ...(positionId ? { position: positionId } : {}) }).select("+photoPublicId").sort({ createdAt: 1 });
    return this.candidates(docs);
  }
  async getCandidate(departmentId: string, candidateId: string) {
    const c = await ElectionCandidate.findOne({ _id: candidateId, department: departmentId }).select("+photoPublicId");
    return c ? (await this.candidates([c]))[0] : null;
  }
  async candidaciesOfStudent(departmentId: string, electionId: string, studentId: string) {
    return this.candidates(await ElectionCandidate.find({ election: electionId, department: departmentId, student: studentId }).select("+photoPublicId"));
  }
  async createCandidate(rec: NewCandidate) {
    try {
      const c = await ElectionCandidate.create({
        election: rec.electionId, position: rec.positionId, department: rec.departmentId, student: rec.studentId, manifesto: rec.manifesto, photo: rec.photo, photoPublicId: rec.photoPublicId,
        status: rec.status, decidedByName: rec.decidedByName, decidedAt: rec.decidedAt,
      });
      return (await this.candidates([c]))[0];
    } catch (err) { if (isDup(err)) throw new StoreDuplicateError("candidate"); throw err; }
  }
  async updateCandidate(departmentId: string, candidateId: string, patch: CandidatePatch | { clearPhoto: true }) {
    const $set: Record<string, unknown> = {}; const $unset: Record<string, ""> = {};
    if ("clearPhoto" in patch) { $unset.photo = ""; $unset.photoPublicId = ""; }
    else for (const [k, v] of Object.entries(patch)) { if (v === undefined) { if (k === "manifesto") $unset.manifesto = ""; continue; } $set[k] = v; }
    const c = await ElectionCandidate.findOneAndUpdate({ _id: candidateId, department: departmentId }, { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) }, { new: true, runValidators: true }).select("+photoPublicId");
    return c ? (await this.candidates([c]))[0] : null;
  }
  async deleteCandidate(departmentId: string, candidateId: string) { await ElectionCandidate.deleteOne({ _id: candidateId, department: departmentId }); }

  /* ---- students ---- */
  async getStudent(departmentId: string, studentId: string) { const s = await Student.findOne({ _id: studentId, department: departmentId }); return s ? toStudentRef(s) : null; }
  async searchStudents(departmentId: string, q: StudentSearch): Promise<Page<StudentRef>> {
    const f: FilterQuery<unknown> = { department: departmentId, status: "ACTIVE" };
    if (q.level) f.level = q.level;
    if (q.search) { const rx = new RegExp(esc(q.search), "i"); f.$or = [{ firstName: rx }, { lastName: rx }, { matricNumber: rx }]; }
    const [total, rows] = await Promise.all([Student.countDocuments(f), Student.find(f).sort({ lastName: 1, firstName: 1 }).skip((q.page - 1) * q.limit).limit(q.limit)]);
    return { items: rows.map(toStudentRef), total };
  }
  async studentsByIds(departmentId: string, ids: string[]) {
    const rows = await Student.find({ _id: { $in: ids.map(oid) }, department: departmentId });
    const by = new Map(rows.map((s) => [id(s._id), s]));
    return ids.map((i) => by.get(i)).filter((s): s is StudentDocument => Boolean(s)).map(toStudentRef);
  }
  async countStudentsInDepartment(departmentId: string, ids: string[]) { return Student.countDocuments({ _id: { $in: ids.map(oid) }, department: departmentId }); }
  async countElectorate(departmentId: string, e: Electorate) { return Student.countDocuments(electorateFilter(departmentId, e)); }

  /* ---- votes (counts only) ---- */
  async participationByPosition(electionId: string) {
    const rows = await VoteParticipation.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { election: oid(electionId) } }, { $group: { _id: "$position", n: { $sum: 1 } } }]);
    return new Map<string, number>(rows.map((r) => [id(r._id), r.n] as [string, number]));
  }
  async distinctVoters(electionId: string) {
    const r = await VoteParticipation.aggregate<{ n: number }>([{ $match: { election: oid(electionId) } }, { $group: { _id: "$student" } }, { $count: "n" }]);
    return r[0]?.n ?? 0;
  }
  async tallies(electionId: string) {
    const rows = await Vote.aggregate<{ _id: Types.ObjectId; votes: number }>([{ $match: { election: oid(electionId) } }, { $group: { _id: "$candidate", votes: { $sum: 1 } } }]);
    return new Map<string, number>(rows.map((r) => [id(r._id), r.votes] as [string, number]));
  }

  async addAudit(rec: HodAuditRec) {
    await HodAuditLog.create({ actor: rec.actorId, actorName: rec.actorName, role: rec.role, action: rec.action, resourceType: rec.resourceType, resourceId: rec.resourceId, department: rec.departmentId, ip: rec.ip, detail: rec.detail, at: rec.at });
  }
}
