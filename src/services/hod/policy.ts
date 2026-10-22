import { ACADEMIC_SESSION_REGEX, ATTENDANCE_ISSUE_THRESHOLD_PERCENT, LEVEL_REGEX, type Semester } from "../../utils/constants";

/* ----------------- who may provision HOD accounts ----------------- */
export interface Provisioner {
  name: string;
  /** SYSTEM_SETUP = the trusted operator running the provisioning script. SUPER_ADMIN is reserved for the future system-admin phase. */
  role: "SYSTEM_SETUP" | "SUPER_ADMIN" | "HOD" | "LECTURER" | "COURSE_REP" | "ASSISTANT_COURSE_REP" | "STUDENT";
}
/** HOD accounts are created by the system level only. A HOD can never create (or promote to) another HOD, or change a role. */
export function authorizeProvisioner(p: Provisioner): { ok: true } | { ok: false; reason: string } {
  return p.role === "SYSTEM_SETUP" || p.role === "SUPER_ADMIN" ? { ok: true } : { ok: false, reason: "HOD accounts can only be created by system administration." };
}

/* ----------------- sessions / terms ----------------- */
export const sessionStartYear = (s: string) => Number.parseInt(s.split("/")[0], 10);
/** "2026/2027" only (the second year must be the first + 1). */
export function isValidSession(s: string): boolean {
  const m = ACADEMIC_SESSION_REGEX.exec(s);
  return Boolean(m) && Number(m![2]) === Number(m![1]) + 1;
}
const semOrder = (s: Semester) => (s === "FIRST" ? 0 : 1);

/** A catalogue course may be added for the current session or the next one, never a past one. */
export function checkCourseSession(session: string, current: string | null): string | null {
  if (!isValidSession(session)) return "academicSession must look like 2026/2027.";
  if (current) {
    const diff = sessionStartYear(session) - sessionStartYear(current);
    if (diff < 0) return "You can't add courses to a past academic session.";
    if (diff > 1) return "You can only add courses for the current or the next academic session.";
  }
  return null;
}

/** Moving a department's current term: forward only, one step at a time, and the new session always starts with FIRST semester. */
export function checkTermTransition(current: { academicSession: string; semester: Semester } | null, target: { academicSession: string; semester: Semester }): string | null {
  if (!isValidSession(target.academicSession)) return "academicSession must look like 2026/2027.";
  if (!current) return null;
  if (current.academicSession === target.academicSession && current.semester === target.semester) return "That is already the current term.";
  const dy = sessionStartYear(target.academicSession) - sessionStartYear(current.academicSession);
  if (dy < 0 || (dy === 0 && semOrder(target.semester) < semOrder(current.semester))) return "The current term can only move forward, not back.";
  if (dy > 1) return "The term can only move to the next session, not skip sessions.";
  if (dy === 1 && target.semester !== "FIRST") return "A new academic session starts with the FIRST semester.";
  return null;
}

/* ----------------- students ----------------- */
export function checkStudentStatusChange(i: { current: string; next: string; onboardingCompleted: boolean }): string | null {
  if (i.next !== "ACTIVE" && i.next !== "SUSPENDED") return "Status must be ACTIVE or SUSPENDED.";
  if (!i.onboardingCompleted) return "This student hasn't completed account setup yet; there is nothing to activate or suspend.";
  if (i.current === i.next) return `The student is already ${i.next}.`;
  return null;
}

/* ----------------- courses ----------------- */
/** Level / semester are structural: once students are enrolled they can't be moved to a different class. */
export function checkCourseStructureChange(enrollmentCount: number, changes: { level?: boolean; semester?: boolean }): string | null {
  return enrollmentCount > 0 && (changes.level || changes.semester) ? "This course already has enrolled students, so its level and semester can't be changed." : null;
}

/* ----------------- levels ----------------- */
export function checkLevelChange(current: string[], next: string[], usage: { level: string; students: number; courses: number }[]): string | null {
  if (!next.length) return "A department needs at least one level.";
  if (new Set(next).size !== next.length) return "Levels must be unique.";
  if (next.some((l) => !LEVEL_REGEX.test(l))) return 'Levels must look like "100", "200", ...';
  for (const removed of current.filter((l) => !next.includes(l))) {
    const u = usage.find((x) => x.level === removed);
    if (u && (u.students > 0 || u.courses > 0)) return `Level ${removed} can't be removed: it still has ${u.students} student(s) and ${u.courses} course(s).`;
  }
  return null;
}

/* ----------------- complaints ----------------- */
export type ComplaintStatusName = "SUBMITTED" | "PENDING" | "UNDER_REVIEW" | "ASSIGNED" | "IN_PROGRESS" | "RESOLVED" | "REJECTED" | "CLOSED";
const NEXT: Record<ComplaintStatusName, ComplaintStatusName[]> = {
  SUBMITTED: ["UNDER_REVIEW", "ASSIGNED", "RESOLVED", "REJECTED", "CLOSED"],
  PENDING: ["UNDER_REVIEW", "ASSIGNED", "RESOLVED", "REJECTED", "CLOSED"],
  UNDER_REVIEW: ["ASSIGNED", "IN_PROGRESS", "RESOLVED", "REJECTED", "CLOSED"],
  ASSIGNED: ["UNDER_REVIEW", "IN_PROGRESS", "RESOLVED", "REJECTED", "CLOSED"],
  IN_PROGRESS: ["UNDER_REVIEW", "RESOLVED", "REJECTED", "CLOSED"],
  RESOLVED: ["CLOSED"],
  REJECTED: [],
  CLOSED: [],
};
export const HOD_SETTABLE_STATUSES: ComplaintStatusName[] = ["UNDER_REVIEW", "IN_PROGRESS", "RESOLVED", "REJECTED", "CLOSED"]; // ASSIGNED only via /assign
export const isClosedComplaint = (s: ComplaintStatusName) => s === "REJECTED" || s === "CLOSED";
export function checkComplaintTransition(from: ComplaintStatusName, to: ComplaintStatusName, via: "status" | "assign"): string | null {
  if (via === "status" && !HOD_SETTABLE_STATUSES.includes(to)) return "Use the assign endpoint to forward a complaint to a lecturer.";
  if (!NEXT[from].includes(to)) return `A complaint that is ${from} can't move to ${to}.`;
  return null;
}
/** A complaint is forwarded only to an ACTIVE lecturer of the same department; for a course complaint, one assigned to that course this term. */
export function checkComplaintAssignee(i: { lecturerFound: boolean; lecturerStatus?: string; hasCourse: boolean; lecturerOnCourse: boolean }): string | null {
  if (!i.lecturerFound) return "Lecturer not found in your department.";
  if (i.lecturerStatus !== "ACTIVE") return "Only an active lecturer can be assigned a complaint.";
  if (i.hasCourse && !i.lecturerOnCourse) return "That lecturer isn't assigned to the course this complaint is about.";
  return null;
}

/* ----------------- attendance ----------------- */
export const hasAttendanceIssue = (averagePercent: number | null, sessionsHeld: number): boolean =>
  averagePercent !== null && sessionsHeld >= 2 && averagePercent < ATTENDANCE_ISSUE_THRESHOLD_PERCENT;
