import type { FilterQuery } from "mongoose";
import { Announcement, AnnouncementDocument, IAnnouncement } from "../models/Announcement";
import type { DepartmentDocument } from "../models/Department";
import type { StudentDocument } from "../models/Student";
import { AppError } from "../utils/AppError";
import type { AnnouncementsQuery } from "../validators/student-academic.validators";
import { loadStudentContext, pageMeta } from "./student-context.service";

function dto(a: AnnouncementDocument) {
  return {
    id: String(a._id),
    title: a.title,
    body: a.body,
    priority: a.priority,
    scope: a.audience.scope,
    image: a.image?.url ? { url: a.image.url } : null, // the storage id (publicId) is never selected or returned
    author: { name: a.createdByName, role: a.createdByRole },
    publishedAt: a.publishedAt,
    expiresAt: a.expiresAt ?? null,
  };
}

/** Everything a student may see: own department, published, not expired, and addressed to them. */
async function visibleFilter(student: StudentDocument, department: DepartmentDocument): Promise<FilterQuery<IAnnouncement>> {
  const { enrolledCodes, term } = await loadStudentContext(student, department);
  const now = new Date();

  const audience: FilterQuery<IAnnouncement>[] = [
    { "audience.scope": "DEPARTMENT" },
    { "audience.scope": "LEVEL", "audience.levels": student.level },
    { "audience.scope": "CLASS", "audience.levels": student.level, "audience.academicSession": student.academicSession },
    { "audience.scope": "GROUP", "audience.studentIds": student._id },
  ];
  if (enrolledCodes.length && term) {
    audience.push({
      "audience.scope": "COURSE",
      "audience.courseCodes": { $in: enrolledCodes },
      // Representative-written announcements carry their term; show them only while that term is current.
      $or: [{ academicSession: { $exists: false } }, { academicSession: term.academicSession, semester: term.semester }],
    });
  }

  return {
    department: department._id, // derived from the JWT, never from the request
    status: "PUBLISHED",
    publishedAt: { $lte: now },
    $and: [{ $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }] }, { $or: audience }],
  };
}

export async function listAnnouncements(student: StudentDocument, department: DepartmentDocument, q: AnnouncementsQuery) {
  const filter = await visibleFilter(student, department);
  const [rows, total] = await Promise.all([
    Announcement.find(filter).sort({ publishedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
    Announcement.countDocuments(filter),
  ]);
  return { items: rows.map(dto), ...pageMeta(q.page, q.limit, total) };
}

export async function getAnnouncement(student: StudentDocument, department: DepartmentDocument, id: string) {
  const filter = await visibleFilter(student, department);
  // Same visibility rules as the list: an announcement not meant for this student is simply "not found".
  const row = await Announcement.findOne({ ...filter, _id: id });
  if (!row) throw new AppError(404, "Announcement not found.");
  return dto(row);
}
