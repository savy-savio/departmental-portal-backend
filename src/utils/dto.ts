import type { DepartmentDocument } from "../models/Department";
import type { StudentDocument } from "../models/Student";

/** The only shape in which a student leaves the API. Never includes hashes or tokens. */
export function toStudentDTO(student: StudentDocument, department: DepartmentDocument) {
  return {
    id: String(student._id),
    firstName: student.firstName,
    lastName: student.lastName,
    name: `${student.firstName} ${student.lastName}`,
    email: student.email ?? null,
    phone: student.phone ?? null,
    sex: student.sex ?? null,
    matricNumber: student.matricNumber,
    level: student.level,
    academicSession: student.academicSession,
    profilePhoto: student.profilePhoto ?? null,
    role: student.role,
    status: student.status,
    onboardingCompleted: student.onboardingCompleted,
    department: {
      id: String(department._id),
      name: department.name,
      code: department.code,
      faculty: department.faculty,
    },
  };
}
