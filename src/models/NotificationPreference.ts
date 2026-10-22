import { HydratedDocument, Schema, Types, model } from "mongoose";

/** Per-user choices for BROWSER PUSH only. In-app notification history is never affected by these. No document = everything on. */
export interface INotificationPreference {
  user: Types.ObjectId;
  userType: "STUDENT" | "LECTURER" | "HOD";
  pushEnabled: boolean;
  categories: { announcements: boolean; timetablesAndMaterials: boolean; assignments: boolean; complaints: boolean };
}
const flag = { type: Boolean, default: true };
const schema = new Schema<INotificationPreference>(
  {
    user: { type: Schema.Types.ObjectId, required: true },
    userType: { type: String, enum: ["STUDENT", "LECTURER", "HOD"], required: true },
    pushEnabled: flag,
    categories: { announcements: flag, timetablesAndMaterials: flag, assignments: flag, complaints: flag },
  },
  { timestamps: true },
);
schema.index({ user: 1, userType: 1 }, { unique: true });

export type NotificationPreferenceDocument = HydratedDocument<INotificationPreference>;
export const NotificationPreference = model<INotificationPreference>("NotificationPreference", schema);
