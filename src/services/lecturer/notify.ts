import { LecturerCourseAssignment } from "../../models/LecturerCourseAssignment";
import { notify } from "../notification.service";

/** Notifies the lecturers currently assigned to a course (same notification system, recipientType LECTURER). Best-effort. */
export async function notifyCourseLecturers(
  course: { departmentId: string; courseCode: string; academicSession: string; semester: "FIRST" | "SECOND" },
  n: { kind: "ASSIGNMENT" | "ATTENDANCE" | "SYSTEM"; title: string; body: string; link?: string },
): Promise<void> {
  const rows = await LecturerCourseAssignment.find({
    department: course.departmentId, courseCode: course.courseCode, academicSession: course.academicSession, semester: course.semester, status: "ACTIVE",
  }).select("lecturer");
  await notify(rows.map((r) => ({ recipient: r.lecturer, recipientType: "LECTURER" as const, department: course.departmentId as never, kind: n.kind, title: n.title, body: n.body, link: n.link })));
}
