import type { HodAuditRec, Page } from "../types";
import type {
  CandidatePatch, CandidateRec, Electorate, ElectionFilter, ElectionPatch, ElectionRec, NewCandidate, NewElection, NewPosition, PositionRec, StructureCount, StudentRef, StudentSearch,
} from "./types";

/**
 * Storage for the election-administration engine. EVERY method takes the department id and filters by it, so another department's
 * election / position / candidate id is indistinguishable from one that doesn't exist.
 * Create / update methods throw StoreDuplicateError (from ../store) for unique-index clashes.
 */
export interface ElectionStore {
  currentSession(departmentId: string): Promise<string | null>;
  departmentLevels(departmentId: string): Promise<string[]>;

  listElections(departmentId: string, q: ElectionFilter, now: Date): Promise<Page<ElectionRec>>;
  getElection(departmentId: string, electionId: string): Promise<ElectionRec | null>;
  createElection(rec: NewElection): Promise<ElectionRec>;
  updateElection(departmentId: string, electionId: string, patch: ElectionPatch): Promise<ElectionRec | null>;
  /** Removes the election and its positions and candidates. The service only calls this for drafts (which can hold no votes). */
  deleteElection(departmentId: string, electionId: string): Promise<void>;
  structureCounts(electionIds: string[]): Promise<Map<string, StructureCount>>;

  listPositions(departmentId: string, electionId: string): Promise<PositionRec[]>;
  getPosition(departmentId: string, positionId: string): Promise<PositionRec | null>;
  createPosition(rec: NewPosition): Promise<PositionRec>;
  updatePosition(departmentId: string, positionId: string, patch: { title?: string; description?: string | null }): Promise<PositionRec | null>;
  /** Also removes the position's candidates. */
  deletePosition(departmentId: string, positionId: string): Promise<void>;
  setPositionOrder(departmentId: string, electionId: string, orderedIds: string[]): Promise<void>;

  listCandidates(departmentId: string, electionId: string, positionId?: string): Promise<CandidateRec[]>;
  getCandidate(departmentId: string, candidateId: string): Promise<CandidateRec | null>;
  /** Every candidacy (any status) this student has in this election. */
  candidaciesOfStudent(departmentId: string, electionId: string, studentId: string): Promise<CandidateRec[]>;
  createCandidate(rec: NewCandidate): Promise<CandidateRec>;
  updateCandidate(departmentId: string, candidateId: string, patch: CandidatePatch | { clearPhoto: true }): Promise<CandidateRec | null>;
  deleteCandidate(departmentId: string, candidateId: string): Promise<void>;

  getStudent(departmentId: string, studentId: string): Promise<StudentRef | null>;
  /** ACTIVE students of the department only. */
  searchStudents(departmentId: string, q: StudentSearch): Promise<Page<StudentRef>>;
  studentsByIds(departmentId: string, ids: string[]): Promise<StudentRef[]>;
  countStudentsInDepartment(departmentId: string, ids: string[]): Promise<number>;
  /** ACTIVE students of the department, in the electorate, whose academic session is the election's. */
  countElectorate(departmentId: string, e: Electorate): Promise<number>;

  /** Participation (who-voted-where) counts. Never reveals a choice. */
  participationByPosition(electionId: string): Promise<Map<string, number>>;
  distinctVoters(electionId: string): Promise<number>;
  tallies(electionId: string): Promise<Map<string, number>>;

  addAudit(rec: HodAuditRec): Promise<void>;
}
