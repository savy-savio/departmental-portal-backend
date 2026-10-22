import { randomUUID } from "node:crypto";
import { Complaint, ComplaintDocument, IComplaintAttachment } from "../models/Complaint";
import { nextSequence } from "../models/Counter";
import { Course } from "../models/Course";
import type { DepartmentDocument } from "../models/Department";
import type { StudentDocument } from "../models/Student";
import { AppError } from "../utils/AppError";
import {
  COMPLAINT_ALLOWED_EXTENSIONS, COMPLAINT_EDITABLE_STATUSES, COMPLAINT_MAX_FILES, COMPLAINT_MAX_FILE_MB,
} from "../utils/constants";
import { safeDisplayName, sniffSubmissionFile } from "../utils/file";
import { logger } from "../utils/logger";
import type { CreateComplaintInput, UpdateComplaintInput } from "../validators/student-complaints.validators";
import { notifyDepartmentHod } from "./hod/notify";
import { notify } from "./notification.service";
import { deletePrivateFile, signedPrivateUrl, uploadPrivateFile } from "./storage.service";
import { loadStudentContext } from "./student-context.service";

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "Complaint submitted",
  PENDING: "Pending",
  UNDER_REVIEW: "Under review",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In progress",
  RESOLVED: "Resolved",
  REJECTED: "Rejected",
  CLOSED: "Closed",
};

const isEditable = (c: ComplaintDocument): boolean => COMPLAINT_EDITABLE_STATUSES.includes(c.status);

function attachmentDTO(a: IComplaintAttachment) {
  return {
    id: String(a._id),
    name: a.originalName,
    mimeType: a.mimeType,
    size: a.sizeBytes,
    url: signedPrivateUrl({ publicId: a.publicId, resourceType: a.resourceType }), // private, owner-only
  };
}

function dto(c: ComplaintDocument, department: DepartmentDocument) {
  return {
    id: String(c._id),
    referenceNumber: c.referenceNumber,
    type: c.type,
    title: c.title,
    message: c.message,
    course: c.course ? { id: String(c.course), code: c.courseCode, title: c.courseTitle } : null,
    recipient: { role: c.recipient.role, department: { id: String(department._id), name: department.name, code: department.code } },
    status: c.status,
    resolution: c.resolution ?? null,
    resolvedAt: c.resolvedAt ?? null,
    editable: isEditable(c), // decided here; the UI only reflects it
    attachments: c.attachments.map(attachmentDTO),
    timeline: c.timeline.filter((e) => !e.internal).map((e) => ({ id: String(e._id), status: e.status, label: e.label, note: e.note ?? null, at: e.at })),
    createdAt: (c as unknown as { createdAt: Date }).createdAt,
    updatedAt: (c as unknown as { updatedAt: Date }).updatedAt,
  };
}

/** Every query is pinned to the authenticated student's own id; someone else's complaint is "not found". */
async function loadOwn(student: StudentDocument, id: string): Promise<ComplaintDocument> {
  const c = await Complaint.findOne({ _id: id, student: student._id });
  if (!c) throw new AppError(404, "Complaint not found.");
  return c;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function listComplaints(student: StudentDocument, department: DepartmentDocument, q: { search?: string; status?: string }) {
  const filter: Record<string, unknown> = { student: student._id };
  if (q.status) filter.status = q.status;
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), "i");
    filter.$or = [{ title: rx }, { referenceNumber: rx }, { courseCode: rx }];
  }
  const rows = await Complaint.find(filter).sort({ createdAt: -1 }).limit(200);
  return rows.map((c) => dto(c, department));
}

export async function getComplaint(student: StudentDocument, department: DepartmentDocument, id: string) {
  return dto(await loadOwn(student, id), department);
}

export async function complaintStats(student: StudentDocument) {
  const rows = await Complaint.aggregate<{ _id: string; n: number }>([
    { $match: { student: student._id } },
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]);
  const count = (...s: string[]) => rows.filter((r) => s.includes(r._id)).reduce((a, r) => a + r.n, 0);
  return {
    total: rows.reduce((a, r) => a + r.n, 0),
    pending: count("SUBMITTED", "PENDING"),
    inReview: count("UNDER_REVIEW", "ASSIGNED", "IN_PROGRESS"),
    resolved: count("RESOLVED", "CLOSED"),
  };
}

export const uploadConstraints = () => ({
  maxFiles: COMPLAINT_MAX_FILES,
  maxFileSizeMB: COMPLAINT_MAX_FILE_MB,
  allowedExtensions: [...COMPLAINT_ALLOWED_EXTENSIONS],
});

