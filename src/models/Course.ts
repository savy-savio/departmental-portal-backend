import { HydratedDocument, Schema, Types, model } from "mongoose";
import {
  ACADEMIC_SESSION_REGEX,
  COURSE_STATUSES,
  CourseStatus,
  LEVEL_REGEX,
  SEMESTERS,
  Semester,
} from "../utils/constants";
import { COURSE_CODE_REGEX, normalizeCourseCode } from "../utils/course";

/**
 * One catalogue entry: a course offered by a department, at a level, in a semester of a session.
 * The same code in another session is a different record (so history stays accurate);
 * carryovers point back at the original record rather than copying it.
 */
export interface ICourse {
  courseCode: string;
  title: string;
  description?: string;
  units: number;
  department: Types.ObjectId;
  level: string;
  semester: Semester;
  academicSession: string;
  status: CourseStatus;
}

const courseSchema = new Schema<ICourse>(
  {
    courseCode: {
      type: String,
      required: true,
      set: normalizeCourseCode,
      match: [COURSE_CODE_REGEX, "Course code must look like CSC201"],
    },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },
    units: { type: Number, required: true, min: 0, max: 12 },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true },
    level: { type: String, required: true, match: LEVEL_REGEX },
    semester: { type: String, enum: SEMESTERS, required: true },
    academicSession: { type: String, required: true, match: ACADEMIC_SESSION_REGEX },
    status: { type: String, enum: COURSE_STATUSES, default: "ACTIVE" },
  },
  { timestamps: true },
);

courseSchema.index({ department: 1, courseCode: 1, academicSession: 1, semester: 1 }, { unique: true });
courseSchema.index({ department: 1, level: 1, academicSession: 1, semester: 1, status: 1 });

export type CourseDocument = HydratedDocument<ICourse>;
export const Course = model<ICourse>("Course", courseSchema);
