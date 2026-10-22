import { HydratedDocument, Schema, Types, model } from "mongoose";
import {
  ACADEMIC_SESSION_REGEX, DAYS_OF_WEEK, DayOfWeek, LEVEL_REGEX, SEMESTERS, Semester,
  TIMETABLE_TYPES, TIME_REGEX, TimetableType,
} from "../utils/constants";
import { COURSE_CODE_REGEX, normalizeCourseCode } from "../utils/course";

/** An official class-timetable slot. Read-only for students. */
export interface ITimetableEntry {
  department: Types.ObjectId;
  level: string;
  academicSession: string;
  semester: Semester;
  /** Optional so non-course events (departmental hour, practicals) can be scheduled. Matched to enrollments by code. */
  courseCode?: string;
  title: string;
  type: TimetableType;
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  venue?: string;
  /** Plain name for now; becomes a Lecturer reference in the lecturer phase. */
  lecturerName?: string;
  /**
   * OFFICIAL (or absent): departmental / staff timetable, never editable by a representative.
   * CLASS_REP: the class timetable written by the Course Rep of that course.
   */
  source?: "OFFICIAL" | "CLASS_REP";
  /** DRAFT entries are visible only to the people who manage the class timetable, never to students. Absent = PUBLISHED. */
  status?: "DRAFT" | "PUBLISHED";
  /** Optional one-off date (YYYY-MM-DD), e.g. a make-up class. Absent = repeats weekly on dayOfWeek. */
  date?: string;
  course?: Types.ObjectId;
  createdByStudent?: Types.ObjectId;
  createdByRole?: string;
}

const timetableSchema = new Schema<ITimetableEntry>(
  {
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true },
    level: { type: String, required: true, match: LEVEL_REGEX },
    academicSession: { type: String, required: true, match: ACADEMIC_SESSION_REGEX },
    semester: { type: String, enum: SEMESTERS, required: true },
    courseCode: { type: String, set: normalizeCourseCode, match: COURSE_CODE_REGEX },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    type: { type: String, enum: TIMETABLE_TYPES, default: "LECTURE" },
    dayOfWeek: { type: String, enum: DAYS_OF_WEEK, required: true },
    startTime: { type: String, required: true, match: TIME_REGEX },
    endTime: { type: String, required: true, match: TIME_REGEX },
    venue: { type: String, trim: true, maxlength: 100 },
    lecturerName: { type: String, trim: true, maxlength: 120 },
    source: { type: String, enum: ["OFFICIAL", "CLASS_REP"] },
    status: { type: String, enum: ["DRAFT", "PUBLISHED"] },
    date: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    course: { type: Schema.Types.ObjectId, ref: "Course" },
    createdByStudent: { type: Schema.Types.ObjectId, ref: "Student" },
    createdByRole: { type: String, trim: true },
  },
  { timestamps: true },
);
timetableSchema.index({ department: 1, level: 1, academicSession: 1, semester: 1 });
timetableSchema.index({ department: 1, courseCode: 1, academicSession: 1, semester: 1 });

export type TimetableEntryDocument = HydratedDocument<ITimetableEntry>;
export const TimetableEntry = model<ITimetableEntry>("TimetableEntry", timetableSchema);
