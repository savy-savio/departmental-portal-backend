import { HydratedDocument, Schema, Types, model } from "mongoose";
import {
  ACADEMIC_SESSION_REGEX, LEVEL_REGEX, REP_ASSIGNMENT_STATUSES, REP_ROLES, RepAssignmentStatus, RepRole, SEMESTERS, Semester,
} from "../utils/constants";

/**
 * The ONLY source of representative authority. A student is a Course Rep / Assistant Course Rep for a LEVEL of their
 * department (every course and the whole class of that level) in one session / semester, and only while this record is ACTIVE.
 * It can't be created through any student-facing endpoint.
 *
 * `scope`: "LEVEL" for every new appointment. Records created before level appointments existed have a `course` and
 * (when `scope` is absent) are read as course-scoped, so they keep working until the HOD replaces them.
 */
export interface ICourseRepresentativeAssignment {
  student: Types.ObjectId;
  department: Types.ObjectId;
  scope?: "LEVEL" | "COURSE";
  /** Legacy course-scoped appointments only. Level appointments have no course. */
  course?: Types.ObjectId;
  courseCode?: string;
  level: string;
  academicSession: string;
  semester: Semester;
  role: RepRole;
  status: RepAssignmentStatus;
  /** Snapshot until HOD accounts exist; `id` gets filled in by the HOD phase. */
  assignedBy: { name: string; role: string; id?: Types.ObjectId };
  assignedAt: Date;
  revokedAt?: Date;
  revokedBy?: { name: string; role: string; id?: Types.ObjectId };
  revokeReason?: string;
}

const assignmentSchema = new Schema<ICourseRepresentativeAssignment>(
  {
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true, immutable: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true },
    scope: { type: String, enum: ["LEVEL", "COURSE"], default: "LEVEL", immutable: true },
    course: { type: Schema.Types.ObjectId, ref: "Course", immutable: true },
    courseCode: { type: String, immutable: true },
    level: { type: String, required: true, match: LEVEL_REGEX, immutable: true },
    academicSession: { type: String, required: true, match: ACADEMIC_SESSION_REGEX, immutable: true },
    semester: { type: String, enum: SEMESTERS, required: true, immutable: true },
    role: { type: String, enum: REP_ROLES, required: true, immutable: true },
    status: { type: String, enum: REP_ASSIGNMENT_STATUSES, default: "ACTIVE" },
    assignedBy: { name: { type: String, required: true }, role: { type: String, required: true }, id: Schema.Types.ObjectId },
    assignedAt: { type: Date, required: true, default: Date.now },
    revokedAt: Date,
    revokedBy: { name: String, role: String, id: Schema.Types.ObjectId },
    revokeReason: { type: String, maxlength: 500 },
  },
  { timestamps: true },
);
// Level appointments: ONE active Course Rep per level per term, and a student holds at most one ACTIVE role per level per term.
assignmentSchema.index(
  { department: 1, level: 1, academicSession: 1, semester: 1, role: 1 },
  { name: "one_course_rep_per_level_term", unique: true, partialFilterExpression: { status: "ACTIVE", role: "COURSE_REP", scope: "LEVEL" } },
);
assignmentSchema.index(
  { student: 1, department: 1, level: 1, academicSession: 1, semester: 1 },
  { name: "one_role_per_student_per_level_term", unique: true, partialFilterExpression: { status: "ACTIVE", scope: "LEVEL" } },
);
// Legacy course-scoped appointments keep their old guarantees (only records that actually have a course).
assignmentSchema.index({ course: 1, role: 1 }, { unique: true, partialFilterExpression: { status: "ACTIVE", role: "COURSE_REP", course: { $type: "objectId" } } });
assignmentSchema.index({ student: 1, course: 1 }, { unique: true, partialFilterExpression: { status: "ACTIVE", course: { $type: "objectId" } } });
assignmentSchema.index({ student: 1, status: 1 });
assignmentSchema.index({ department: 1, course: 1, status: 1 });

export type CourseRepresentativeAssignmentDocument = HydratedDocument<ICourseRepresentativeAssignment>;
export const CourseRepresentativeAssignment = model<ICourseRepresentativeAssignment>("CourseRepresentativeAssignment", assignmentSchema);
