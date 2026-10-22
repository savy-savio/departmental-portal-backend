import type { RepAssignmentStatus, RepRole, Semester } from "../../utils/constants";

/**
 * Representative permissions are DATA, not scattered `if (role === ...)` checks, so they can be expanded later
 * by editing this table. A permission only ever applies inside the course the assignment covers.
 *
 * Deliberately absent from every role: assigning / revoking representatives, changing roles, editing the course
 * catalogue, the OFFICIAL departmental timetable (reps manage only their own class timetable), student profiles or
 * enrollment, lecturer (official) materials, and any attendance management. Those belong to HOD / lecturer phases and simply aren't permissions a rep can hold.
 */
export const PERMISSIONS = [
  "overview:view", "course:view", "members:view", "timetable:view", "notification:view",
  "timetable:create", "timetable:update", "timetable:delete",
  "announcement:view", "announcement:create", "announcement:update:own", "announcement:unpublish:own", "announcement:delete:own",
  "resource:view", "resource:create", "resource:update:own", "resource:delete:own",
  // Live quizzes: write and manage own quizzes; run (host) a game for the class. Always limited to the rep's OWN quizzes and games.
  "quiz:manage", "quiz:host",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEW: Permission[] = ["overview:view", "course:view", "members:view", "timetable:view", "notification:view", "announcement:view", "resource:view"];

export const ROLE_PERMISSIONS: Readonly<Record<RepRole, readonly Permission[]>> = Object.freeze({
  COURSE_REP: Object.freeze([
    ...VIEW,
    "announcement:create", "announcement:update:own", "announcement:unpublish:own", "announcement:delete:own",
    "resource:create", "resource:update:own", "resource:delete:own",
    // The Course Rep owns the CLASS timetable of their assigned course (not the departmental timetable).
    "timetable:create", "timetable:update", "timetable:delete",
    "quiz:manage", "quiz:host",
  ] as Permission[]),
  // Assistant: everything operational except permanently removing announcements, and a lower priority ceiling.
  // Timetable: VIEW only. To let assistants help later, add "timetable:create" / "timetable:update" / "timetable:delete" here.
  ASSISTANT_COURSE_REP: Object.freeze([
    ...VIEW,
    "announcement:create", "announcement:update:own", "announcement:unpublish:own",
    "resource:create", "resource:update:own", "resource:delete:own",
    "quiz:manage", "quiz:host",
  ] as Permission[]),
});

export type Priority = "NORMAL" | "IMPORTANT" | "URGENT";
const PRIORITY_RANK: Record<Priority, number> = { NORMAL: 0, IMPORTANT: 1, URGENT: 2 };
export const ROLE_CONSTRAINTS: Readonly<Record<RepRole, { maxAnnouncementPriority: Priority }>> = Object.freeze({
  COURSE_REP: { maxAnnouncementPriority: "URGENT" },
  ASSISTANT_COURSE_REP: { maxAnnouncementPriority: "IMPORTANT" },
});
export const MAX_ASSISTANTS_PER_COURSE = 2;

export type PermissionTable = Readonly<Record<RepRole, readonly Permission[]>>;
export const can = (role: RepRole, permission: Permission, table: PermissionTable = ROLE_PERMISSIONS): boolean => table[role]?.includes(permission) ?? false;
export const priorityAllowed = (role: RepRole, p: Priority): boolean => PRIORITY_RANK[p] <= PRIORITY_RANK[ROLE_CONSTRAINTS[role].maxAnnouncementPriority];

export interface AssignmentScope {
  studentId: string;
  departmentId: string;
  courseId?: string;
  academicSession: string;
  semester: Semester;
  status: RepAssignmentStatus;
}
/** An assignment only counts while ACTIVE, for this student, in their own department, in the department's CURRENT term. */
export function isAssignmentCurrent(
  a: AssignmentScope,
  actor: { studentId: string; departmentId: string },
  term: { academicSession: string; semester: Semester } | null,
): boolean {
  return Boolean(
    term && a.status === "ACTIVE" && a.studentId === actor.studentId && a.departmentId === actor.departmentId &&
      a.academicSession === term.academicSession && a.semester === term.semester,
  );
}

/* ----------------- who may create / revoke assignments (shared infrastructure for the HOD phase) ----------------- */
export interface Assigner {
  id?: string;
  name: string;
  role: "HOD" | "SUPER_ADMIN" | "LECTURER" | "COURSE_REP" | "ASSISTANT_COURSE_REP";
  departmentId: string;
}
/** Only a department's own HOD. Representatives (of either kind) can never assign or revoke, and there is no cross-department bypass. */
export function authorizeAssigner(assigner: Assigner, courseDepartmentId: string): { ok: true } | { ok: false; reason: string } {
  if (assigner.role !== "HOD") return { ok: false, reason: "Only the head of department can assign or revoke representatives." };
  if (assigner.departmentId !== courseDepartmentId) return { ok: false, reason: "You can only manage representatives of your own department." };
  return { ok: true };
}

export function checkAssignmentRules(i: {
  role: RepRole;
  studentDepartmentId: string;
  courseDepartmentId: string;
  studentStatus: string;
  courseIsCurrentTerm: boolean;
  activeOnCourse: { studentId: string; role: RepRole }[];
  studentId: string;
}): string | null {
  if (i.studentDepartmentId !== i.courseDepartmentId) return "The student must belong to the same department as the course.";
  if (i.studentStatus !== "ACTIVE") return "Only active students can be representatives.";
  if (!i.courseIsCurrentTerm) return "Representatives can only be assigned to courses in the current term.";
  if (i.activeOnCourse.some((a) => a.studentId === i.studentId)) return "This student already holds an active role for this course.";
  if (i.role === "COURSE_REP" && i.activeOnCourse.some((a) => a.role === "COURSE_REP")) return "This course already has an active Course Rep.";
  if (i.role === "ASSISTANT_COURSE_REP" && i.activeOnCourse.filter((a) => a.role === "ASSISTANT_COURSE_REP").length >= MAX_ASSISTANTS_PER_COURSE) {
    return `A course can have at most ${MAX_ASSISTANTS_PER_COURSE} Assistant Course Reps.`;
  }
  return null;
}

/* ----------------- what an appointment covers: a LEVEL (new) or one course (legacy records) ----------------- */
export interface CoverageHolder {
  departmentId: string;
  scope?: "LEVEL" | "COURSE";
  courseId?: string;
  courseCode?: string;
  level: string;
  academicSession: string;
  semester: Semester;
}
export interface CoveredThing {
  departmentId: string;
  courseId?: string;
  courseCode?: string;
  level: string;
  academicSession: string;
  semester: Semester;
}
/**
 * Does this appointment give authority over a course / class record?
 *  - LEVEL: same department, same level, same session and semester (every course of the level, and the class itself).
 *  - legacy COURSE (no `scope`): only that one course.
 * A different department never matches, whatever the level.
 */
export function appointmentCovers(a: CoverageHolder, thing: CoveredThing): boolean {
  if (a.departmentId !== thing.departmentId) return false;
  if (a.scope === "LEVEL") return a.level === thing.level && a.academicSession === thing.academicSession && a.semester === thing.semester;
  const sameCourse = (a.courseId && thing.courseId && a.courseId === thing.courseId) || (a.courseCode && thing.courseCode && a.courseCode === thing.courseCode);
  return Boolean(sameCourse) && a.academicSession === thing.academicSession && a.semester === thing.semester;
}

/** Rules for appointing a Course Rep / Assistant for a LEVEL in the department's current term. Returns the first problem, or null. */
export function checkLevelAppointment(i: {
  role: RepRole;
  studentId: string;
  studentDepartmentId: string;
  departmentId: string;
  studentStatus: string;
  level: string;
  departmentLevels: string[];
  hasCurrentTerm: boolean;
  activeOnLevel: { studentId: string; role: RepRole }[];
}): string | null {
  if (i.studentDepartmentId !== i.departmentId) return "The student must belong to your department.";
  if (i.studentStatus !== "ACTIVE") return "Only active students can be representatives.";
  if (!i.departmentLevels.includes(i.level)) return `${i.level} Level isn't offered by your department.`;
  if (!i.hasCurrentTerm) return "Set the department's current term before appointing representatives.";
  if (i.activeOnLevel.some((a) => a.studentId === i.studentId)) return `This student already holds an active representative role for ${i.level} Level.`;
  if (i.role === "COURSE_REP" && i.activeOnLevel.some((a) => a.role === "COURSE_REP")) return `${i.level} Level already has an active Course Rep.`;
  if (i.role === "ASSISTANT_COURSE_REP" && i.activeOnLevel.filter((a) => a.role === "ASSISTANT_COURSE_REP").length >= MAX_ASSISTANTS_PER_COURSE) {
    return `${i.level} Level can have at most ${MAX_ASSISTANTS_PER_COURSE} Assistant Course Reps.`;
  }
  return null;
}
