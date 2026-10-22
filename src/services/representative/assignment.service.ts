import { AcademicTerm } from "../../models/AcademicTerm";
import { Department } from "../../models/Department";
import { CourseRepresentativeAssignment } from "../../models/CourseRepresentativeAssignment";
import { RepresentativeAuditLog } from "../../models/RepresentativeAuditLog";
import { Student } from "../../models/Student";
import { AppError } from "../../utils/AppError";
import type { RepRole } from "../../utils/constants";
import { authorizeAssigner, checkLevelAppointment, type Assigner } from "./policy";

/**
 * Appoints a representative for a LEVEL of the department (not a course). Shared authorization infrastructure for the HOD phase (and the seeder until then).
 * It is NOT exposed through any student or representative route: nobody can become a representative by sending
 * `{ role: "COURSE_REP" }`, and representatives of either kind can never call this (authorizeAssigner: HOD of the same department only).
 */
export async function assignRepresentative(assigner: Assigner, input: { studentId: string; level: string; role: RepRole }) {
  const [dept, student, term] = await Promise.all([
    Department.findById(assigner.departmentId),
    Student.findById(input.studentId),
    AcademicTerm.findOne({ department: assigner.departmentId, isCurrent: true }),
  ]);
  if (!dept) throw new AppError(404, "Department not found.");
  const verdict = authorizeAssigner(assigner, String(dept._id));
  if (!verdict.ok) throw new AppError(403, verdict.reason, undefined, "ASSIGNER_NOT_AUTHORIZED");
  if (!student || String(student.department) !== assigner.departmentId) throw new AppError(404, "Student not found.");

  const active = term
    ? await CourseRepresentativeAssignment.find({ department: dept._id, scope: "LEVEL", level: input.level, academicSession: term.academicSession, semester: term.semester, status: "ACTIVE" })
    : [];
  const problem = checkLevelAppointment({
    role: input.role, studentId: String(student._id), studentDepartmentId: String(student.department), departmentId: String(dept._id), studentStatus: student.status,
    level: input.level, departmentLevels: dept.levels, hasCurrentTerm: Boolean(term), activeOnLevel: active.map((a) => ({ studentId: String(a.student), role: a.role })),
  });
  if (problem || !term) throw new AppError(422, problem ?? "Set the department's current term before appointing representatives.", undefined, "ASSIGNMENT_RULE");

  try {
    const created = await CourseRepresentativeAssignment.create({
      student: student._id, department: dept._id, scope: "LEVEL", level: input.level,
      academicSession: term.academicSession, semester: term.semester, role: input.role, status: "ACTIVE",
      assignedBy: { name: assigner.name, role: assigner.role, id: assigner.id }, assignedAt: new Date(),
    });
    await RepresentativeAuditLog.create({
      action: "ASSIGNMENT_CREATED", actorName: assigner.name, role: input.role, resourceType: "ASSIGNMENT", resourceId: String(created._id),
      department: dept._id, detail: { studentId: String(student._id), level: input.level, assignedByRole: assigner.role }, at: new Date(),
    });
    return created;
  } catch (e) {
    // The partial unique indexes are the final guard against two Course Reps / duplicate roles under a race.
    if ((e as { code?: number }).code === 11000) throw new AppError(409, `That representative role is already taken for ${input.level} Level.`, undefined, "ASSIGNMENT_DUPLICATE");
    throw e;
  }
}

/** Ends a representative's authority. Takes effect on their very next request (authority is read from the database each time). */
export async function revokeAssignment(assigner: Assigner, assignmentId: string, reason?: string) {
  const a = await CourseRepresentativeAssignment.findById(assignmentId);
  // A HOD from another department gets the same answer as for a missing id.
  if (!a || String(a.department) !== assigner.departmentId) throw new AppError(404, "Assignment not found.");
  const verdict = authorizeAssigner(assigner, String(a.department));
  if (!verdict.ok) throw new AppError(403, verdict.reason, undefined, "ASSIGNER_NOT_AUTHORIZED");

  const updated = await CourseRepresentativeAssignment.findOneAndUpdate(
    { _id: a._id, status: { $ne: "REVOKED" } },
    { $set: { status: "REVOKED", revokedAt: new Date(), revokedBy: { name: assigner.name, role: assigner.role, id: assigner.id }, revokeReason: reason } },
    { new: true },
  );
  if (!updated) throw new AppError(409, "This assignment was already revoked.");
  await RepresentativeAuditLog.create({
    action: "ASSIGNMENT_REVOKED", actorName: assigner.name, role: a.role, resourceType: "ASSIGNMENT", resourceId: String(a._id),
    department: a.department, detail: { studentId: String(a.student), level: a.level, reason }, at: new Date(),
  });
  return updated;
}

/** Temporarily suspend / reinstate (e.g. rep on leave) without losing the record. */
export async function setAssignmentStatus(assigner: Assigner, assignmentId: string, status: "ACTIVE" | "INACTIVE") {
  const a = await CourseRepresentativeAssignment.findById(assignmentId);
  if (!a || String(a.department) !== assigner.departmentId) throw new AppError(404, "Assignment not found.");
  const verdict = authorizeAssigner(assigner, String(a.department));
  if (!verdict.ok) throw new AppError(403, verdict.reason, undefined, "ASSIGNER_NOT_AUTHORIZED");
  if (a.status === "REVOKED") throw new AppError(409, "A revoked assignment can't be reinstated; create a new one.");
  a.status = status;
  await a.save();
  await RepresentativeAuditLog.create({
    action: "ASSIGNMENT_STATUS_CHANGED", actorName: assigner.name, role: a.role, resourceType: "ASSIGNMENT", resourceId: String(a._id),
    department: a.department, detail: { level: a.level, status }, at: new Date(),
  });
  return a;
}
