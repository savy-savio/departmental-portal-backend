import { Department } from "../../models/Department";
import { Hod } from "../../models/Hod";
import { HodAuditLog } from "../../models/HodAuditLog";
import { AppError } from "../../utils/AppError";
import { generateToken, sha256 } from "../../utils/crypto";
import { sendHodInviteEmail, sendInBackground } from "../email.service";
import { authorizeProvisioner, type Provisioner } from "./policy";

const INVITE_HOURS = 72;

/**
 * System-level provisioning of a department head. NOT reachable over HTTP: it is called by the provisioning script (and later by the SUPER_ADMIN phase).
 * There is no public HOD signup, and a HOD can never create or promote another HOD (authorizeProvisioner).
 * The department comes from the trusted operator's input here; for a HOD themselves it is then immutable.
 * One CURRENT HOD per department (unique partial index); replacing a HOD means marking the old record isCurrent=false first (system admin phase).
 */
export async function createHodAccount(
  provisioner: Provisioner,
  input: { departmentCode: string; firstName: string; lastName: string; email: string; phone?: string; staffId: string },
  opts: { sendEmail?: boolean; returnToken?: boolean } = {},
) {
  const verdict = authorizeProvisioner(provisioner);
  if (!verdict.ok) throw new AppError(403, verdict.reason, undefined, "PROVISIONER_NOT_AUTHORIZED");
  const dept = await Department.findOne({ code: input.departmentCode.toUpperCase() });
  if (!dept || !dept.isActive) throw new AppError(404, "Department not found or inactive.");

  const raw = generateToken(32);
  try {
    const hod = await Hod.create({
      firstName: input.firstName, lastName: input.lastName, email: input.email, phone: input.phone, staffId: input.staffId, department: dept._id,
      status: "INVITED", isCurrent: true, activationTokenHash: sha256(raw), activationExpires: new Date(Date.now() + INVITE_HOURS * 3_600_000),
    });
    await HodAuditLog.create({ actorName: provisioner.name, role: provisioner.role, action: "HOD_ACCOUNT_CREATED", resourceType: "HOD", resourceId: String(hod._id), department: dept._id, detail: { staffId: hod.staffId }, at: new Date() });
    if (opts.sendEmail !== false) sendInBackground("hod-invite", sendHodInviteEmail(hod.email, hod.firstName, raw, INVITE_HOURS));
    return { hod, ...(opts.returnToken ? { activationToken: raw } : {}) }; // the raw token goes to a trusted caller only
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new AppError(409, "That department already has a current HOD, or the email / staff ID is taken.", undefined, "HOD_DUPLICATE");
    throw e;
  }
}
