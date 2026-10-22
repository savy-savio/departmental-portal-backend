import { Hod } from "../../models/Hod";
import { Student } from "../../models/Student";
import { notify, type NewNotification } from "../notification.service";
import type { NotifyPayload } from "./hod.service";

/** The department's current, active HOD (or null). */
async function currentHodId(departmentId: string): Promise<string | null> {
  const h = await Hod.findOne({ department: departmentId, isCurrent: true, status: "ACTIVE" }).select("_id");
  return h ? String(h._id) : null;
}

/** Tells the department's HOD about an event (e.g. a new complaint). Best-effort; a no-op if the department has no active HOD yet. */
export async function notifyDepartmentHod(departmentId: string, n: { kind: NewNotification["kind"]; title: string; body: string; link?: string; complaintId?: unknown }): Promise<void> {
  const hodId = await currentHodId(departmentId);
  if (!hodId) return;
  await notify({ recipient: hodId as never, recipientType: "HOD", department: departmentId as never, kind: n.kind, title: n.title, body: n.body, link: n.link, complaintId: n.complaintId as never });
}

export async function notifyDepartmentStudentsBatch(departmentId: string, levels: string[], n: NotifyPayload): Promise<void> {
  const students = await Student.find({ department: departmentId, status: "ACTIVE", ...(levels.length ? { level: { $in: levels } } : {}) }).select("_id").limit(20_000);
  const rows = students.map((s) => ({ recipient: s._id, department: departmentId as never, kind: n.kind as NewNotification["kind"], title: n.title, body: n.body, link: n.link }));
  for (let i = 0; i < rows.length; i += 1000) await notify(rows.slice(i, i + 1000));
}

/** Notifies every ACTIVE student in an election's electorate (same rules as the ballot: department, session, levels / group). */
export async function notifyElectionVoters(e: { departmentId: string; academicSession: string; electorateMode: "DEPARTMENT" | "LEVELS" | "GROUP"; eligibleLevels: string[]; eligibleStudentIds: string[] }, n: NotifyPayload): Promise<void> {
  const filter: Record<string, unknown> = { department: e.departmentId, status: "ACTIVE", academicSession: e.academicSession };
  if (e.electorateMode === "GROUP") filter._id = { $in: e.eligibleStudentIds };
  else if (e.electorateMode === "LEVELS") filter.level = { $in: e.eligibleLevels };
  const students = await Student.find(filter).select("_id").limit(20_000);
  const rows = students.map((s) => ({ recipient: s._id, department: e.departmentId as never, kind: n.kind as NewNotification["kind"], title: n.title, body: n.body, link: n.link }));
  for (let i = 0; i < rows.length; i += 1000) await notify(rows.slice(i, i + 1000));
}
