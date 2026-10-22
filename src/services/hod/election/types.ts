import type { ElectionLifecycle } from "../../election-rules";
import type { ElectorateMode } from "../../../utils/constants";
import type { ListQuery } from "../types";

export type { ElectionLifecycle, ElectorateMode };

export interface ElectionRec {
  id: string;
  departmentId: string;
  title: string;
  description?: string;
  academicSession: string;
  electorateMode: ElectorateMode;
  eligibleLevels: string[];
  eligibleStudentIds: string[];
  votingOpensAt: Date;
  votingClosesAt: Date;
  /** Stored status. The HOD-facing lifecycle (SCHEDULED / ACTIVE / CLOSED) is derived from this plus the clock. */
  status: "DRAFT" | "PUBLISHED" | "CANCELLED";
  resultsPublished: boolean;
  createdByName: string;
  createdByRole: string;
  createdAt: Date;
  updatedAt: Date;
}
export type NewElection = Omit<ElectionRec, "id" | "createdAt" | "updatedAt">;
export type ElectionPatch = Partial<Pick<ElectionRec, "title" | "description" | "academicSession" | "electorateMode" | "eligibleLevels" | "eligibleStudentIds" | "votingOpensAt" | "votingClosesAt" | "status" | "resultsPublished">>;

export interface PositionRec { id: string; electionId: string; departmentId: string; title: string; description?: string; order: number }
export type NewPosition = Omit<PositionRec, "id">;

export type CandidateStatus = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";
export interface CandidateStudent { firstName: string; lastName: string; matricNumber: string; level: string; profilePhoto?: string }
export interface CandidateRec {
  id: string; electionId: string; positionId: string; departmentId: string; studentId: string;
  manifesto?: string; photo?: string; photoPublicId?: string; status: CandidateStatus; decidedByName?: string; decidedAt?: Date;
  student: CandidateStudent;
}
export type NewCandidate = Omit<CandidateRec, "id" | "student">;
export type CandidatePatch = Partial<Pick<CandidateRec, "manifesto" | "photo" | "photoPublicId" | "status" | "decidedByName" | "decidedAt">>;

/** Minimal student view for candidate search and group membership: no email / phone. */
export interface StudentRef { id: string; firstName: string; lastName: string; matricNumber: string; level: string; status: "PENDING_ONBOARDING" | "ACTIVE" | "SUSPENDED"; academicSession: string; profilePhoto?: string }

export interface ElectionFilter extends ListQuery { lifecycle?: ElectionLifecycle }
export interface StudentSearch { page: number; limit: number; search?: string; level?: string }
export interface Electorate { academicSession: string; electorateMode: ElectorateMode; eligibleLevels: string[]; eligibleStudentIds: string[] }
export interface StructureCount { positions: number; approvedCandidates: number; pendingCandidates: number }
