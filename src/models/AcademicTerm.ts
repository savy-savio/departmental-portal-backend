import { HydratedDocument, Schema, Types, model } from "mongoose";
import { ACADEMIC_SESSION_REGEX, DEFAULT_MAX_UNITS, SEMESTERS, Semester } from "../utils/constants";

export interface IAcademicTerm {
  department: Types.ObjectId;
  academicSession: string;
  semester: Semester;
  /** Exactly one current term per department (enforced by a partial unique index). */
  isCurrent: boolean;
  /** Master switch for course registration; the optional dates narrow it further. */
  registrationOpen: boolean;
  registrationOpensAt?: Date;
  registrationClosesAt?: Date;
  maxUnits: number;
}

const academicTermSchema = new Schema<IAcademicTerm>(
  {
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true },
    academicSession: { type: String, required: true, match: ACADEMIC_SESSION_REGEX },
    semester: { type: String, enum: SEMESTERS, required: true },
    isCurrent: { type: Boolean, default: false },
    registrationOpen: { type: Boolean, default: true },
    registrationOpensAt: { type: Date },
    registrationClosesAt: { type: Date },
    maxUnits: { type: Number, default: DEFAULT_MAX_UNITS, min: 1, max: 60 },
  },
  { timestamps: true },
);

academicTermSchema.index({ department: 1, academicSession: 1, semester: 1 }, { unique: true });
academicTermSchema.index({ department: 1 }, { unique: true, partialFilterExpression: { isCurrent: true } });

export type AcademicTermDocument = HydratedDocument<IAcademicTerm>;
export const AcademicTerm = model<IAcademicTerm>("AcademicTerm", academicTermSchema);

export function isRegistrationOpen(term: Pick<IAcademicTerm, "isCurrent" | "registrationOpen" | "registrationOpensAt" | "registrationClosesAt">, now = new Date()): boolean {
  if (!term.isCurrent || !term.registrationOpen) return false;
  if (term.registrationOpensAt && now < term.registrationOpensAt) return false;
  if (term.registrationClosesAt && now > term.registrationClosesAt) return false;
  return true;
}