export async function createComplaint(student: StudentDocument, department: DepartmentDocument, input: CreateComplaintInput) {
  let courseFields: { course: unknown; courseCode: string; courseTitle: string } | undefined;

  if (input.type === "COURSE") {
    // Course must be in the student's own department AND one they're registered in this term (carryovers included).
    const course = await Course.findOne({ _id: input.courseId, department: department._id });
    if (!course) throw new AppError(404, "Course not found.");
    const { enrolledCodes } = await loadStudentContext(student, department);
    if (!enrolledCodes.includes(course.courseCode)) {
      throw new AppError(403, "You can only complain about a course you are registered for this semester.");
    }
    courseFields = { course: course._id, courseCode: course.courseCode, courseTitle: course.title };
  }

  const year = new Date().getFullYear();
  const seq = await nextSequence(`complaint:${department.code}:${year}`);
  const referenceNumber = `CMP-${department.code}-${year}-${String(seq).padStart(5, "0")}`;

  const complaint = await Complaint.create({
    department: department._id, // from the JWT, never the request
    student: student._id,
    referenceNumber,
    type: input.type,
    title: input.title,
    message: input.message,
    ...(courseFields ?? {}),
    // Every complaint is reviewed by the department HOD first (who may then forward a course complaint to the right lecturer).
    recipient: { role: "HOD" },
    status: "SUBMITTED",
    timeline: [{ status: "SUBMITTED", label: STATUS_LABEL.SUBMITTED, at: new Date() }],
  });

  await notify({
    recipient: student._id,
    department: department._id,
    kind: "SUBMITTED",
    title: "Complaint submitted",
    body: `Your complaint ${referenceNumber} has been received.`,
    complaintId: complaint._id,
  });
  // Tell the department head (best-effort: never fails the student's submission).
  try {
    await notifyDepartmentHod(String(department._id), {
      kind: "SUBMITTED", title: "New complaint", body: `${student.firstName} ${student.lastName}: ${input.title}`, link: "/hod/complaints", complaintId: complaint._id,
    });
  } catch (e) {
    logger.warn("Could not notify the HOD:", e);
  }
  return dto(complaint, department);
}

export async function updateComplaint(student: StudentDocument, department: DepartmentDocument, id: string, input: UpdateComplaintInput) {
  const complaint = await loadOwn(student, id);
  if (!isEditable(complaint)) throw new AppError(409, "This complaint is already being handled and can no longer be edited.");

  const removing = complaint.attachments.filter((a) => input.removeAttachmentIds.includes(String(a._id)));
  complaint.title = input.title;
  complaint.message = input.message;
  for (const a of removing) complaint.attachments.pull(a._id);
  await complaint.save();

  for (const a of removing) {
    await deletePrivateFile({ publicId: a.publicId, resourceType: a.resourceType }).catch((e) => logger.warn("Could not delete attachment:", e));
  }
  return dto(complaint, department);
}

export async function addAttachment(
  student: StudentDocument,
  id: string,
  file: { buffer: Buffer; originalname: string } | undefined,
) {
  if (!file) throw new AppError(400, 'Attach a file in the "file" field.');
  const complaint = await loadOwn(student, id);
  if (!isEditable(complaint)) throw new AppError(409, "This complaint can no longer be edited.");
  if (complaint.attachments.length >= COMPLAINT_MAX_FILES) {
    throw new AppError(409, `You can attach at most ${COMPLAINT_MAX_FILES} files.`);
  }
  const kind = sniffSubmissionFile(file.buffer, file.originalname);
  if (!kind) throw new AppError(415, `Allowed file types: ${COMPLAINT_ALLOWED_EXTENSIONS.join(", ")}.`);

  const base = `${String(complaint._id)}-${randomUUID()}`;
  const stored = await uploadPrivateFile(file.buffer, {
    folder: "portal/complaint-attachments",
    publicId: kind.resourceType === "raw" ? `${base}.${kind.ext}` : base,
    resourceType: kind.resourceType,
  });

  // Atomic cap: the $expr guard stops two simultaneous uploads from exceeding the limit.
  const updated = await Complaint.findOneAndUpdate(
    {
      _id: complaint._id, student: student._id, status: { $in: COMPLAINT_EDITABLE_STATUSES },
      $expr: { $lt: [{ $size: "$attachments" }, COMPLAINT_MAX_FILES] },
    },
    {
      $push: {
        attachments: {
          publicId: stored.publicId, resourceType: stored.resourceType, originalName: safeDisplayName(file.originalname),
          mimeType: kind.mimeType, sizeBytes: file.buffer.length,
        },
      },
    },
    { new: true },
  );
  if (!updated) {
    await deletePrivateFile(stored).catch(() => undefined);
    throw new AppError(409, "This complaint can't take another attachment.");
  }
  return attachmentDTO(updated.attachments[updated.attachments.length - 1]);
}
