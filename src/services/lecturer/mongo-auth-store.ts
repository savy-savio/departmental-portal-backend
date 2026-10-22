import { Department } from "../../models/Department";
import type { Lecturer, LecturerDocument } from "../../models/Lecturer";
import type { AuthLecturerRow, LecturerAuthStore } from "./auth.service";

const SELECT = "+passwordHash +passwordChangedAt +activationTokenHash +activationExpires +resetPasswordTokenHash +resetPasswordExpires +failedLoginAttempts +lockUntil";
const toRow = (l: LecturerDocument & { isCurrent?: boolean }): AuthLecturerRow => ({
  id: String(l._id), firstName: l.firstName, lastName: l.lastName, email: l.email, phone: l.phone ?? undefined, staffId: l.staffId,
  departmentId: String(l.department), role: l.role, profilePhoto: l.profilePhoto ?? undefined,
  // a replaced HOD (isCurrent=false) is treated as suspended: they can no longer sign in
  status: l.isCurrent === false ? "SUSPENDED" : l.status,
  passwordHash: l.passwordHash ?? undefined, passwordChangedAt: l.passwordChangedAt ?? undefined,
  activationTokenHash: l.activationTokenHash ?? undefined, activationExpires: l.activationExpires ?? undefined,
  resetPasswordTokenHash: l.resetPasswordTokenHash ?? undefined, resetPasswordExpires: l.resetPasswordExpires ?? undefined,
  failedLoginAttempts: l.failedLoginAttempts ?? 0, lockUntil: l.lockUntil ?? undefined,
});
const one = async (q: Promise<LecturerDocument | null>) => { const l = await q; return l ? toRow(l) : null; };

/** Shared by lecturers and HODs: pass the Mongoose model of the account collection. */
export class MongoLecturerAuthStore implements LecturerAuthStore {
  constructor(private readonly Model: typeof Lecturer) {}
  findByEmail(email: string) { return one(this.Model.findOne({ email: email.toLowerCase() }).select(SELECT)); }
  findById(id: string) { return one(this.Model.findById(id).select(SELECT)); }
  findByActivationHash(hash: string) { return one(this.Model.findOne({ activationTokenHash: hash }).select(SELECT)); }
  findByResetHash(hash: string) { return one(this.Model.findOne({ resetPasswordTokenHash: hash }).select(SELECT)); }
  async update(id: string, set: Partial<Omit<AuthLecturerRow, "id">>, unset: (keyof AuthLecturerRow)[] = []) {
    const { departmentId: _d, role: _r, staffId: _s, email: _e, ...safe } = set as Record<string, unknown>; // never writable from the auth flow
    await this.Model.updateOne({ _id: id }, { $set: safe, ...(unset.length ? { $unset: Object.fromEntries(unset.map((k) => [k, ""])) } : {}) });
  }
  async consumeToken(id: string, field: "activationTokenHash" | "resetPasswordTokenHash", hash: string) {
    const r = await this.Model.updateOne({ _id: id, [field]: hash }, { $unset: { [field]: "" } }); // atomic: only one caller wins
    return r.modifiedCount === 1;
  }
  async getDepartment(id: string) {
    const d = await Department.findById(id);
    return d ? { id: String(d._id), name: d.name, code: d.code, isActive: d.isActive } : null;
  }
}
