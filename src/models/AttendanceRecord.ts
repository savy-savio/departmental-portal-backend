import { HydratedDocument, Schema, Types, model } from "mongoose";
import { ATTENDANCE_RECORD_STATUSES } from "../utils/constants";

export interface IAttendanceRecord {
  session: Types.ObjectId;
  student: Types.ObjectId;
  department: Types.ObjectId;
  courseCode: string;
  markedAt: Date;
  status: "PRESENT" | "LATE";
  /** Which attendance device was used (absent on records created before device binding). */
  device?: Types.ObjectId;
  /** Audit signal only; never an identity. */
  ip?: string;
  location?: { latitude?: number; longitude?: number; accuracyMeters?: number; distanceMeters?: number };
}

const recordSchema = new Schema<IAttendanceRecord>(
  {
    session: { type: Schema.Types.ObjectId, ref: "AttendanceSession", required: true, immutable: true },
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true, immutable: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true },
    courseCode: { type: String, required: true, immutable: true },
    markedAt: { type: Date, required: true },
    status: { type: String, enum: ATTENDANCE_RECORD_STATUSES, required: true },
    device: { type: Schema.Types.ObjectId, ref: "StudentAttendanceDevice" },
    ip: { type: String, maxlength: 64 },
    location: { latitude: Number, longitude: Number, accuracyMeters: Number, distanceMeters: Number },
  },
  { timestamps: true },
);
// One mark per student per session: this is the real double-submit guard.
recordSchema.index({ session: 1, student: 1 }, { unique: true });
recordSchema.index({ student: 1, courseCode: 1 });

export type AttendanceRecordDocument = HydratedDocument<IAttendanceRecord>;
export const AttendanceRecord = model<IAttendanceRecord>("AttendanceRecord", recordSchema);
