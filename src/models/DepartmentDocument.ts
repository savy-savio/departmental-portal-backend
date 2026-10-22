import { HydratedDocument, Schema, Types, model } from "mongoose";
import { ACADEMIC_SESSION_REGEX, DEPARTMENT_DOCUMENT_STATUSES, LEVEL_REGEX } from "../utils/constants";

/**
 * Department-level administrative documents (notices, forms, handbooks) published by the HOD.
 * Deliberately a separate model: NOT a lecturer's official course material and NOT a class resource written by a representative,
 * so ownership is never ambiguous and the HOD never silently owns anyone else's material.
 */
export interface IDepartmentDocument {
  department: Types.ObjectId;
  title: string;
  description?: string;
  /** Empty = every level of the department. */
  levels: string[];
  file: { url: string; publicId?: string; originalName: string; mimeType: string; sizeBytes: number };
  status: "PUBLISHED" | "HIDDEN";
  createdByHod: Types.ObjectId;
  createdByName: string;
  academicSession?: string;
}
const schema = new Schema<IDepartmentDocument>(
  {
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },
    levels: { type: [String], default: [], validate: (v: string[]) => v.every((l) => LEVEL_REGEX.test(l)) },
    file: {
      url: { type: String, required: true },
      publicId: String,
      originalName: { type: String, required: true },
      mimeType: { type: String, required: true },
      sizeBytes: { type: Number, required: true, min: 0 },
    },
    status: { type: String, enum: DEPARTMENT_DOCUMENT_STATUSES, default: "PUBLISHED" },
    createdByHod: { type: Schema.Types.ObjectId, ref: "Hod", required: true, immutable: true },
    createdByName: { type: String, required: true },
    academicSession: { type: String, match: ACADEMIC_SESSION_REGEX },
  },
  { timestamps: true },
);
schema.index({ department: 1, status: 1, createdAt: -1 });
export type DepartmentDocumentDocument = HydratedDocument<IDepartmentDocument>;
export const DepartmentDocumentModel = model<IDepartmentDocument>("DepartmentDocument", schema);
