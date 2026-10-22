import { HydratedDocument, Schema, Types, model } from "mongoose";
import {
  ACADEMIC_SESSION_REGEX,
  ENROLLMENT_STATUSES,
  ENROLLMENT_TYPES,
  EnrollmentStatus,
  EnrollmentType,
  SEMESTERS,
  Semester,
} from "../utils/constants";

/** A student's registration for a course in a specific term. References the Course; never copies it. */
export interface ICourseEnrollment {
  student: Types.ObjectId;
  course: Types.ObjectId;
  /** Denormalised so every query can be department-scoped and so duplicate codes are caught. */
  department: Types.ObjectId;
  courseCode: string;
  /** The term the student is taking it in (a carryover's Course may be from an earlier session). */
  academicSession: string;
  semester: Semester;
  enrollmentType: EnrollmentType;
  status: EnrollmentStatus;
}

const courseEnrollmentSchema = new Schema<ICourseEnrollment>(
  {
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true, immutable: true },
    course: { type: Schema.Types.ObjectId, ref: "Course", required: true, immutable: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true },
    courseCode: { type: String, required: true, immutable: true },
    academicSession: { type: String, required: true, match: ACADEMIC_SESSION_REGEX, immutable: true },
    semester: { type: String, enum: SEMESTERS, required: true, immutable: true },
    enrollmentType: { type: String, enum: ENROLLMENT_TYPES, default: "REGULAR" },
    status: { type: String, enum: ENROLLMENT_STATUSES, default: "ENROLLED" },
  },
  { timestamps: true },
);

// A student can't hold the same course twice, nor the same course CODE twice, in one term.
courseEnrollmentSchema.index({ student: 1, course: 1, academicSession: 1, semester: 1 }, { unique: true });
courseEnrollmentSchema.index({ student: 1, courseCode: 1, academicSession: 1, semester: 1 }, { unique: true });
// "Who is enrolled in this course" (used by lecturer / attendance / assignment phases).
courseEnrollmentSchema.index({ course: 1, status: 1 });

export type CourseEnrollmentDocument = HydratedDocument<ICourseEnrollment>;
export const CourseEnrollment = model<ICourseEnrollment>("CourseEnrollment", courseEnrollmentSchema);
