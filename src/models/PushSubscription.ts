import { HydratedDocument, Schema, Types, model } from "mongoose";

/**
 * One browser / device registration for web push. A user may have several (phone + laptop). This is NOT a paid membership.
 * The encryption keys are secrets: `select: false`, never returned by any API.
 */
export interface IPushSubscription {
  user: Types.ObjectId;
  userType: "STUDENT" | "LECTURER" | "HOD";
  department: Types.ObjectId;
  endpoint: string;
  keys?: { p256dh: string; auth: string };
  active: boolean;
  failureCount: number;
  lastUsedAt?: Date;
  lastFailureAt?: Date;
  deviceLabel?: string;
}

const schema = new Schema<IPushSubscription>(
  {
    user: { type: Schema.Types.ObjectId, required: true },
    userType: { type: String, enum: ["STUDENT", "LECTURER", "HOD"], required: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true },
    endpoint: { type: String, required: true, unique: true, maxlength: 2048 },
    keys: { type: { p256dh: { type: String, required: true }, auth: { type: String, required: true }, _id: false }, select: false },
    active: { type: Boolean, default: true },
    failureCount: { type: Number, default: 0 },
    lastUsedAt: Date,
    lastFailureAt: Date,
    deviceLabel: { type: String, trim: true, maxlength: 60 },
  },
  { timestamps: true },
);
schema.index({ user: 1, userType: 1, active: 1 });

export type PushSubscriptionDocument = HydratedDocument<IPushSubscription>;
export const PushSubscription = model<IPushSubscription>("PushSubscription", schema);
