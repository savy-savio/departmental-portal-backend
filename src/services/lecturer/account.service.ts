import { AcademicTerm } from "../../models/AcademicTerm";
import { Course } from "../../models/Course";
import { Department } from "../../models/Department";
import { Lecturer } from "../../models/Lecturer";
import { LecturerAuditLog } from "../../models/LecturerAuditLog";
import { LecturerCourseAssignment } from "../../models/LecturerCourseAssignment";
import { AppError } from "../../utils/AppError";
import { generateToken, sha256 } from "../../utils/crypto";
import { sendInBackground, sendLecturerInviteEmail } from "../email.service";
import type { Assigner } from "../representative/policy";
import { authorizeLecturerAdmin, checkLecturerAssignmentRules } from "./policy";

const INVITE_HOURS = 72;
const audit = (assigner: Assigner, action: string, x: { lecturerId?: string; courseId?: unknown; courseCode?: string; departmentId: string; resourceId?: string; detail?: Record<string, unknown> }) =>
  LecturerAuditLog.create({ actorName: assigner.name, role: assigner.role, action, resourceType: "LECTURER", resourceId: x.resourceId ?? x.lecturerId, course: x.courseId, courseCode: x.courseCode, department: x.departmentId, detail: x.detail, at: new Date() });

/**
 * Shared infrastructure for the HOD phase (and the seeder until then). NOT reachable from any lecturer or student route.
 * The new lecturer's department is the CREATOR's department, never an input, so a HOD can't create staff for another department.
 */
export async function createLecturerAccount(
  creator: Assigner,
  input: { firstName: string; lastName: string; email: string; phone?: string; staffId: string },
  opts: { sendEmail?: boolean; returnToken?: boolean } = {},
) {
  const verdict = authorizeLecturerAdmin(creator, creator.departmentId);
  if (!verdict.ok) throw new AppError(403, verdict.reason, undefined, "ASSIGNER_NOT_AUTHORIZED");
  const dept = await Department.findById(creator.departmentId);
  if (!dept || !dept.isActive) throw new AppError(409, "That department is not active.");

  const raw = generateToken(32);
  try {
    const lecturer = await Lecturer.create({
      firstName: input.firstName, lastName: input.lastName, email: input.email, phone: input.phone, staffId: input.staffId, department: dept._id,
      status: "INVITED", activationTokenHash: sha256(raw), activationExpires: new Date(Date.now() + INVITE_HOURS * 3_600_000),
    });
    await audit(creator, "ACCOUNT_CREATED", { lecturerId: String(lecturer._id), departmentId: String(dept._id), detail: { staffId: lecturer.staffId } });
    if (opts.sendEmail !== false) sendInBackground("lecturer-invite", sendLecturerInviteEmail(lecturer.email, lecturer.firstName, raw, INVITE_HOURS));
    return { lecturer, ...(opts.returnToken ? { activationToken: raw } : {}) }; // the raw token is for a trusted caller only; never put it in an HTTP response
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new AppError(409, "A lecturer with that email or staff ID already exists.", undefined, "LECTURER_DUPLICATE");
    throw e;
  }
}

export async function assignLecturerToCourse(assigner: Assigner, input: { lecturerId: string; courseId: string }) {
  const course = await Course.findById(input.courseId);
  if (!course) throw new AppError(404, "Course not found.");
  const verdict = authorizeLecturerAdmin(assigner, String(course.department));
  if (!verdict.ok) throw new AppError(403, verdict.reason, undefined, "ASSIGNER_NOT_AUTHORIZED");
  const [lecturer, term, existing] = await Promise.all([
    Lecturer.findById(input.lecturerId), AcademicTerm.findOne({ department: course.department, isCurrent: true }),
    LecturerCourseAssignment.exists({ lecturer: input.lecturerId, course: course._id, status: "ACTIVE" }),
  ]);
  if (!lecturer) throw new AppError(404, "Lecturer not found.");
  const problem = checkLecturerAssignmentRules({
    lecturerDepartmentId: String(lecturer.department), courseDepartmentId: String(course.department), lecturerStatus: lecturer.status,
    courseIsCurrentTerm: Boolean(term && term.academicSession === course.academicSession && term.semester === course.semester), alreadyActiveOnCourse: Boolean(existing),
  });
  if (problem) throw new AppError(422, problem, undefined, "ASSIGNMENT_RULE");
  try {
    const a = await LecturerCourseAssignment.create({
      lecturer: lecturer._id, department: course.department, course: course._id, courseCode: course.courseCode, level: course.level, academicSession: course.academicSession,
      semester: course.semester, status: "ACTIVE", assignedBy: { name: assigner.name, role: assigner.role, id: assigner.id }, assignedAt: new Date(),
    });
    await audit(assigner, "LECTURER_ASSIGNED_TO_COURSE", { lecturerId: String(lecturer._id), courseId: course._id, courseCode: course.courseCode, departmentId: String(course.department), resourceId: String(a._id) });
    return a;
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new AppError(409, "This lecturer is already assigned to the course.", undefined, "ASSIGNMENT_DUPLICATE"); // unique partial index is the final guard
    throw e;
  }
}

/** Ends a lecturer's authority over the course. It takes effect on their very next request. */
export async function revokeLecturerAssignment(assigner: Assigner, assignmentId: string) {
  const a = await LecturerCourseAssignment.findById(assignmentId);
  if (!a || String(a.department) !== assigner.departmentId) throw new AppError(404, "Assignment not found."); // other department's HOD gets the same answer as a missing id
  const verdict = authorizeLecturerAdmin(assigner, String(a.department));
  if (!verdict.ok) throw new AppError(403, verdict.reason, undefined, "ASSIGNER_NOT_AUTHORIZED");
  const u = await LecturerCourseAssignment.findOneAndUpdate({ _id: a._id, status: { $ne: "REVOKED" } }, { $set: { status: "REVOKED", revokedAt: new Date(), revokedBy: { name: assigner.name, role: assigner.role, id: assigner.id } } }, { new: true });
  if (!u) throw new AppError(409, "This assignment was already revoked.");
  await audit(assigner, "LECTURER_UNASSIGNED", { lecturerId: String(a.lecturer), courseId: a.course, courseCode: a.courseCode, departmentId: String(a.department), resourceId: String(a._id) });
  return u;
}

/** Suspend / reinstate a lecturer. A suspended lecturer is refused on the very next request (status is read from the database each time). */
export async function setLecturerStatus(assigner: Assigner, lecturerId: string, status: "ACTIVE" | "SUSPENDED") {
  const l = await Lecturer.findById(lecturerId);
  if (!l || String(l.department) !== assigner.departmentId) throw new AppError(404, "Lecturer not found.");
  const verdict = authorizeLecturerAdmin(assigner, String(l.department));
  if (!verdict.ok) throw new AppError(403, verdict.reason, undefined, "ASSIGNER_NOT_AUTHORIZED");
  if (l.status === "INVITED") throw new AppError(409, "This lecturer hasn't activated their account yet.");
  l.status = status;
  await l.save();
  return l;
}
