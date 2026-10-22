import { AttendanceRecord } from "../models/AttendanceRecord";
import { AttendanceSession, AttendanceSessionDocument } from "../models/AttendanceSession";
import type { DepartmentDocument } from "../models/Department";
import type { StudentDocument } from "../models/Student";
import { loadStudentContext } from "./student-context.service";

type SessionState = "UPCOMING" | "OPEN" | "CLOSED";
const stateOf = (s: { opensAt: Date; closesAt: Date; status?: string }, now: Date): SessionState =>
  s.status === "CLOSED" || now > s.closesAt ? "CLOSED" : now < s.opensAt ? "UPCOMING" : "OPEN";

function sessionDTO(
  s: AttendanceSessionDocument,
  record: { status: string; markedAt: Date } | undefined,
  requiresCode: boolean,
  requiresLocation: boolean,
  now: Date,
) {
  const state = stateOf(s, now);
  return {
    id: String(s._id),
    courseCode: s.courseCode,
    title: s.title,
    opensAt: s.opensAt,
    closesAt: s.closesAt,
    state,
    requiresCode,
    requiresLocation,
    marked: Boolean(record),
    // A closed session you didn't mark is an absence; upcoming/open ones are still undecided.
    attendance: record ? record.status : state === "CLOSED" ? "ABSENT" : null,
    markedAt: record?.markedAt ?? null,
  };
}

export async function listAttendance(student: StudentDocument, department: DepartmentDocument, courseCode?: string) {
  const { term, enrolledCodes } = await loadStudentContext(student, department);
  if (!term) return { term: null, sessions: [], summary: [] };

  const codes = courseCode ? enrolledCodes.filter((c) => c === courseCode) : enrolledCodes;
  const sessions = await AttendanceSession.find({
    department: department._id,
    courseCode: { $in: codes },
    academicSession: term.academicSession,
    semester: term.semester,
    status: { $in: ["ACTIVE", "CLOSED"] }, // early-closed sessions still count as held (an unmarked one is an absence)
  })
    .select("+codeHash")
    .sort({ opensAt: -1 });

  const records = await AttendanceRecord.find({ student: student._id, session: { $in: sessions.map((s) => s._id) } });
  const byId = new Map<string, { status: string; markedAt: Date }>(records.map((r) => [String(r.session), r]));
  const now = new Date();

  const items = sessions.map((s) => sessionDTO(s, byId.get(String(s._id)), Boolean(s.codeHash), s.location?.latitude != null, now));

  // Per-course summary over sessions that have actually started.
  const summary = codes.map((code) => {
    const held = items.filter((i) => i.courseCode === code && i.state !== "UPCOMING");
    const attended = held.filter((i) => i.marked).length;
    return {
      courseCode: code,
      sessionsHeld: held.length,
      attended,
      absent: held.filter((i) => i.attendance === "ABSENT").length,
      percentage: held.length ? Math.round((attended / held.length) * 100) : null,
    };
  });
  return { term: { academicSession: term.academicSession, semester: term.semester }, sessions: items, summary };
}
