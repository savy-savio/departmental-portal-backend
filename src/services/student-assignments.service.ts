import { randomUUID } from "node:crypto";
import { Assignment, AssignmentDocument } from "../models/Assignment";
import { AssignmentSubmission, AssignmentSubmissionDocument } from "../models/AssignmentSubmission";
import type { DepartmentDocument } from "../models/Department";
import type { StudentDocument } from "../models/Student";
import { AppError } from "../utils/AppError";
import { safeDisplayName, sniffSubmissionFile } from "../utils/file";
import { logger } from "../utils/logger";
import type { AssignmentsQuery, SubmissionBody } from "../validators/student-academic.validators";
import { deletePrivateFile, signedPrivateUrl, uploadPrivateFile } from "./storage.service";
import { notifyCourseLecturers } from "./lecturer/notify";
import { loadStudentContext } from "./student-context.service";

type AssignmentState = "PENDING" | "OVERDUE" | "SUBMITTED" | "GRADED";

function submissionDTO(s: AssignmentSubmissionDocument, maxScore: number) {
  const graded = s.status === "GRADED";
  return {
    id: String(s._id),
    content: s.content ?? null,
    file: s.file
      ? {
          name: s.file.originalName,
          mimeType: s.file.mimeType,
          sizeBytes: s.file.sizeBytes,
          // Signed, private link. Only ever returned to the student who owns this submission.
          url: signedPrivateUrl({ publicId: s.file.publicId, resourceType: s.file.resourceType }),
        }
      : null,
    submittedAt: s.submittedAt,
    isLate: s.isLate,
    status: s.status,
    score: graded ? s.score ?? null : null, // grades stay hidden until marked
    maxScore,
    feedback: graded ? s.feedback ?? null : null,
  };
}

function assignmentDTO(a: AssignmentDocument, sub: AssignmentSubmissionDocument | undefined, now = new Date()) {
  const past = now > a.dueAt;
  const state: AssignmentState = sub ? (sub.status === "GRADED" ? "GRADED" : "SUBMITTED") : past ? "OVERDUE" : "PENDING";
  const canSubmit = a.status === "PUBLISHED" && sub?.status !== "GRADED" && (!past || a.allowLateSubmission);
  return {
    id: String(a._id),
    courseCode: a.courseCode,
    title: a.title,
    instructions: a.instructions,
    attachment: a.attachment?.url ? { url: a.attachment.url, name: a.attachment.originalName } : null,
    dueAt: a.dueAt,
    maxScore: a.maxScore,
    allowLateSubmission: a.allowLateSubmission,
    status: a.status,
    createdBy: { name: a.createdByName, role: a.createdByRole },
    state,
    canSubmit,
    submission: sub ? submissionDTO(sub, a.maxScore) : null,
  };
}

/** Assignments the student may see: own department, a course they're registered in this term, not a draft. */
async function scope(student: StudentDocument, department: DepartmentDocument) {
  const { term, enrolledCodes } = await loadStudentContext(student, department);
  if (!term) return null;
  return {
    department: department._id,
    courseCode: { $in: enrolledCodes },
    academicSession: term.academicSession,
    semester: term.semester,
    status: { $in: ["PUBLISHED", "CLOSED"] },
  };
}

export async function listAssignments(student: StudentDocument, department: DepartmentDocument, q: AssignmentsQuery) {
  const filter = await scope(student, department);
  if (!filter) return [];
  const rows = await Assignment.find(filter).sort({ dueAt: 1 });
  // Submissions are always looked up by the authenticated student's id.
  const subs = await AssignmentSubmission.find({ student: student._id, assignment: { $in: rows.map((r) => r._id) } });
  const byAssignment = new Map(subs.map((s) => [String(s.assignment), s]));

  const items = rows.map((a) => assignmentDTO(a, byAssignment.get(String(a._id))));
  if (q.status === "pending") return items.filter((i) => i.state === "PENDING" || i.state === "OVERDUE");
  if (q.status === "submitted") return items.filter((i) => i.state === "SUBMITTED" || i.state === "GRADED");
  return items;
}

