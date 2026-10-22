import { ElectionAdminService } from "../../src/services/hod/election/election.service";
import type { HodActor } from "../../src/services/hod/types";
import { ElectionMemoryStore } from "./election-memory-store";

export const CSC = "d-csc";
export const MLS = "d-mls";
export const S = "2026/2027";
export const T0 = new Date("2026-10-10T10:00:00Z");
export const hodC: HodActor = { hodId: "hodC", departmentId: CSC, firstName: "Hope", lastName: "Chief" };
export const hodM: HodActor = { hodId: "hodM", departmentId: MLS, firstName: "Mark", lastName: "Lead" };
export const meta = { ip: "41.58.0.7" };
export const mins = (n: number, from = T0) => new Date(from.getTime() + n * 60_000);
/** Smallest valid JPEG header: enough for the magic-byte check. */
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

export function makeElectionWorld() {
  const store = new ElectionMemoryStore();
  const clock = { now: new Date(T0) };
  store.sessions.set(CSC, S); store.sessions.set(MLS, S);
  store.levels.set(CSC, ["100", "200", "300", "400"]); store.levels.set(MLS, ["100", "200", "300", "400", "500"]);
  const stu = (id: string, d: string, first: string, last: string, matric: string, level: string, status: "ACTIVE" | "PENDING_ONBOARDING" | "SUSPENDED" = "ACTIVE", session = S) =>
    store.students.push({ id, departmentId: d, firstName: first, lastName: last, matricNumber: matric, level, status, academicSession: session });
  stu("ada", CSC, "Ada", "Obi", "24/208CSC/055", "200"); stu("ben", CSC, "Ben", "Musa", "24/208CSC/078", "200"); stu("cy", CSC, "Cy", "Eze", "24/208CSC/101", "200");
  stu("dee", CSC, "Dee", "Okon", "25/208CSC/300", "100"); stu("eli", CSC, "Eli", "Bako", "23/208CSC/310", "300"); stu("fay", CSC, "Fay", "Ade", "25/208CSC/400", "100", "PENDING_ONBOARDING");
  stu("gus", CSC, "Gus", "Pended", "23/208CSC/500", "300", "SUSPENDED"); stu("old", CSC, "Old", "Session", "22/208CSC/001", "400", "ACTIVE", "2025/2026");
  stu("mia", MLS, "Mia", "Bello", "25/208MLS/123", "200"); stu("zed", MLS, "Zed", "Ade", "25/208MLS/045", "300");

  const uploaded: string[] = []; const deleted: string[] = []; const notes: { election: string; title: string }[] = [];
  let n = 0;
  const svc = new ElectionAdminService({
    store, now: () => new Date(clock.now),
    uploadCandidatePhoto: async (_b, eid) => { const publicId = `cand-${eid}-${++n}`; uploaded.push(publicId); return { url: `https://cdn.example/${publicId}.jpg`, publicId }; },
    deleteCandidatePhoto: async (p) => void deleted.push(p),
    notifyVoters: async (e, note) => void notes.push({ election: e.id, title: note.title }),
  });
  /** A draft election of the CSC department with one position and approved candidates, ready to publish. */
  const ready = async (title = "CSC Election 2026", hod = hodC) => {
    const e = await svc.create(hod, { title, votingOpensAt: mins(60), votingClosesAt: mins(60 * 24) });
    const p = await svc.createPosition(hod, e.id, { title: "President" });
    const a = await svc.addCandidate(hod, e.id, { positionId: p.id, studentId: "ada", approve: true });
    const b = await svc.addCandidate(hod, e.id, { positionId: p.id, studentId: "ben", approve: true });
    return { e, p, a, b };
  };
  return { store, svc, clock, uploaded, deleted, notes, ready };
}

export async function rejection(p: Promise<unknown>): Promise<{ status: number; code?: string; message: string; details?: unknown }> {
  try { await p; } catch (e) {
    const err = e as { statusCode?: number; code?: string; message: string; details?: unknown };
    return { status: err.statusCode ?? 0, code: err.code, message: err.message, details: err.details };
  }
  throw new Error("Expected the call to be rejected, but it succeeded");
}
export const q = (over: object = {}) => ({ page: 1, limit: 20, ...over });
