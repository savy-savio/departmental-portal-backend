import { Schema, Types, model } from "mongoose";

/** Short-lived, single-use attendance token bound to student + device + session. Only its hash is stored. */
export interface IAttendanceChallenge {
  student: Types.ObjectId;
  device: Types.ObjectId;
  session: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date;
}
const challengeSchema = new Schema<IAttendanceChallenge>(
  {
    student: { type: Schema.Types.ObjectId, required: true },
    device: { type: Schema.Types.ObjectId, required: true },
    session: { type: Schema.Types.ObjectId, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
  },
  { timestamps: false },
);
challengeSchema.index({ tokenHash: 1 }, { unique: true });
// MongoDB deletes expired challenges automatically (the audit trail lives in AttendanceSecurityLog).
challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AttendanceChallenge = model<IAttendanceChallenge>("AttendanceChallenge", challengeSchema);
