import { Schema, Types, model } from "mongoose";
import { LECTURER_AUDIT_ACTIONS } from "../utils/constants";

/**
 * Append-only trail of lecturer actions (and denied attempts). Written for the HOD / admin phase to review.
 * A separate model because the existing audit logs are scoped to representatives and attendance security; the HOD phase
 * can later fold these into one generic audit view.
 */
export interface ILecturerAuditLog {
  actor?: Types.ObjectId;
  actorName?: string;
  role: string;
  action: string;
  resourceType?: "ANNOUNCEMENT" | "MATERIAL" | "ASSIGNMENT" | "ATTENDANCE_SESSION" | "COURSE" | "LECTURER" | "COMPLAINT";
  resourceId?: string;
  course?: Types.ObjectId;
  courseCode?: string;
  department: Types.ObjectId;
  ip?: string;
  detail?: Record<string, unknown>;
  at: Date;
}
const schema = new Schema<ILecturerAuditLog>(
  {
    actor: { type: Schema.Types.ObjectId, ref: "Lecturer" },
    actorName: String,
    role: { type: String, required: true },
    action: { type: String, enum: LECTURER_AUDIT_ACTIONS, required: true },
    resourceType: { type: String, enum: ["ANNOUNCEMENT", "MATERIAL", "ASSIGNMENT", "ATTENDANCE_SESSION", "COURSE", "LECTURER", "COMPLAINT"] },
    resourceId: String,
    course: { type: Schema.Types.ObjectId, ref: "Course" },
    courseCode: String,
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true },
    ip: { type: String, maxlength: 64 },
    detail: Schema.Types.Mixed,
    at: { type: Date, required: true },
  },
  { timestamps: false, versionKey: false },
);
schema.index({ department: 1, at: -1 });
schema.index({ actor: 1, at: -1 });
schema.index({ course: 1, action: 1, at: -1 });
export const LecturerAuditLog = model<ILecturerAuditLog>("LecturerAuditLog", schema);