async function loadVisible(student: StudentDocument, department: DepartmentDocument, id: string) {
  const filter = await scope(student, department);
  const assignment = filter ? await Assignment.findOne({ ...filter, _id: id }) : null;
  if (!assignment) throw new AppError(404, "Assignment not found.");
  return assignment;
}

export async function getAssignment(student: StudentDocument, department: DepartmentDocument, id: string) {
  const assignment = await loadVisible(student, department, id);
  const sub = await AssignmentSubmission.findOne({ assignment: assignment._id, student: student._id });
  return assignmentDTO(assignment, sub ?? undefined);
}

export async function submitAssignment(
  student: StudentDocument,
  department: DepartmentDocument,
  id: string,
  body: SubmissionBody,
  file: { buffer: Buffer; originalname: string } | undefined,
) {
  const assignment = await loadVisible(student, department, id);
  const now = new Date();

  if (assignment.status !== "PUBLISHED") throw new AppError(403, "This assignment is closed for submissions.");
  if (now > assignment.dueAt && !assignment.allowLateSubmission) {
    throw new AppError(403, "The deadline has passed and late submissions are not accepted.");
  }
  if (!body.content && !file) throw new AppError(422, "Provide an answer in text, attach a file, or both.");

  const existing = await AssignmentSubmission.findOne({ assignment: assignment._id, student: student._id });
  if (existing?.status === "GRADED") throw new AppError(409, "This submission has already been graded and can't be changed.");

  let newFile: NonNullable<AssignmentSubmissionDocument["file"]> | undefined;
  if (file) {
    const kind = sniffSubmissionFile(file.buffer, file.originalname);
    if (!kind) throw new AppError(415, "Only PDF, DOCX, JPEG, PNG or WebP files are allowed.");
    const base = `${String(student._id)}-${randomUUID()}`;
    const stored = await uploadPrivateFile(file.buffer, {
      folder: `portal/submissions/${String(assignment._id)}`,
      publicId: kind.resourceType === "raw" ? `${base}.${kind.ext}` : base,
      resourceType: kind.resourceType,
    });
    newFile = {
      publicId: stored.publicId,
      resourceType: stored.resourceType,
      originalName: safeDisplayName(file.originalname),
      mimeType: kind.mimeType,
      sizeBytes: file.buffer.length,
    };
  }

  const oldFile = existing?.file?.publicId
    ? {
        publicId: existing.file.publicId,
        resourceType: existing.file.resourceType,
        originalName: existing.file.originalName,
        mimeType: existing.file.mimeType,
        sizeBytes: existing.file.sizeBytes,
      }
    : undefined;
  let saved: AssignmentSubmissionDocument;
  try {
    saved = await AssignmentSubmission.findOneAndUpdate(
      { assignment: assignment._id, student: student._id, status: { $ne: "GRADED" } },
      {
        $set: {
          department: department._id,
          content: body.content ?? (newFile ? existing?.content : undefined),
          file: newFile ?? oldFile,
          submittedAt: now,
          isLate: now > assignment.dueAt,
          status: "SUBMITTED",
        },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    if (newFile) await deletePrivateFile(newFile).catch(() => undefined);
    // A concurrent grade/duplicate shows up as a duplicate-key on the unique (assignment, student) index.
    if ((err as { code?: number }).code === 11000) throw new AppError(409, "This submission can't be changed.");
    throw err;
  }

  if (newFile && oldFile) await deletePrivateFile(oldFile).catch((e) => logger.warn("Could not delete replaced file:", e));
  // Tell the course's lecturers (best-effort: never fails the student's submission).
  try {
    await notifyCourseLecturers(
      { departmentId: String(department._id), courseCode: assignment.courseCode, academicSession: assignment.academicSession, semester: assignment.semester },
      { kind: "ASSIGNMENT", title: `${assignment.courseCode}: new submission`, body: `${student.firstName} ${student.lastName} submitted "${assignment.title}"`, link: "/lecturer/assignments" },
    );
  } catch (e) {
    logger.warn("Could not notify lecturers:", e);
  }
  return assignmentDTO(assignment, saved, now);
}
