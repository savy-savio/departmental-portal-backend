import { HydratedDocument, Schema, Types, model } from "mongoose";
import { HOD_STATUSES } from "../utils/constants";

/**
 * A department head's account. There is NO public signup: only the system provisioning service creates one (status INVITED) and the
 * HOD activates it with a one-time emailed token. Role, department and staffId are immutable. A department has exactly one CURRENT HOD.
 */
export interface IHod {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  staffId: string;
  department: Types.ObjectId;
  role: "HOD";
  profilePhoto?: string;
  profilePhotoPublicId?: string;
  status: (typeof HOD_STATUSES)[number];
  /** true for the sitting HOD. A replaced HOD is kept for history with isCurrent=false (and can no longer log in). */
  isCurrent: boolean;

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

const hodSchema = new Schema<IHod>(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    phone: { type: String, trim: true },
    staffId: { type: String, required: true, uppercase: true, trim: true, immutable: true },
    department: { type: Schema.Types.ObjectId, ref: "Department", required: true, immutable: true, index: true },
    role: { type: String, enum: ["HOD"], default: "HOD", immutable: true },
    profilePhoto: { type: String, trim: true },
    profilePhotoPublicId: { type: String, select: false },
    status: { type: String, enum: HOD_STATUSES, default: "INVITED" },
    isCurrent: { type: Boolean, default: true },

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
hodSchema.index({ department: 1, staffId: 1 }, { unique: true });
// One sitting HOD per department.
hodSchema.index({ department: 1 }, { unique: true, partialFilterExpression: { isCurrent: true } });

export type HodDocument = HydratedDocument<IHod>;
export const Hod = model<IHod>("Hod", hodSchema);
