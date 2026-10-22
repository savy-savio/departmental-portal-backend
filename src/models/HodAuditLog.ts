import { Schema, Types, model } from "mongoose";
import { HOD_AUDIT_ACTIONS } from "../utils/constants";

/** Append-only trail of department-admin actions (and denied / out-of-scope attempts). Department-scoped. */
export interface IHodAuditLog {
  actor?: Types.ObjectId;
  actorName?: string;
  role: string;
  action: string;
  resourceType?: "LECTURER" | "COURSE" | "REPRESENTATIVE" | "STUDENT" | "COMPLAINT" | "ANNOUNCEMENT" | "DOCUMENT" | "DEPARTMENT" | "TERM" | "HOD" | "ELECTION" | "ELECTION_POSITION" | "ELECTION_CANDIDATE";
  resourceId?: string;
  department: Types.ObjectId;
  ip?: string;
  detail?: Record<string, unknown>;
  at: Date;
}
const schema = new Schema<IHodAuditLog>(
  {
    actor: { type: Schema.Types.ObjectId, ref: "Hod" },
    actorName: String,
    role: { type: String, required: true },
    action: { type: String, enum: HOD_AUDIT_ACTIONS, required: true },
    resourceType: { type: String, enum: ["LECTURER", "COURSE", "REPRESENTATIVE", "STUDENT", "COMPLAINT", "ANNOUNCEMENT", "DOCUMENT", "DEPARTMENT", "TERM", "HOD", "ELECTION", "ELECTION_POSITION", "ELECTION_CANDIDATE"] },
    resourceId: String,
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true },
    ip: { type: String, maxlength: 64 },
    detail: Schema.Types.Mixed,
    at: { type: Date, required: true },
  },
  { timestamps: false, versionKey: false },
);
schema.index({ department: 1, at: -1 });
schema.index({ actor: 1, at: -1 });
schema.index({ department: 1, action: 1, at: -1 });
export const HodAuditLog = model<IHodAuditLog>("HodAuditLog", schema);
