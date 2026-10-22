import { HydratedDocument, Schema, Types, model } from "mongoose";

/**
 * A phone/laptop a student has verified for ATTENDANCE only. Normal portal login is unaffected by it.
 * The raw device token is shown to the client once and never stored; only its SHA-256 hash is.
 */
export interface IStudentAttendanceDevice {
  student: Types.ObjectId;
  department: Types.ObjectId;
  tokenHash: string;
  label?: string;
  userAgent?: string;
  status: "ACTIVE" | "REVOKED";
  registeredAt: Date;
  lastUsedAt?: Date;
  lastIp?: string;
  revokedAt?: Date;
  revokedReason?: "REPLACED" | "ADMIN_RESET";
}

const deviceSchema = new Schema<IStudentAttendanceDevice>(
  {
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true, immutable: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true },
    tokenHash: { type: String, required: true, immutable: true },
    label: { type: String, trim: true, maxlength: 60 },
    userAgent: { type: String, maxlength: 300 },
    status: { type: String, enum: ["ACTIVE", "REVOKED"], default: "ACTIVE" },
    registeredAt: { type: Date, required: true },
    lastUsedAt: Date,
    lastIp: { type: String, maxlength: 64 },
    revokedAt: Date,
    revokedReason: { type: String, enum: ["REPLACED", "ADMIN_RESET"] },
  },
  { timestamps: true },
);
// A token hash identifies exactly one device, ever.
deviceSchema.index({ tokenHash: 1 }, { unique: true });
// At most ONE active attendance device per student (revoked history is kept and unlimited).
deviceSchema.index({ student: 1 }, { unique: true, partialFilterExpression: { status: "ACTIVE" } });
deviceSchema.index({ student: 1, revokedReason: 1, revokedAt: -1 });

export type StudentAttendanceDeviceDocument = HydratedDocument<IStudentAttendanceDevice>;
export const StudentAttendanceDevice = model<IStudentAttendanceDevice>("StudentAttendanceDevice", deviceSchema);
