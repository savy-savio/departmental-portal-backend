import { HydratedDocument, Schema, Types, model } from "mongoose";
import {
  ACADEMIC_SESSION_REGEX, LEVEL_REGEX, LECTURER_ASSIGNMENT_STATUSES, LecturerAssignmentStatus, SEMESTERS, Semester,
} from "../utils/constants";

/**
 * The ONLY source of a lecturer's authority over a course: lecturer + department + course + session + semester, while ACTIVE.
 * Created / revoked by the HOD phase (until then via the seeder / account service). Lecturers can't create or change their own.
 */
export interface ILecturerCourseAssignment {
  lecturer: Types.ObjectId;
  department: Types.ObjectId;
  course: Types.ObjectId;
  courseCode: string;
  level: string;
  academicSession: string;
  semester: Semester;
  status: LecturerAssignmentStatus;
  assignedBy: { name: string; role: string; id?: Types.ObjectId };
  assignedAt: Date;
  revokedAt?: Date;
  revokedBy?: { name: string; role: string; id?: Types.ObjectId };
}

const schema = new Schema<ILecturerCourseAssignment>(
  {
    lecturer: { type: Schema.Types.ObjectId, ref: "Lecturer", required: true, immutable: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true },
    course: { type: Schema.Types.ObjectId, ref: "Course", required: true, immutable: true },
    courseCode: { type: String, required: true, immutable: true },
    level: { type: String, required: true, match: LEVEL_REGEX, immutable: true },
    academicSession: { type: String, required: true, match: ACADEMIC_SESSION_REGEX, immutable: true },
    semester: { type: String, enum: SEMESTERS, required: true, immutable: true },
    status: { type: String, enum: LECTURER_ASSIGNMENT_STATUSES, default: "ACTIVE" },
    assignedBy: { name: { type: String, required: true }, role: { type: String, required: true }, id: Schema.Types.ObjectId },
    assignedAt: { type: Date, required: true, default: Date.now },
    revokedAt: Date,
    revokedBy: { name: String, role: String, id: Schema.Types.ObjectId },
  },
  { timestamps: true },
);
// A lecturer holds a course at most once at a time; several lecturers may co-teach the same course.
schema.index({ lecturer: 1, course: 1 }, { unique: true, partialFilterExpression: { status: "ACTIVE" } });
schema.index({ lecturer: 1, status: 1 });
schema.index({ department: 1, courseCode: 1, academicSession: 1, semester: 1, status: 1 });

export type LecturerCourseAssignmentDocument = HydratedDocument<ILecturerCourseAssignment>;
export const LecturerCourseAssignment = model<ILecturerCourseAssignment>("LecturerCourseAssignment", schema);
