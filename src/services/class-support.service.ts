import { randomUUID } from "node:crypto";
import { CourseEnrollment } from "../models/CourseEnrollment";
import { AppError } from "../utils/AppError";
import { safeDisplayName, sniffResourceFile } from "../utils/file";
import { logger } from "../utils/logger";
import { notify } from "./notification.service";
import { Student } from "../models/Student";
import { deleteImage, deletePublicFile, uploadImage, uploadPublicFile } from "./storage.service";

export interface ClassFile { url: string; publicId?: string; resourceType?: "image" | "raw"; originalName: string; mimeType: string; sizeBytes: number }

/** Validates the file's REAL type (from its bytes) and stores it publicly for the class. Used for class resources and official materials alike. */
export async function storeClassFile({ buffer, originalName }: { buffer: Buffer; originalName: string }, folder: string): Promise<ClassFile> {
  const kind = sniffResourceFile(buffer, originalName);
  if (!kind) throw new AppError(415, "Allowed files: PDF, DOCX, PPTX, XLSX, JPEG, PNG or WebP.", undefined, "UNSUPPORTED_FILE_TYPE");
  const base = randomUUID();
  const stored = await uploadPublicFile(buffer, { folder, publicId: kind.resourceType === "raw" ? `${base}.${kind.ext}` : base, resourceType: kind.resourceType });
  return { url: stored.url, publicId: stored.publicId, resourceType: stored.resourceType, originalName: safeDisplayName(originalName), mimeType: kind.mimeType, sizeBytes: buffer.length };
}
export async function removeClassFile(f: ClassFile): Promise<void> {
  if (!f.publicId) return;
  const resourceType = f.resourceType ?? (/\.[a-z0-9]+$/i.test(f.publicId) ? "raw" : "image"); // raw uploads keep their extension in the public id
  await deletePublicFile(f.publicId, resourceType).catch((e) => logger.warn("Could not delete class file:", e));
}

/** Notifies the students enrolled in a course (department / term scoped by the course itself). */
export async function notifyEnrolledStudents(
  course: { departmentId: string; courseCode: string; academicSession: string; semester: "FIRST" | "SECOND" },
  n: { kind: "ANNOUNCEMENT" | "MATERIAL" | "TIMETABLE" | "ASSIGNMENT"; title: string; body: string; link?: string },
  excludeStudentId?: string,
): Promise<void> {
  const rows = await CourseEnrollment.find({ department: course.departmentId, courseCode: course.courseCode, academicSession: course.academicSession, semester: course.semester, status: "ENROLLED" }).select("student");
  const recipients = [...new Set(rows.map((r) => String(r.student)))].filter((s) => s !== excludeStudentId);
  await notify(recipients.map((r) => ({ recipient: r as never, department: course.departmentId as never, kind: n.kind, title: n.title, body: n.body, link: n.link })));
}

/** Notifies every ACTIVE student of a level in a session (a class-wide announcement). The author is excluded. */
export async function notifyLevelStudents(
  level: { departmentId: string; level: string; academicSession: string },
  n: { kind: "ANNOUNCEMENT"; title: string; body: string; link?: string },
  excludeStudentId?: string,
): Promise<void> {
  const rows = await Student.find({ department: level.departmentId, level: level.level, academicSession: level.academicSession, status: "ACTIVE" }).select("_id");
  const recipients = rows.map((r) => String(r._id)).filter((s) => s !== excludeStudentId);
  await notify(recipients.map((r) => ({ recipient: r as never, department: level.departmentId as never, kind: n.kind, title: n.title, body: n.body, link: n.link })));
}

/**
 * Stores an announcement picture (the caller has already checked the bytes are a real JPEG / PNG / WebP). Aspect ratio is kept.
 * Shared by the HOD, lecturer and course-rep announcement flows.
 */
export async function storeAnnouncementImage(buffer: Buffer): Promise<{ url: string; publicId: string }> {
  const saved = await uploadImage(buffer, { folder: "portal/announcements", publicId: randomUUID() });
  return { url: saved.url, publicId: saved.publicId };
}
export const removeAnnouncementImage = (publicId: string) => deleteImage(publicId);
