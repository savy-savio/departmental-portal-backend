import type { DepartmentDocument } from "../models/Department";
import { AcademicTerm, AcademicTermDocument, isRegistrationOpen } from "../models/AcademicTerm";
import { Course, CourseDocument } from "../models/Course";
import { CourseEnrollment, CourseEnrollmentDocument } from "../models/CourseEnrollment";
import type { StudentDocument } from "../models/Student";
import { AppError } from "../utils/AppError";
import type { EnrollmentType } from "../utils/constants";
import type { AddCourseInput, UpdateEnrollmentInput } from "../validators/student-courses.validators";
import { lecturersByCourse } from "./course-lecturers";
import { publicLecturers, type CourseLecturer } from "./course-lecturers-rules";
import { evaluateEligibility, StudentScope } from "./enrollment-rules";

/* ---------------------------- helpers ---------------------------- */

const idStr = (v: unknown): string => String(v);

const studentScope = (s: StudentDocument): StudentScope => ({
  departmentId: idStr(s.department),
  level: s.level,
  academicSession: s.academicSession,
});

const courseScope = (c: CourseDocument) => ({
  departmentId: idStr(c.department),
  level: c.level,
  semester: c.semester,
  academicSession: c.academicSession,
  status: c.status,
});

/** Lecturers assigned to these courses (names only: students never get ids or contact details). */
async function lecturerNames(departmentId: unknown, courses: CourseDocument[]): Promise<Map<string, CourseLecturer[]>> {
  return lecturersByCourse(departmentId, courses.map((c) => c._id));
}

function courseDTO(c: CourseDocument, lecturers: CourseLecturer[] = []) {
  return {
    lecturers: publicLecturers(lecturers),
    id: idStr(c._id),
    courseCode: c.courseCode,
    title: c.title,
    units: c.units,
    level: c.level,
    semester: c.semester,
    academicSession: c.academicSession,
    status: c.status,
  };
}

function enrollmentDTO(e: CourseEnrollmentDocument, course: CourseDocument | undefined, lecturers: CourseLecturer[] = []) {
  return {
    id: idStr(e._id),
    enrollmentType: e.enrollmentType,
    status: e.status,
    academicSession: e.academicSession,
    semester: e.semester,
    course: course ? courseDTO(course, lecturers) : null,
    enrolledAt: (e as unknown as { createdAt: Date }).createdAt,
  };
}

function termDTO(t: AcademicTermDocument) {
  return {
    academicSession: t.academicSession,
    semester: t.semester,
    registrationOpen: isRegistrationOpen(t),
    registrationOpensAt: t.registrationOpensAt ?? null,
    registrationClosesAt: t.registrationClosesAt ?? null,
    maxUnits: t.maxUnits,
  };
}

async function currentTerm(department: DepartmentDocument): Promise<AcademicTermDocument | null> {
  return AcademicTerm.findOne({ department: department._id, isCurrent: true });
}

async function requireCurrentTerm(department: DepartmentDocument): Promise<AcademicTermDocument> {
  const term = await currentTerm(department);
  if (!term) throw new AppError(409, "No academic term is currently active for your department.");
  return term;
}

function requireRegistrationOpen(term: AcademicTermDocument): void {
  if (!isRegistrationOpen(term)) throw new AppError(403, "Course registration is currently closed.");
}

async function termEnrollments(student: StudentDocument, term: AcademicTermDocument) {
  return CourseEnrollment.find({
    student: student._id, // always the authenticated student
    academicSession: term.academicSession,
    semester: term.semester,
    status: "ENROLLED",
  }).sort({ courseCode: 1 });
}

async function courseMap(ids: unknown[]): Promise<Map<string, CourseDocument>> {
  const courses = await Course.find({ _id: { $in: ids } });
  return new Map(courses.map((c) => [idStr(c._id), c]));
}

function sumUnits(enrollments: CourseEnrollmentDocument[], courses: Map<string, CourseDocument>, skipId?: string): number {
  return enrollments.reduce((sum, e) => {
    if (skipId && idStr(e._id) === skipId) return sum;
    return sum + (courses.get(idStr(e.course))?.units ?? 0);
  }, 0);
}

