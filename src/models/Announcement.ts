import { HydratedDocument, Schema, Types, model } from "mongoose";
import {
  ACADEMIC_SESSION_REGEX, ANNOUNCEMENT_PRIORITIES, ANNOUNCEMENT_SCOPES, ANNOUNCEMENT_STATUSES,
  AnnouncementScope, LEVEL_REGEX,
} from "../utils/constants";
import { normalizeCourseCode } from "../utils/course";

export interface IAnnouncement {
  department: Types.ObjectId;
  title: string;
  body: string;
  priority: "NORMAL" | "IMPORTANT" | "URGENT";
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED" | "UNPUBLISHED" | "DELETED";
  /**
   * Who sees it (always inside `department`):
   *  DEPARTMENT every student | LEVEL students at audience.levels | CLASS level + session
   *  COURSE students enrolled in audience.courseCodes | GROUP the listed students only
   */
  audience: {
    scope: AnnouncementScope;
    levels?: string[];
    academicSession?: string;
    courseCodes?: string[];
    studentIds?: Types.ObjectId[];
  };
  /** Snapshot until staff accounts exist (HOD / lecturer / course-rep phases). */
  createdByName: string;
  createdByRole: string;
  /** Set when a student representative wrote it (course-rep phase). Staff-written announcements leave these unset. */
  course?: Types.ObjectId;
  level?: string;
  academicSession?: string;
  semester?: "FIRST" | "SECOND";
  createdByStudent?: Types.ObjectId;
  /** Set when a lecturer wrote it. Mutually exclusive with createdByStudent: each role can only ever touch its own. */
  createdByLecturer?: Types.ObjectId;
  /** Set when the department head wrote it (department-wide / level notices). */
  createdByHod?: Types.ObjectId;
  /** Optional picture attached by the author. `publicId` is only for deleting it from storage and is never returned to clients. */
  image?: { url: string; publicId?: string };
  publishedAt: Date;
  expiresAt?: Date;
}

const announcementSchema = new Schema<IAnnouncement>(
  {
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 10_000 },
    priority: { type: String, enum: ANNOUNCEMENT_PRIORITIES, default: "NORMAL" },
    status: { type: String, enum: ANNOUNCEMENT_STATUSES, default: "PUBLISHED" },
    audience: {
      scope: { type: String, enum: ANNOUNCEMENT_SCOPES, required: true, default: "DEPARTMENT" },
      levels: { type: [String], validate: (v: string[]) => v.every((l) => LEVEL_REGEX.test(l)), default: undefined },
      academicSession: { type: String, match: ACADEMIC_SESSION_REGEX },
      courseCodes: { type: [String], set: (v: string[]) => v.map(normalizeCourseCode), default: undefined },
      studentIds: { type: [Schema.Types.ObjectId], ref: "Student", default: undefined },
    },
    createdByName: { type: String, required: true, trim: true },
    createdByRole: { type: String, required: true, trim: true },
    course: { type: Schema.Types.ObjectId, ref: "Course" },
    level: { type: String, match: LEVEL_REGEX },
    academicSession: { type: String, match: ACADEMIC_SESSION_REGEX },
    semester: { type: String, enum: ["FIRST", "SECOND"] },
    createdByStudent: { type: Schema.Types.ObjectId, ref: "Student" },
    createdByLecturer: { type: Schema.Types.ObjectId, ref: "Lecturer" },
    createdByHod: { type: Schema.Types.ObjectId, ref: "Hod" },
    image: { type: { url: { type: String, required: true, maxlength: 1000 }, publicId: { type: String, select: false }, _id: false } },
    publishedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);
announcementSchema.index({ department: 1, status: 1, publishedAt: -1 });
announcementSchema.index({ course: 1, status: 1 });

export type AnnouncementDocument = HydratedDocument<IAnnouncement>;
export const Announcement = model<IAnnouncement>("Announcement", announcementSchema);
