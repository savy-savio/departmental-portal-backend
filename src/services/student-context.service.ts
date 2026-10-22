import { AcademicTerm, AcademicTermDocument } from "../models/AcademicTerm";
import { CourseEnrollment } from "../models/CourseEnrollment";
import type { DepartmentDocument } from "../models/Department";
import type { StudentDocument } from "../models/Student";

export interface StudentContext {
  term: AcademicTermDocument | null;
  /** Course codes the student is registered for in the current term (regular + carryover). */
  enrolledCodes: string[];
}

/** Shared by timetable / announcements / materials / assignments so "my courses" means one thing everywhere. */
export async function loadStudentContext(student: StudentDocument, department: DepartmentDocument): Promise<StudentContext> {
  const term = await AcademicTerm.findOne({ department: department._id, isCurrent: true });
  if (!term) return { term: null, enrolledCodes: [] };
  const rows = await CourseEnrollment.find({
    student: student._id,
    academicSession: term.academicSession,
    semester: term.semester,
    status: "ENROLLED",
  }).select("courseCode");
  return { term, enrolledCodes: rows.map((r) => r.courseCode) };
}

export const pageMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});
