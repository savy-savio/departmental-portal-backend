import { HydratedDocument, Schema, Types, model } from "mongoose";
import { SUBMISSION_STATUSES } from "../utils/constants";

export interface IAssignmentSubmission {
  assignment: Types.ObjectId;
  student: Types.ObjectId;
  department: Types.ObjectId;
  content?: string;
  /** Stored privately (authenticated delivery); the URL is signed on request and only given to the owner. */
  file?: { publicId: string; resourceType: "image" | "raw"; originalName: string; mimeType: string; sizeBytes: number };
  submittedAt: Date;
  isLate: boolean;
  status: "SUBMITTED" | "GRADED";
  /** Set by lecturers in a later phase. */
  score?: number;
  feedback?: string;
}

const submissionSchema = new Schema<IAssignmentSubmission>(
  {
    assignment: { type: Schema.Types.ObjectId, ref: "Assignment", required: true, immutable: true },
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true, immutable: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true },
    content: { type: String, trim: true, maxlength: 10_000 },
    file: {
      publicId: String,
      resourceType: { type: String, enum: ["image", "raw"] },
      originalName: String,
      mimeType: String,
      sizeBytes: Number,
    },
    submittedAt: { type: Date, required: true },
    isLate: { type: Boolean, default: false },
    status: { type: String, enum: SUBMISSION_STATUSES, default: "SUBMITTED" },
    score: { type: Number, min: 0 },
    feedback: { type: String, trim: true, maxlength: 5000 },
  },
  { timestamps: true },
);
submissionSchema.index({ assignment: 1, student: 1 }, { unique: true });
submissionSchema.index({ student: 1, submittedAt: -1 });

export type AssignmentSubmissionDocument = HydratedDocument<IAssignmentSubmission>;
export const AssignmentSubmission = model<IAssignmentSubmission>("AssignmentSubmission", submissionSchema);
