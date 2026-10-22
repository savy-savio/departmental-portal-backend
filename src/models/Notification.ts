import { HydratedDocument, Schema, Types, model } from "mongoose";
import { NOTIFICATION_KINDS, NOTIFICATION_RECIPIENT_TYPES, NotificationKind } from "../utils/constants";

export interface INotification {
  /** A Student or a Lecturer id, depending on recipientType (absent = STUDENT, so every existing notification stays valid). */
  recipient: Types.ObjectId;
  recipientType?: "STUDENT" | "LECTURER" | "HOD";
  department: Types.ObjectId;
  kind: NotificationKind;
  title: string;
  body: string;
  complaintId?: Types.ObjectId;
  /** In-app path, e.g. "/student/materials". */
  link?: string;
  readAt?: Date;
  /** Optional idempotency key: one notification per (recipient, key), so a retried job or request can't notify twice. */
  dedupeKey?: string;
}

const notificationSchema = new Schema<INotification>(
  {
    recipient: { type: Schema.Types.ObjectId, required: true, immutable: true },
    recipientType: { type: String, enum: NOTIFICATION_RECIPIENT_TYPES, default: "STUDENT" },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true },
    kind: { type: String, enum: NOTIFICATION_KINDS, required: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
    complaintId: { type: Schema.Types.ObjectId, ref: "Complaint" },
    link: { type: String, trim: true, maxlength: 200 },
    readAt: { type: Date },
    dedupeKey: { type: String, maxlength: 120 },
  },
  { timestamps: true },
);
notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, readAt: 1 });
notificationSchema.index({ recipient: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });
// Old notifications clean themselves up after 90 days.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export type NotificationDocument = HydratedDocument<INotification>;
export const Notification = model<INotification>("Notification", notificationSchema);
