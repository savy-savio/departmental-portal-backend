import type { EnrollmentType, Semester } from "../utils/constants";

/**
 * Pure, database-free rules for "may this student take this course this term?".
 * Kept separate so the rules are unit-tested and reused by future roles (e.g. a course rep
 * registering a student) without copying logic.
 */
export interface StudentScope {
  departmentId: string;
  level: string;
  academicSession: string;
}
export interface CourseScope {
  departmentId: string;
  level: string;
  semester: Semester;
  academicSession: string;
  status: "ACTIVE" | "ARCHIVED";
}
export interface TermScope {
  academicSession: string;
  semester: Semester;
}

export type Eligibility = { ok: true } | { ok: false; reason: string };

/** "2026/2027" -> 2026 */
export const sessionStartYear = (session: string): number => Number.parseInt(session.split("/")[0], 10);

export function evaluateEligibility(
  student: StudentScope,
  course: CourseScope,
  term: TermScope,
  type: EnrollmentType,
): Eligibility {
  const no = (reason: string): Eligibility => ({ ok: false, reason });

  if (course.departmentId !== student.departmentId) return no("This course does not belong to your department.");
  if (student.academicSession !== term.academicSession) {
    return no(
      `Your academic record is for ${student.academicSession}, but the current session is ${term.academicSession}. Contact your department to update it before registering.`,
    );
  }
  if (course.semester !== term.semester) return no(`This course is not offered in the current semester.`);

  const courseLevel = Number.parseInt(course.level, 10);
  const studentLevel = Number.parseInt(student.level, 10);
  const courseYear = sessionStartYear(course.academicSession);
  const termYear = sessionStartYear(term.academicSession);

  if (type === "REGULAR") {
    if (course.status !== "ACTIVE") return no("This course is not available for registration.");
    if (course.academicSession !== term.academicSession) return no("This course is not part of the current session's catalogue.");
    if (course.level !== student.level) {
      return no(`This is a ${course.level} level course. Add it as a carryover if you are repeating it.`);
    }
    return { ok: true };
  }

  // CARRYOVER: an earlier level, or an earlier session, but never a level above the student's own.
  if (courseLevel > studentLevel) return no("You cannot carry over a course from a level above yours.");
  const earlierLevel = courseLevel < studentLevel;
  const earlierSession = courseYear < termYear;
  if (!earlierLevel && !earlierSession) {
    return no("This is one of your regular courses for this term. Add it as REGULAR, not carryover.");
  }
  return { ok: true };
}
