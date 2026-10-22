import type { Semester } from "../../utils/constants";
import { checkComplaintTransition, type ComplaintStatusName } from "../hod/policy";
export { authorizeAssigner as authorizeLecturerAdmin } from "../representative/policy";

export interface LecturerAssignmentScope {
  lecturerId: string;
  departmentId: string;
  academicSession: string;
  semester: Semester;
  status: "ACTIVE" | "INACTIVE" | "REVOKED";
}

/**
 * An assignment only counts while ACTIVE, for THIS lecturer, in THEIR department, in the department's CURRENT term.
 * (Last term's assignment is inert until the HOD renews it.) Pure so it is unit-tested.
 */
export function isLecturerAssignmentCurrent(
  a: LecturerAssignmentScope,
  actor: { lecturerId: string; departmentId: string },
  term: { academicSession: string; semester: Semester } | null,
): boolean {
  return Boolean(
    term && a.status === "ACTIVE" && a.lecturerId === actor.lecturerId && a.departmentId === actor.departmentId &&
      a.academicSession === term.academicSession && a.semester === term.semester,
  );
}

/** Business rules for putting a lecturer on a course (used by the account service the HOD phase will call). */
export function checkLecturerAssignmentRules(i: {
  lecturerDepartmentId: string;
  courseDepartmentId: string;
  lecturerStatus: string;
  courseIsCurrentTerm: boolean;
  alreadyActiveOnCourse: boolean;
}): string | null {
  if (i.lecturerDepartmentId !== i.courseDepartmentId) return "The lecturer must belong to the same department as the course.";
  if (i.lecturerStatus === "SUSPENDED") return "A suspended lecturer can't be assigned to courses.";
  if (!i.courseIsCurrentTerm) return "Lecturers can only be assigned to courses in the current term.";
  if (i.alreadyActiveOnCourse) return "This lecturer is already assigned to the course.";
  return null;
}

export const MAX_DASHBOARD_ITEMS = 5;

/* ----------------- complaints forwarded by the HOD ----------------- */
/** A lecturer acts only on a complaint the HOD forwarded and has not yet decided. */
export const LECTURER_ACTIONABLE_COMPLAINT: readonly ComplaintStatusName[] = ["ASSIGNED", "IN_PROGRESS"];
/** Replies stay possible after handing back to the HOD (UNDER_REVIEW) so the HOD can ask follow-up questions. */
export const LECTURER_RESPONDABLE_COMPLAINT: readonly ComplaintStatusName[] = ["ASSIGNED", "IN_PROGRESS", "UNDER_REVIEW"];
/** The only statuses a lecturer may set. Resolving, rejecting, closing and forwarding are HOD-only: the HOD makes the final decision. */
export const LECTURER_SETTABLE_COMPLAINT: readonly ComplaintStatusName[] = ["IN_PROGRESS", "UNDER_REVIEW"];

export type LecturerComplaintStatusCheck = { ok: true } | { ok: false; status: 403 | 409; code: string; message: string };
export function checkLecturerComplaintStatus(from: ComplaintStatusName, to: ComplaintStatusName): LecturerComplaintStatusCheck {
  if (!LECTURER_SETTABLE_COMPLAINT.includes(to)) {
    return { ok: false, status: 403, code: "HOD_ONLY_ACTION", message: "Only the HOD can resolve, reject, close or forward a complaint. Use \"returned to HOD\" (UNDER_REVIEW) to recommend an outcome." };
  }
  if (!LECTURER_ACTIONABLE_COMPLAINT.includes(from)) {
    return { ok: false, status: 409, code: "COMPLAINT_TRANSITION_REFUSED", message: `A complaint that is ${from} can't be updated by the lecturer.` };
  }
  const problem = checkComplaintTransition(from, to, "status"); // the shared workflow table still has the last word
  return problem ? { ok: false, status: 409, code: "COMPLAINT_TRANSITION_REFUSED", message: problem } : { ok: true };
}
