import { HydratedDocument, Schema, Types, model } from "mongoose";
import {
  ACADEMIC_SESSION_REGEX, LEVEL_REGEX, MATERIAL_STATUSES, MATERIAL_TYPES, MaterialType, RESOURCE_TYPES, SEMESTERS, Semester,
} from "../utils/constants";
import { COURSE_CODE_REGEX, normalizeCourseCode } from "../utils/course";

export interface IMaterial {
  /** Owning department. Visibility is limited to it unless `sharedWith` says otherwise. */
  department: Types.ObjectId;
  title: string;
  description?: string;
  type: MaterialType;
  /** Absent for class-wide resources that aren't tied to one course. */
  courseCode?: string;
  level: string;
  semester: Semester;
  academicSession: string;
  /** Explicit cross-department sharing. Empty/omitted `levels` = every level of that department. */
  sharedWith: { department: Types.ObjectId; levels?: string[] }[];
  file: { url: string; publicId?: string; originalName: string; mimeType: string; sizeBytes: number };
  uploadedByName: string;
  uploadedByRole: string;
  status: "PUBLISHED" | "HIDDEN";
  /** Class resources written by a student representative. Official lecturer materials leave these unset and stay protected. */
  course?: Types.ObjectId;
  createdByStudent?: Types.ObjectId;
  /** Official materials: the lecturer who published it (the only one who can change it). */
  lecturer?: Types.ObjectId;
  resourceType?: string;
}

const materialSchema = new Schema<IMaterial>(
  {
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },
    type: { type: String, enum: MATERIAL_TYPES, required: true },
    courseCode: { type: String, set: normalizeCourseCode, match: COURSE_CODE_REGEX },
    level: { type: String, required: true, match: LEVEL_REGEX },
    semester: { type: String, enum: SEMESTERS, required: true },
    academicSession: { type: String, required: true, match: ACADEMIC_SESSION_REGEX },
    sharedWith: {
      type: [
        new Schema(
          { department: { type: Schema.Types.ObjectId, ref: "Department", required: true }, levels: [String] },
          { _id: false },
        ),
      ],
      default: [],
    },
    file: {
      url: { type: String, required: true },
      publicId: String,
      originalName: { type: String, required: true },
      mimeType: { type: String, required: true },
      sizeBytes: { type: Number, required: true, min: 0 },
    },
    uploadedByName: { type: String, required: true, trim: true },
    uploadedByRole: { type: String, required: true, trim: true },
    status: { type: String, enum: MATERIAL_STATUSES, default: "PUBLISHED" },
    course: { type: Schema.Types.ObjectId, ref: "Course" },
    createdByStudent: { type: Schema.Types.ObjectId, ref: "Student" },
    lecturer: { type: Schema.Types.ObjectId, ref: "Lecturer" },
    resourceType: { type: String, enum: RESOURCE_TYPES },
  },
  { timestamps: true },
);
materialSchema.index({ department: 1, courseCode: 1, status: 1 });
materialSchema.index({ "sharedWith.department": 1, status: 1 });
materialSchema.index({ course: 1, type: 1, status: 1 });
materialSchema.index({ lecturer: 1, type: 1 });

export type MaterialDocument = HydratedDocument<IMaterial>;
export const Material = model<IMaterial>("Material", materialSchema);