/* ---------------------------- reads ---------------------------- */

export async function listMyCourses(student: StudentDocument, department: DepartmentDocument) {
  const term = await currentTerm(department);
  if (!term) return { term: null, totalUnits: 0, enrollments: [] };
  const enrollments = await termEnrollments(student, term);
  const courses = await courseMap(enrollments.map((e) => e.course));
  const names = await lecturerNames(department._id, [...courses.values()]);
  return {
    term: termDTO(term),
    totalUnits: sumUnits(enrollments, courses),
    enrollments: enrollments.map((e) => enrollmentDTO(e, courses.get(idStr(e.course)), names.get(idStr(e.course)))),
  };
}

/** The department's catalogue for the student's own level in the current term. */
export async function listAvailableCourses(student: StudentDocument, department: DepartmentDocument) {
  const term = await currentTerm(department);
  if (!term) return { term: null, courses: [] };

  const [courses, mine] = await Promise.all([
    Course.find({
      department: department._id, // from the JWT-derived department, never from the request
      level: student.level,
      academicSession: term.academicSession,
      semester: term.semester,
      status: "ACTIVE",
    }).sort({ courseCode: 1 }),
    termEnrollments(student, term),
  ]);
  const enrolledCourseIds = new Set(mine.map((e) => idStr(e.course)));
  const names = await lecturerNames(department._id, courses);
  return {
    term: termDTO(term),
    courses: courses.map((c) => ({ ...courseDTO(c, names.get(idStr(c._id))), enrolled: enrolledCourseIds.has(idStr(c._id)) })),
  };
}

/** Earlier-level / earlier-session courses the student could register as carryover this term. */
export async function listCarryoverOptions(student: StudentDocument, department: DepartmentDocument) {
  const term = await currentTerm(department);
  if (!term) return { term: null, courses: [] };

  const [candidates, mine] = await Promise.all([
    Course.find({
      department: department._id,
      semester: term.semester,
      $or: [
        { level: { $lt: student.level } },
        { level: { $lte: student.level }, academicSession: { $lt: term.academicSession } },
      ],
    }),
    termEnrollments(student, term),
  ]);

  const takenCodes = new Set(mine.map((e) => e.courseCode));
  // If a code exists in several sessions, offer the most recent record only.
  const latest = new Map<string, CourseDocument>();
  for (const c of candidates) {
    if (takenCodes.has(c.courseCode)) continue;
    const seen = latest.get(c.courseCode);
    if (!seen || c.academicSession > seen.academicSession) latest.set(c.courseCode, c);
  }
  const eligible = [...latest.values()].filter((c) =>
    evaluateEligibility(studentScope(student), courseScope(c), term, "CARRYOVER").ok,
  );
  eligible.sort((a, b) => a.level.localeCompare(b.level) || a.courseCode.localeCompare(b.courseCode));
  const names = await lecturerNames(department._id, eligible);
  return { term: termDTO(term), courses: eligible.map((c) => courseDTO(c, names.get(idStr(c._id)))) };
}

export async function courseHistory(student: StudentDocument) {
  const all = await CourseEnrollment.find({ student: student._id }).sort({ academicSession: -1, semester: 1, courseCode: 1 });
  const courses = await courseMap(all.map((e) => e.course));
  const names = await lecturerNames(student.department, [...courses.values()]);

  interface HistoryGroup {
    academicSession: string;
    semester: string;
    totalUnits: number;
    courses: ReturnType<typeof enrollmentDTO>[];
  }
  const groups = new Map<string, HistoryGroup>();
  for (const e of all) {
    const key = `${e.academicSession}|${e.semester}`;
    const g: HistoryGroup = groups.get(key) ?? { academicSession: e.academicSession, semester: e.semester, totalUnits: 0, courses: [] };
    const course = courses.get(idStr(e.course));
    if (e.status !== "WITHDRAWN") g.totalUnits += course?.units ?? 0;
    g.courses.push(enrollmentDTO(e, course, names.get(idStr(e.course))));
    groups.set(key, g);
  }
  return [...groups.values()];
}

