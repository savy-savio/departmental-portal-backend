import { Schema, Types, model } from "mongoose";
import { REP_AUDIT_ACTIONS } from "../utils/constants";

/** Append-only trail of representative actions (and denied attempts). For administrators; never shown to ordinary students. */
export interface IRepresentativeAuditLog {
  /** The representative (a student). Unset for HOD-initiated assignment events until HOD accounts exist. */
  actor?: Types.ObjectId;
  actorName?: string;
  role?: string;
  action: string;
  resourceType?: "ANNOUNCEMENT" | "RESOURCE" | "ASSIGNMENT" | "COURSE";
  resourceId?: string;
  course?: Types.ObjectId;
  courseCode?: string;
  department: Types.ObjectId;
  /** Small, non-sensitive context: changed field names, title, denial reason. */
  detail?: Record<string, unknown>;
  at: Date;
}
const auditSchema = new Schema<IRepresentativeAuditLog>(
  {
    actor: { type: Schema.Types.ObjectId, ref: "Student" },
    actorName: String,
    role: String,
    action: { type: String, enum: REP_AUDIT_ACTIONS, required: true },
    resourceType: { type: String, enum: ["ANNOUNCEMENT", "RESOURCE", "ASSIGNMENT", "COURSE"] },
    resourceId: String,
    course: { type: Schema.Types.ObjectId, ref: "Course" },
    courseCode: String,
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true },
    detail: Schema.Types.Mixed,
    at: { type: Date, required: true },
  },
  { timestamps: false, versionKey: false },
);
auditSchema.index({ department: 1, at: -1 });
auditSchema.index({ actor: 1, at: -1 });
auditSchema.index({ course: 1, action: 1, at: -1 });
export const RepresentativeAuditLog = model<IRepresentativeAuditLog>("RepresentativeAuditLog", auditSchema);
