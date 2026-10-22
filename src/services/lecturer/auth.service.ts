import { AppError } from "../../utils/AppError";
import { sha256 } from "../../utils/crypto";
import { LOGIN_LOCK_MINUTES, MAX_FAILED_LOGINS } from "../../utils/constants";
import type { LecturerActor, LecturerRec } from "./types";

/** A staff account row (lecturer or HOD). `role` is a plain string so the SAME engine serves both roles without sharing any data. */
export interface AuthLecturerRow extends Omit<LecturerRec, "role"> {
  role: string;
  passwordHash?: string;
  passwordChangedAt?: Date;
  activationTokenHash?: string;
  activationExpires?: Date;
  resetPasswordTokenHash?: string;
  resetPasswordExpires?: Date;
  failedLoginAttempts: number;
  lockUntil?: Date;
}
export interface LecturerAuthStore {
  findByEmail(email: string): Promise<AuthLecturerRow | null>;
  findById(id: string): Promise<AuthLecturerRow | null>;
  findByActivationHash(hash: string): Promise<AuthLecturerRow | null>;
  findByResetHash(hash: string): Promise<AuthLecturerRow | null>;
  update(id: string, set: Partial<Omit<AuthLecturerRow, "id">>, unset?: (keyof AuthLecturerRow)[]): Promise<void>;
  /** Atomically consumes a one-time token: true only if it was still present (stops two parallel uses). */
  consumeToken(id: string, field: "activationTokenHash" | "resetPasswordTokenHash", hash: string): Promise<boolean>;
  getDepartment(id: string): Promise<{ id: string; name: string; code: string; isActive: boolean } | null>;
}
export interface LecturerAuthDeps {
  store: LecturerAuthStore;
  now: () => Date;
  hashPassword: (plain: string) => Promise<string>;
  verifyPassword: (plain: string, hash: string) => Promise<boolean>;
  /** Spends the same time as a real comparison when the account doesn't exist (no email enumeration by timing). */
  fakePasswordCheck: (plain: string) => Promise<void>;
  signAccessToken: (lecturerId: string) => string;
  /** Throws AppError(401) for bad / expired / wrong-audience tokens (a STUDENT token must not verify here). */
  verifyAccessToken: (token: string) => { lecturerId: string; issuedAt: number };
  generateToken: () => string;
  /** Role this instance serves (default LECTURER). A HOD instance uses "HOD" with its own store and token audience. */
  role?: string;
  notRoleCode?: string;
  resetTtlMinutes: number;
  sendResetEmail: (to: string, firstName: string, rawToken: string) => Promise<void>;
}

const INVALID = "Invalid email or password.";
const RESET_INVALID = "This link is invalid or has expired.";

/** Lecturer authentication. Lecturers never self-register: an INVITED account is activated with a one-time token the HOD flow emails. */
export class LecturerAuthService {
  constructor(private readonly d: LecturerAuthDeps) {}

  private get role(): string { return this.d.role ?? "LECTURER"; }

  private async dept(lecturer: { departmentId: string }) {
    const dept = await this.d.store.getDepartment(lecturer.departmentId);
    if (!dept || !dept.isActive) throw new AppError(403, "Your department is not currently active on the portal.", undefined, "DEPARTMENT_INACTIVE");
    return dept;
  }
  private publicLecturer(l: AuthLecturerRow, dept: { id: string; name: string; code: string }) {
    return { id: l.id, firstName: l.firstName, lastName: l.lastName, email: l.email, staffId: l.staffId, role: l.role, status: l.status, profilePhoto: l.profilePhoto ?? null, department: { id: dept.id, name: dept.name, code: dept.code } };
  }

  async login(email: string, password: string) {
    const l = await this.d.store.findByEmail(email);
    if (!l || !l.passwordHash) {
      await this.d.fakePasswordCheck(password);
      throw new AppError(401, INVALID, undefined, "INVALID_CREDENTIALS");
    }
    const now = this.d.now();
    if (l.lockUntil && l.lockUntil > now) {
      const mins = Math.ceil((l.lockUntil.getTime() - now.getTime()) / 60_000);
      throw new AppError(429, `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`, undefined, "ACCOUNT_LOCKED");
    }
    if (!(await this.d.verifyPassword(password, l.passwordHash))) {
      const attempts = (l.failedLoginAttempts ?? 0) + 1;
      if (attempts >= MAX_FAILED_LOGINS) await this.d.store.update(l.id, { failedLoginAttempts: 0, lockUntil: new Date(now.getTime() + LOGIN_LOCK_MINUTES * 60_000) });
      else await this.d.store.update(l.id, { failedLoginAttempts: attempts });
      throw new AppError(401, INVALID, undefined, "INVALID_CREDENTIALS");
    }
    // Account state is only revealed to someone who proved they own the account.
    if (l.status === "INVITED") throw new AppError(403, "Activate your account with the link from your invitation email first.", undefined, "ACCOUNT_NOT_ACTIVATED");
    if (l.status !== "ACTIVE") throw new AppError(403, "Your account is not active. Contact your department.", undefined, "ACCOUNT_INACTIVE");
    const dept = await this.dept(l);
    await this.d.store.update(l.id, { failedLoginAttempts: 0, lastLoginAt: now } as never, ["lockUntil"]);
    return { token: this.d.signAccessToken(l.id), lecturer: this.publicLecturer(l, dept) };
  }

