import { randomUUID } from "node:crypto";
import { HydratedDocument, Schema, Types, model } from "mongoose";

/**
 * BALLOT SECRECY: who voted and what was voted are kept in two collections that share no field.
 *
 *  VoteParticipation  "student S has voted for position P"  (enforces one vote per position; no candidate)
 *  Vote               "a vote for candidate C in position P" (anonymous: no student, no timestamps,
 *                      random UUID _id instead of a time-ordered ObjectId)
 */
export interface IVoteParticipation {
  election: Types.ObjectId;
  position: Types.ObjectId;
  student: Types.ObjectId;
  department: Types.ObjectId;
}
const participationSchema = new Schema<IVoteParticipation>(
  {
    election: { type: Schema.Types.ObjectId, ref: "Election", required: true, index: true },
    position: { type: Schema.Types.ObjectId, ref: "ElectionPosition", required: true },
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true },
  },
  { timestamps: true },
);
// The one-vote-per-position guarantee lives in the database, not in application code.
participationSchema.index({ position: 1, student: 1 }, { unique: true });
participationSchema.index({ election: 1, student: 1 });

export type VoteParticipationDocument = HydratedDocument<IVoteParticipation>;
export const VoteParticipation = model<IVoteParticipation>("VoteParticipation", participationSchema);

export interface IVote {
  _id: string;
  election: Types.ObjectId;
  position: Types.ObjectId;
  candidate: Types.ObjectId;
}
const voteSchema = new Schema<IVote>(
  {
    _id: { type: String, default: () => randomUUID() },
    election: { type: Schema.Types.ObjectId, ref: "Election", required: true, index: true },
    position: { type: Schema.Types.ObjectId, ref: "ElectionPosition", required: true },
    candidate: { type: Schema.Types.ObjectId, ref: "ElectionCandidate", required: true },
  },
  { timestamps: false, versionKey: false },
);
voteSchema.index({ position: 1, candidate: 1 });

export const Vote = model<IVote>("Vote", voteSchema);
