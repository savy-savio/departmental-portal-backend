import { HydratedDocument, Schema, Types, model } from "mongoose";
import {
  ACADEMIC_SESSION_REGEX,
  LEVEL_REGEX,
  STUDENT_ROLES,
  STUDENT_STATUSES,
  StudentRole,
  StudentStatus,
} from "../utils/constants";

export interface IStudent {
  firstName: string;
  lastName: string;
  /** Normalised, e.g. "25/208CSC/987". Immutable once created. */
  matricNumber: string;
  department: Types.ObjectId;
  level: string;
  academicSession: string;

  email?: string;
  phone?: string;
  sex?: "MALE" | "FEMALE";
  profilePhoto?: string;
  /** Cloudinary public_id of the current photo (used to delete the old image). Never exposed. */
  profilePhotoPublicId?: string;

  role: StudentRole;
  status: StudentStatus;
  onboardingCompleted: boolean;
  onboardedAt?: Date;

  passwordHash?: string;
  passwordChangedAt?: Date;
  resetPasswordTokenHash?: string;
  resetPasswordExpires?: Date;

  failedLoginAttempts: number;
  lockUntil?: Date;
  lastLoginAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const studentSchema = new Schema<IStudent>(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName: { type: String, required: true, trim: true, maxlength: 60 },
    matricNumber: { type: String, required: true, unique: true, immutable: true, uppercase: true, trim: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true, index: true },
    level: { type: String, required: true, match: LEVEL_REGEX },
    academicSession: { type: String, required: true, match: ACADEMIC_SESSION_REGEX },

    // unique + sparse: many students may have no email yet, but set emails are unique.
    email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
    phone: { type: String, trim: true },
    sex: { type: String, enum: ["MALE", "FEMALE"] },
    profilePhoto: { type: String, trim: true },
    profilePhotoPublicId: { type: String, select: false },

    role: { type: String, enum: STUDENT_ROLES, default: "STUDENT" },
    status: { type: String, enum: STUDENT_STATUSES, default: "PENDING_ONBOARDING" },
    onboardingCompleted: { type: Boolean, default: false },
    onboardedAt: { type: Date },

    // Sensitive fields are never returned unless explicitly selected.
    passwordHash: { type: String, select: false },
    passwordChangedAt: { type: Date, select: false },
    resetPasswordTokenHash: { type: String, select: false, index: true, sparse: true },
    resetPasswordExpires: { type: Date, select: false },

    failedLoginAttempts: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, select: false },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

// Common access pattern: "all students in this department/level/session".
studentSchema.index({ department: 1, level: 1, academicSession: 1 });

export type StudentDocument = HydratedDocument<IStudent>;
export const Student = model<IStudent>("Student", studentSchema);
