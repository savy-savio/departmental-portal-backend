import { Schema, Types, model } from "mongoose";

/** Pending emailed one-time code for registering / replacing an attendance device. The code itself is never stored (HMAC only). */
export interface IDeviceVerification {
  student: Types.ObjectId;
  codeHash: string;
  purpose: "REGISTER" | "REPLACE";
  expiresAt: Date;
  attempts: number;
  usedAt?: Date;
  requestedIp?: string;
}
const verificationSchema = new Schema<IDeviceVerification>(
  {
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true },
    codeHash: { type: String, required: true },
    purpose: { type: String, enum: ["REGISTER", "REPLACE"], required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    usedAt: Date,
    requestedIp: { type: String, maxlength: 64 },
  },
  { timestamps: true },
);
verificationSchema.index({ student: 1 });
verificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
export const DeviceVerification = model<IDeviceVerification>("DeviceVerification", verificationSchema);
