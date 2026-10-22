import { HydratedDocument, Schema, Types, model } from "mongoose";
import { CANDIDATE_STATUSES } from "../utils/constants";

/** A student standing for one position. Only APPROVED candidates are visible / votable. */
export interface IElectionCandidate {
  election: Types.ObjectId;
  position: Types.ObjectId;
  department: Types.ObjectId;
  student: Types.ObjectId;
  manifesto?: string;
  /** Candidate campaign photo uploaded by the HOD (falls back to the student's profile photo when absent). */
  photo?: string;
  /** Cloudinary public_id of the photo, used to delete it. Never exposed. */
  photoPublicId?: string;
  /** Who approved / rejected the candidacy. */
  decidedByName?: string;
  decidedAt?: Date;
  status: "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";
}

const candidateSchema = new Schema<IElectionCandidate>(
  {
    election: { type: Schema.Types.ObjectId, ref: "Election", required: true, immutable: true },
    position: { type: Schema.Types.ObjectId, ref: "ElectionPosition", required: true, immutable: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true },
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true, immutable: true },
    manifesto: { type: String, trim: true, maxlength: 3000 },
    photo: { type: String, trim: true },
    photoPublicId: { type: String, select: false },
    decidedByName: { type: String, trim: true },
    decidedAt: { type: Date },
    status: { type: String, enum: CANDIDATE_STATUSES, default: "PENDING" },
  },
  { timestamps: true },
);
candidateSchema.index({ position: 1, student: 1 }, { unique: true });
candidateSchema.index({ election: 1, status: 1 });

export type ElectionCandidateDocument = HydratedDocument<IElectionCandidate>;
export const ElectionCandidate = model<IElectionCandidate>("ElectionCandidate", candidateSchema);
