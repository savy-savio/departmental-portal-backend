import { HydratedDocument, Schema, Types, model } from "mongoose";
import { LECTURER_STATUSES, LecturerStatus } from "../utils/constants";

/**
 * A lecturer account. Lecturers never self-register: the HOD phase creates the record (status INVITED) and the lecturer
 * activates it with a one-time emailed token. Role, department and staffId are immutable here; only the HOD phase can change them.
 */
export interface ILecturer {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  staffId: string;
  department: Types.ObjectId;
  role: "LECTURER";
  profilePhoto?: string;
  profilePhotoPublicId?: string;
  status: LecturerStatus;

  passwordHash?: string;
  passwordChangedAt?: Date;
  activationTokenHash?: string;
  activationExpires?: Date;
  resetPasswordTokenHash?: string;
  resetPasswordExpires?: Date;
  failedLoginAttempts: number;
  lockUntil?: Date;
  lastLoginAt?: Date;
  activatedAt?: Date;
}

const lecturerSchema = new Schema<ILecturer>(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    phone: { type: String, trim: true },
    staffId: { type: String, required: true, uppercase: true, trim: true, immutable: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true, index: true },
    role: { type: String, enum: ["LECTURER"], default: "LECTURER", immutable: true },
    profilePhoto: { type: String, trim: true },
    profilePhotoPublicId: { type: String, select: false },
    status: { type: String, enum: LECTURER_STATUSES, default: "INVITED" },

    passwordHash: { type: String, select: false },
    passwordChangedAt: { type: Date, select: false },
    activationTokenHash: { type: String, select: false, index: true, sparse: true },
    activationExpires: { type: Date, select: false },
    resetPasswordTokenHash: { type: String, select: false, index: true, sparse: true },
    resetPasswordExpires: { type: Date, select: false },
    failedLoginAttempts: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, select: false },
    lastLoginAt: Date,
    activatedAt: Date,
  },
  { timestamps: true },
);
// Staff ids are unique within a department (different departments may number their staff independently).
lecturerSchema.index({ department: 1, staffId: 1 }, { unique: true });

export type LecturerDocument = HydratedDocument<ILecturer>;
export const Lecturer = model<ILecturer>("Lecturer", lecturerSchema);
