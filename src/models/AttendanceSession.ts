import { HydratedDocument, Schema, Types, model } from "mongoose";
import {
  ACADEMIC_SESSION_REGEX, ATTENDANCE_SESSION_STATUSES, DEFAULT_LATE_AFTER_MINUTES, LEVEL_REGEX, SEMESTERS, Semester,
} from "../utils/constants";
import { COURSE_CODE_REGEX, normalizeCourseCode } from "../utils/course";

/** One class meeting a lecturer opens for attendance. Department + course scoped. */
export interface IAttendanceSession {
  department: Types.ObjectId;
  courseCode: string;
  level: string;
  academicSession: string;
  semester: Semester;
  title: string;
  opensAt: Date;
  closesAt: Date;
  /** Marks after opensAt + this many minutes are recorded as LATE. */
  lateAfterMinutes: number;
  /** SHA-256 of the in-class code, if the lecturer requires one. The code itself is never stored. */
  codeHash?: string;
  status: "ACTIVE" | "CLOSED" | "CANCELLED";
  /**
   * Where the class is held. Optional ONLY so sessions created before this feature keep working;
   * every session created through createAttendanceSession() has it, and the student endpoint enforces it when present.
   */
  location?: { latitude?: number; longitude?: number; allowedRadiusInMeters?: number; /** How accurate the lecturer's own reading of the venue was (metres). */ accuracyMeters?: number; /** @deprecated pre-rename name, still read for old sessions */ radiusMeters?: number };
  /** Authorised creator (lecturer / HOD / course rep account). Unset until those phases exist. */
  createdBy?: Types.ObjectId;
  /** The lecturer who opened the session (read by the lecturer and HOD views). Older sessions may not have it. */
  lecturer?: Types.ObjectId;
  /** The catalogue Course this session belongs to. Older sessions may only carry `courseCode`. */
  course?: Types.ObjectId;
  /** Snapshot until lecturer accounts exist; the lecturer phase will add the assigned-lecturer reference and check it on creation. */
  createdByName: string;
  createdByRole: string;
}

const sessionSchema = new Schema<IAttendanceSession>(
  {
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true },
    courseCode: { type: String, required: true, set: normalizeCourseCode, match: COURSE_CODE_REGEX },
    level: { type: String, required: true, match: LEVEL_REGEX },
    academicSession: { type: String, required: true, match: ACADEMIC_SESSION_REGEX },
    semester: { type: String, enum: SEMESTERS, required: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    opensAt: { type: Date, required: true },
    closesAt: { type: Date, required: true },
    lateAfterMinutes: { type: Number, default: DEFAULT_LATE_AFTER_MINUTES, min: 0 },
    codeHash: { type: String, select: false },
    status: { type: String, enum: ATTENDANCE_SESSION_STATUSES, default: "ACTIVE" },
    location: {
      latitude: { type: Number, min: -90, max: 90 },
      longitude: { type: Number, min: -180, max: 180 },
      allowedRadiusInMeters: { type: Number, min: 5, max: 5000 },
      radiusMeters: { type: Number, min: 5, max: 5000 }, // legacy name: read-only fallback
      accuracyMeters: { type: Number, min: 0, max: 100000 }, // the lecturer's own GPS accuracy when the venue was set
    },
    createdBy: { type: Schema.Types.ObjectId },
    lecturer: { type: Schema.Types.ObjectId, ref: "Lecturer" },
    course: { type: Schema.Types.ObjectId, ref: "Course" },
    createdByName: { type: String, required: true, trim: true },
    createdByRole: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);
sessionSchema.pre("validate", function (next) {
  const loc = this.location;
  const parts = [loc?.latitude, loc?.longitude, loc?.allowedRadiusInMeters ?? loc?.radiusMeters].filter((v) => v !== undefined && v !== null);
  if (parts.length !== 0 && parts.length !== 3) this.invalidate("location", "latitude, longitude and allowedRadiusInMeters must be provided together");
  if (this.opensAt && this.closesAt && this.closesAt <= this.opensAt) this.invalidate("closesAt", "closesAt must be after opensAt");
  next();
});
sessionSchema.index({ department: 1, courseCode: 1, academicSession: 1, semester: 1, opensAt: 1 });
sessionSchema.index({ lecturer: 1, opensAt: -1 });

export type AttendanceSessionDocument = HydratedDocument<IAttendanceSession>;
export const AttendanceSession = model<IAttendanceSession>("AttendanceSession", sessionSchema);
