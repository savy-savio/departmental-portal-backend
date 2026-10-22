import { HydratedDocument, Schema, Types, model } from "mongoose";
import {
  ACADEMIC_SESSION_REGEX, ASSIGNMENT_STATUSES, LEVEL_REGEX, SEMESTERS, Semester,
} from "../utils/constants";
import { COURSE_CODE_REGEX, normalizeCourseCode } from "../utils/course";

export interface IAssignment {
  department: Types.ObjectId;
  courseCode: string;
  title: string;
  instructions: string;
  level: string;
  academicSession: string;
  semester: Semester;
  dueAt: Date;
  maxScore: number;
  allowLateSubmission: boolean;
  status: "DRAFT" | "PUBLISHED" | "CLOSED";
  createdByName: string;
  createdByRole: string;
  course?: Types.ObjectId;
  /** The lecturer who set it (the only one who can change it). */
  lecturer?: Types.ObjectId;
  /** Optional brief / handout for students (a public file or link). */
  attachment?: { url: string; publicId?: string; originalName: string; mimeType: string; sizeBytes: number };
}

const assignmentSchema = new Schema<IAssignment>(
  {
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true },
    courseCode: { type: String, required: true, set: normalizeCourseCode, match: COURSE_CODE_REGEX },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    instructions: { type: String, required: true, trim: true, maxlength: 10_000 },
    level: { type: String, required: true, match: LEVEL_REGEX },
    academicSession: { type: String, required: true, match: ACADEMIC_SESSION_REGEX },
    semester: { type: String, enum: SEMESTERS, required: true },
    dueAt: { type: Date, required: true },
    maxScore: { type: Number, default: 100, min: 1 },
    allowLateSubmission: { type: Boolean, default: false },
    status: { type: String, enum: ASSIGNMENT_STATUSES, default: "PUBLISHED" },
    createdByName: { type: String, required: true, trim: true },
    createdByRole: { type: String, required: true, trim: true },
    course: { type: Schema.Types.ObjectId, ref: "Course" },
    lecturer: { type: Schema.Types.ObjectId, ref: "Lecturer" },
    attachment: { url: String, publicId: String, originalName: String, mimeType: String, sizeBytes: Number },
  },
  { timestamps: true },
);
assignmentSchema.index({ department: 1, courseCode: 1, academicSession: 1, semester: 1, status: 1 });

export type AssignmentDocument = HydratedDocument<IAssignment>;
export const Assignment = model<IAssignment>("Assignment", assignmentSchema);
