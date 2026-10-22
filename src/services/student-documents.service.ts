import { DepartmentDocumentModel } from "../models/DepartmentDocument";
import type { DepartmentDocument as DepartmentDoc } from "../models/Department";
import type { StudentDocument } from "../models/Student";

/** Department documents published by the HOD for the student's own department (and level, if the document names levels). */
export async function listDepartmentDocuments(student: StudentDocument, department: DepartmentDoc) {
  const rows = await DepartmentDocumentModel.find({
    department: department._id, // from the JWT-derived department, never from the request
    status: "PUBLISHED",
    $or: [{ levels: { $size: 0 } }, { levels: student.level }],
  }).sort({ createdAt: -1 }).limit(100);
  return rows.map((d) => ({
    id: String(d._id), title: d.title, description: d.description ?? null, levels: d.levels ?? [],
    file: { url: d.file.url, name: d.file.originalName, mimeType: d.file.mimeType, sizeBytes: d.file.sizeBytes }, publishedBy: d.createdByName,
    createdAt: (d as unknown as { createdAt: Date }).createdAt,
  }));
}
