import { Lecturer } from "../models/Lecturer";
import { LecturerCourseAssignment } from "../models/LecturerCourseAssignment";
import { groupCourseLecturers, type CourseLecturer } from "./course-lecturers-rules";

/**
 * Lecturers assigned (ACTIVE assignment) to each of these courses, in ONE department. Two queries however many courses there are.
 * The department filter is applied to both collections, so ids from another department can never produce a name.
 */
export async function lecturersByCourse(departmentId: unknown, courseIds: unknown[]): Promise<Map<string, CourseLecturer[]>> {
  if (!courseIds.length) return new Map();
  const rows = await LecturerCourseAssignment.find({ department: departmentId, course: { $in: courseIds }, status: "ACTIVE" }).select("course lecturer");
  if (!rows.length) return new Map();
  const ls = await Lecturer.find({ _id: { $in: rows.map((r) => r.lecturer) }, department: departmentId }).select("firstName lastName status");
  return groupCourseLecturers(
    rows.map((r) => ({ courseId: String(r.course), lecturerId: String(r.lecturer) })),
    ls.map((l) => ({ id: String(l._id), firstName: l.firstName, lastName: l.lastName, status: l.status })),
  );
}
