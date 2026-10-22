import type { FilterQuery } from "mongoose";
import type { DepartmentDocument } from "../models/Department";
import { IMaterial, Material, MaterialDocument } from "../models/Material";
import type { StudentDocument } from "../models/Student";
import type { MaterialsQuery } from "../validators/student-academic.validators";
import { loadStudentContext, pageMeta } from "./student-context.service";

function dto(m: MaterialDocument) {
  return {
    id: String(m._id),
    title: m.title,
    description: m.description ?? null,
    type: m.type,
    courseCode: m.courseCode ?? null,
    level: m.level,
    semester: m.semester,
    academicSession: m.academicSession,
    file: { url: m.file.url, name: m.file.originalName, mimeType: m.file.mimeType, sizeBytes: m.file.sizeBytes },
    uploadedBy: { name: m.uploadedByName, role: m.uploadedByRole },
    createdAt: (m as unknown as { createdAt: Date }).createdAt,
  };
}

/**
 * A material is visible when it belongs to the student's own department AND is for a course they're registered in
 * (or is a class-wide resource for their level + session), OR when another department explicitly shared it
 * with the student's department (and level, if the share names levels).
 */
export async function listMaterials(student: StudentDocument, department: DepartmentDocument, q: MaterialsQuery) {
  const { enrolledCodes } = await loadStudentContext(student, department);

  const visible: FilterQuery<IMaterial>[] = [
    { department: department._id, courseCode: { $in: enrolledCodes } },
    {
      department: department._id,
      type: "CLASS_RESOURCE",
      courseCode: { $exists: false },
      level: student.level,
      academicSession: student.academicSession,
    },
    {
      sharedWith: {
        $elemMatch: {
          department: department._id,
          $or: [{ levels: { $exists: false } }, { levels: { $size: 0 } }, { levels: student.level }],
        },
      },
    },
  ];

  const and: FilterQuery<IMaterial>[] = [{ status: "PUBLISHED" }, { $or: visible }];
  if (q.courseCode) and.push({ courseCode: q.courseCode });
  if (q.type) and.push({ type: q.type });
  if (q.semester) and.push({ semester: q.semester });
  if (q.academicSession) and.push({ academicSession: q.academicSession });
  const filter: FilterQuery<IMaterial> = { $and: and };

  const [rows, total] = await Promise.all([
    Material.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
    Material.countDocuments(filter),
  ]);
  return { items: rows.map(dto), ...pageMeta(q.page, q.limit, total) };
}