  /** Validates a bearer token and loads the lecturer fresh from the database (role, status and department are never taken from the token). */
  async authenticate(token: string): Promise<{ actor: LecturerActor; lecturer: AuthLecturerRow; department: { id: string; name: string; code: string } }> {
    const { lecturerId, issuedAt } = this.d.verifyAccessToken(token);
    const l = await this.d.store.findById(lecturerId);
    if (!l) throw new AppError(401, "Invalid authentication token.", undefined, "TOKEN_INVALID");
    if (l.passwordChangedAt && Math.floor(l.passwordChangedAt.getTime() / 1000) > issuedAt) throw new AppError(401, "Your password was changed. Please log in again.", undefined, "PASSWORD_CHANGED");
    if (l.role !== this.role) throw new AppError(403, "Access denied for this account type.", undefined, this.d.notRoleCode ?? "NOT_A_LECTURER");
    if (l.status !== "ACTIVE") throw new AppError(403, "Your account is not active. Contact your department.", undefined, "ACCOUNT_INACTIVE");
    const dept = await this.dept(l);
    return { actor: { lecturerId: l.id, departmentId: l.departmentId, firstName: l.firstName, lastName: l.lastName }, lecturer: l, department: dept };
  }

  async activate(rawToken: string, password: string) {
    const hash = sha256(rawToken);
    const l = await this.d.store.findByActivationHash(hash);
    if (!l || !l.activationExpires || l.activationExpires <= this.d.now() || l.status !== "INVITED") throw new AppError(400, "This activation link is invalid or has expired.", undefined, "ACTIVATION_INVALID");
    const passwordHash = await this.d.hashPassword(password);
    if (!(await this.d.store.consumeToken(l.id, "activationTokenHash", hash))) throw new AppError(400, "This activation link is invalid or has expired.", undefined, "ACTIVATION_INVALID");
    await this.d.store.update(l.id, { passwordHash, passwordChangedAt: this.d.now(), status: "ACTIVE", activatedAt: this.d.now() } as never, ["activationExpires"]);
    const dept = await this.dept(l);
    return { token: this.d.signAccessToken(l.id), lecturer: this.publicLecturer({ ...l, status: "ACTIVE" }, dept) };
  }

  /** Always resolves quietly: the response is identical whether or not the email exists. */
  async forgotPassword(email: string): Promise<void> {
    const l = await this.d.store.findByEmail(email);
    if (!l || l.status !== "ACTIVE") return;
    const raw = this.d.generateToken();
    await this.d.store.update(l.id, { resetPasswordTokenHash: sha256(raw), resetPasswordExpires: new Date(this.d.now().getTime() + this.d.resetTtlMinutes * 60_000) });
    await this.d.sendResetEmail(l.email, l.firstName, raw).catch(() => undefined);
  }

  async resetPassword(rawToken: string, password: string): Promise<void> {
    const hash = sha256(rawToken);
    const l = await this.d.store.findByResetHash(hash);
    if (!l || !l.resetPasswordExpires || l.resetPasswordExpires <= this.d.now() || l.status !== "ACTIVE") throw new AppError(400, RESET_INVALID, undefined, "RESET_INVALID");
    const passwordHash = await this.d.hashPassword(password);
    if (!(await this.d.store.consumeToken(l.id, "resetPasswordTokenHash", hash))) throw new AppError(400, RESET_INVALID, undefined, "RESET_INVALID");
    await this.d.store.update(l.id, { passwordHash, passwordChangedAt: this.d.now(), failedLoginAttempts: 0 }, ["resetPasswordExpires", "lockUntil"]);
  }

  async changePassword(lecturerId: string, current: string, next: string) {
    const l = await this.d.store.findById(lecturerId);
    if (!l?.passwordHash) throw new AppError(401, "Authentication required.");
    if (!(await this.d.verifyPassword(current, l.passwordHash))) throw new AppError(400, "Your current password is incorrect.", undefined, "CURRENT_PASSWORD_INCORRECT");
    if (await this.d.verifyPassword(next, l.passwordHash)) throw new AppError(400, "Your new password must be different from the current one.");
    const now = this.d.now();
    await this.d.store.update(l.id, { passwordHash: await this.d.hashPassword(next), passwordChangedAt: now });
    return { token: this.d.signAccessToken(l.id) };
  }
}
