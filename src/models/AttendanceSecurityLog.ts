import { Schema, Types, model } from "mongoose";

/**
 * Append-only audit trail of every attendance / device security event, successful or not.
 * Written for administrators (HOD phase) to investigate suspicious activity. Students never read it.
 * IP is stored for investigation and rate limiting; it is never used to identify a student.
 */
export interface IAttendanceSecurityLog {
  action: string;
  outcome: "SUCCESS" | "REJECTED";
  reason?: string;
  student: Types.ObjectId;
  department: Types.ObjectId;
  session?: Types.ObjectId;
  courseCode?: string;
  device?: Types.ObjectId;
  deviceFingerprint?: string;
  ip: string;
  userAgent?: string;
  location?: { latitude?: number; longitude?: number; accuracyMeters?: number; distanceMeters?: number; withinRadius?: boolean };
  flagged: boolean;
  flags: string[];
  at: Date;
}
const logSchema = new Schema<IAttendanceSecurityLog>(
  {
    action: { type: String, required: true },
    outcome: { type: String, enum: ["SUCCESS", "REJECTED"], required: true },
    reason: String,
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true },
    session: { type: Schema.Types.ObjectId, ref: "AttendanceSession" },
    courseCode: String,
    device: { type: Schema.Types.ObjectId, ref: "StudentAttendanceDevice" },
    deviceFingerprint: String,
    ip: { type: String, required: true, maxlength: 64 },
    userAgent: { type: String, maxlength: 300 },
    location: { latitude: Number, longitude: Number, accuracyMeters: Number, distanceMeters: Number, withinRadius: Boolean },
    flagged: { type: Boolean, default: false },
    flags: { type: [String], default: [] },
    at: { type: Date, required: true },
  },
  { timestamps: false, versionKey: false },
);
logSchema.index({ student: 1, at: -1 });
logSchema.index({ department: 1, flagged: 1, at: -1 }); // "show me suspicious activity in my department"
logSchema.index({ session: 1, at: -1 });
logSchema.index({ deviceFingerprint: 1, at: -1 });
logSchema.index({ ip: 1, at: -1 });
logSchema.index({ reason: 1, at: -1 });
export const AttendanceSecurityLog = model<IAttendanceSecurityLog>("AttendanceSecurityLog", logSchema);
