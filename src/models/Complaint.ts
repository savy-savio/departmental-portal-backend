import { HydratedDocument, Schema, Types, model } from "mongoose";
import { COMPLAINT_STATUSES, COMPLAINT_TYPES, ComplaintStatus, ComplaintType } from "../utils/constants";

export interface IComplaintAttachment {
  _id: Types.ObjectId;
  publicId: string;
  resourceType: "image" | "raw";
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}
export interface IComplaintEvent {
  _id: Types.ObjectId;
  status: ComplaintStatus;
  label: string;
  note?: string;
  at: Date;
  byRole?: string;
  /** Who acted when it was a lecturer (the HOD's own events predate these fields and stay as they are). */
  byId?: Types.ObjectId;
  byName?: string;
  /** HOD-only note: never shown to the student. */
  internal?: boolean;
}

export interface IComplaint {
  department: Types.ObjectId;
  student: Types.ObjectId;
  referenceNumber: string;
  type: ComplaintType;
  title: string;
  message: string;
  /** COURSE complaints only: the course (in the student's own department) and a snapshot for display. */
  course?: Types.ObjectId;
  courseCode?: string;
  courseTitle?: string;
  /**
   * Routing is by role + department (+ course for lecturers). `userId` is filled when the HOD / lecturer phases
   * assign it to a real account; until then the department's HOD (or the course's lecturer) will find it by these fields.
   */
  recipient: { role: "HOD" | "LECTURER"; userId?: Types.ObjectId };
  status: ComplaintStatus;
  /** HOD review: the lecturer the HOD forwarded it to (for course complaints, one assigned to that course). */
  assignedLecturer?: Types.ObjectId;
  assignedAt?: Date;
  resolution?: string;
  resolvedAt?: Date;
  reviewedBy?: Types.ObjectId;
  attachments: Types.DocumentArray<IComplaintAttachment>;
  timeline: Types.DocumentArray<IComplaintEvent>;
}

const attachmentSchema = new Schema<IComplaintAttachment>({
  publicId: { type: String, required: true },
  resourceType: { type: String, enum: ["image", "raw"], required: true },
  originalName: { type: String, required: true },
  mimeType: { type: String, required: true },
  sizeBytes: { type: Number, required: true },
});
const eventSchema = new Schema<IComplaintEvent>({
  status: { type: String, enum: COMPLAINT_STATUSES, required: true },
  label: { type: String, required: true },
  note: String,
  at: { type: Date, default: Date.now },
  byRole: String,
  byId: { type: Schema.Types.ObjectId },
  byName: { type: String, trim: true },
  internal: { type: Boolean, default: false },
});

const complaintSchema = new Schema<IComplaint>(
  {
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true },
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true, immutable: true },
    referenceNumber: { type: String, required: true, unique: true, immutable: true },
    type: { type: String, enum: COMPLAINT_TYPES, required: true, immutable: true },
    title: { type: String, required: true, trim: true, minlength: 3, maxlength: 150 },
    message: { type: String, required: true, trim: true, minlength: 10, maxlength: 5000 },
    course: { type: Schema.Types.ObjectId, ref: "Course", immutable: true },
    courseCode: { type: String, immutable: true },
    courseTitle: { type: String, immutable: true },
    recipient: {
      role: { type: String, enum: ["HOD", "LECTURER"], required: true },
      userId: { type: Schema.Types.ObjectId },
    },
    status: { type: String, enum: COMPLAINT_STATUSES, default: "SUBMITTED" },
    assignedLecturer: { type: Schema.Types.ObjectId, ref: "Lecturer" },
    assignedAt: Date,
    resolution: { type: String, trim: true, maxlength: 5000 },
    resolvedAt: Date,
    reviewedBy: { type: Schema.Types.ObjectId, ref: "Hod" },
    attachments: { type: [attachmentSchema], default: [] },
    timeline: { type: [eventSchema], default: [] },
  },
  { timestamps: true },
);
complaintSchema.index({ student: 1, createdAt: -1 });
// Staff inboxes (later phases): "all complaints for my department / my course".
complaintSchema.index({ department: 1, "recipient.role": 1, status: 1 });
complaintSchema.index({ department: 1, courseCode: 1 });
complaintSchema.index({ department: 1, status: 1, createdAt: -1 });
complaintSchema.index({ assignedLecturer: 1, status: 1 });

export type ComplaintDocument = HydratedDocument<IComplaint>;
export const Complaint = model<IComplaint>("Complaint", complaintSchema);