/* ---------------------------- writes ---------------------------- */

export async function addCourse(student: StudentDocument, department: DepartmentDocument, input: AddCourseInput) {
  const term = await requireCurrentTerm(department);
  requireRegistrationOpen(term);

  // Department filter means another department's course id is simply "not found" (no existence leak).
  const course = await Course.findOne({ _id: input.courseId, department: department._id });
  if (!course) throw new AppError(404, "Course not found.");

  const verdict = evaluateEligibility(studentScope(student), courseScope(course), term, input.enrollmentType);
  if (!verdict.ok) throw new AppError(422, verdict.reason);

  const current = await termEnrollments(student, term);
  if (current.some((e) => e.courseCode === course.courseCode)) {
    throw new AppError(409, `You are already registered for ${course.courseCode} this semester.`);
  }
  const courses = await courseMap(current.map((e) => e.course));
  const total = sumUnits(current, courses);
  if (total + course.units > term.maxUnits) {
    throw new AppError(409, `Adding ${course.courseCode} would bring you to ${total + course.units} units; the maximum is ${term.maxUnits}.`);
  }

  let created: CourseEnrollmentDocument;
  try {
    created = await CourseEnrollment.create({
      student: student._id,
      course: course._id,
      department: department._id,
      courseCode: course.courseCode,
      academicSession: term.academicSession,
      semester: term.semester,
      enrollmentType: input.enrollmentType,
      status: "ENROLLED",
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw new AppError(409, `You are already registered for ${course.courseCode} this semester.`);
    }
    throw err;
  }

  // Two simultaneous requests could both pass the check above; re-verify and roll back if so.
  const after = await termEnrollments(student, term);
  const afterCourses = await courseMap(after.map((e) => e.course));
  if (sumUnits(after, afterCourses) > term.maxUnits) {
    await CourseEnrollment.deleteOne({ _id: created._id });
    throw new AppError(409, `That would exceed the ${term.maxUnits}-unit maximum.`);
  }

  return enrollmentDTO(created, course, (await lecturerNames(department._id, [course])).get(idStr(course._id)));
}

async function loadEditableEnrollment(student: StudentDocument, department: DepartmentDocument, enrollmentId: string) {
  // Ownership is part of the query: someone else's enrollment id is simply "not found".
  const enrollment = await CourseEnrollment.findOne({ _id: enrollmentId, student: student._id, department: department._id });
  if (!enrollment) throw new AppError(404, "Enrollment not found.");

  const term = await requireCurrentTerm(department);
  if (enrollment.academicSession !== term.academicSession || enrollment.semester !== term.semester) {
    throw new AppError(403, "Registrations from past semesters can't be changed.");
  }
  if (enrollment.status !== "ENROLLED") throw new AppError(409, "This registration can no longer be changed.");
  requireRegistrationOpen(term);
  return { enrollment, term };
}

export async function updateEnrollment(
  student: StudentDocument,
  department: DepartmentDocument,
  enrollmentId: string,
  input: UpdateEnrollmentInput,
) {
  const { enrollment, term } = await loadEditableEnrollment(student, department, enrollmentId);
  const course = await Course.findById(enrollment.course);
  if (!course) throw new AppError(404, "Course not found.");

  const verdict = evaluateEligibility(studentScope(student), courseScope(course), term, input.enrollmentType as EnrollmentType);
  if (!verdict.ok) throw new AppError(422, verdict.reason);

  enrollment.enrollmentType = input.enrollmentType;
  await enrollment.save();
  return enrollmentDTO(enrollment, course, (await lecturerNames(department._id, [course])).get(idStr(course._id)));
}

export async function removeEnrollment(student: StudentDocument, department: DepartmentDocument, enrollmentId: string) {
  const { enrollment } = await loadEditableEnrollment(student, department, enrollmentId);
  await CourseEnrollment.deleteOne({ _id: enrollment._id, student: student._id });
}
