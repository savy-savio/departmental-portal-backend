import { HydratedDocument, Schema, model } from "mongoose";
import { LEVEL_REGEX } from "../utils/constants";

export interface IDepartment {
  name: string;
  /** Short identifier, e.g. "CSC". */
  code: string;
  /** Letters embedded in student matric numbers, e.g. "CSC" in 25/208CSC/987. */
  matricCode: string;
  faculty: string;
  /** Levels this department offers, e.g. ["100","200","300","400"] or up to "500". */
  levels: string[];
  isActive: boolean;
  /** HOD-editable contact information. */
  contact?: { email?: string; phone?: string; office?: string };
}

const departmentSchema = new Schema<IDepartment>(
  {
    name: { type: String, required: true, trim: true, unique: true },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
      match: [/^[A-Z]{2,10}$/, "code must be 2-10 letters"],
    },
    matricCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
      match: [/^[A-Z]{2,10}$/, "matricCode must be 2-10 letters"],
    },
    faculty: { type: String, required: true, trim: true },
    levels: {
      type: [String],
      required: true,
      validate: [
        {
          validator: (v: string[]) => Array.isArray(v) && v.length > 0,
          message: "A department needs at least one level",
        },
        {
          validator: (v: string[]) => v.every((l) => LEVEL_REGEX.test(l)),
          message: 'Levels must look like "100", "200", ...',
        },
      ],
    },
    isActive: { type: Boolean, default: true },
    contact: { email: { type: String, trim: true, lowercase: true, maxlength: 254 }, phone: { type: String, trim: true, maxlength: 30 }, office: { type: String, trim: true, maxlength: 120 } },
  },
  { timestamps: true },
);

departmentSchema.pre("validate", function (next) {
  if (Array.isArray(this.levels)) {
    this.levels = [...new Set(this.levels)].sort();
  }
  next();
});

export type DepartmentDocument = HydratedDocument<IDepartment>;
export const Department = model<IDepartment>("Department", departmentSchema);
