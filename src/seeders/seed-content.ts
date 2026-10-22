import path from "node:path";
import { z } from "zod";
import { connectDatabase, disconnectDatabase } from "../config/db";
import { Announcement } from "../models/Announcement";
import { Assignment } from "../models/Assignment";
import { AttendanceSession } from "../models/AttendanceSession";
import { Department } from "../models/Department";
import { Material } from "../models/Material";
import { Student } from "../models/Student";
import { TimetableEntry } from "../models/TimetableEntry";
import { hashAttendanceCode } from "../utils/crypto";
import { parseMatricNumber } from "../services/matric.service";
import {
  ACADEMIC_SESSION_REGEX, ANNOUNCEMENT_PRIORITIES, ANNOUNCEMENT_SCOPES, ASSIGNMENT_STATUSES, DAYS_OF_WEEK,
  LEVEL_REGEX, MATERIAL_TYPES, SEMESTERS, TIMETABLE_TYPES, TIME_REGEX,
} from "../utils/constants";
import { logger } from "../utils/logger";
import { failWith, readJson, reportAndExit } from "./seed-helpers";

const dept = z.string().trim().min(2);
const level = z.string().regex(LEVEL_REGEX);
const session = z.string().regex(ACADEMIC_SESSION_REGEX);
const code = z.string().trim().min(5);

const timetable = z.object({
  departmentCode: dept, level, academicSession: session, semester: z.enum(SEMESTERS),
  courseCode: code.optional(), title: z.string().min(2), type: z.enum(TIMETABLE_TYPES).default("LECTURE"),
  dayOfWeek: z.enum(DAYS_OF_WEEK), startTime: z.string().regex(TIME_REGEX), endTime: z.string().regex(TIME_REGEX),
  venue: z.string().optional(), lecturerName: z.string().optional(),
});
const announcement = z.object({
  departmentCode: dept, title: z.string().min(2), body: z.string().min(2),
  priority: z.enum(ANNOUNCEMENT_PRIORITIES).default("NORMAL"),
  scope: z.enum(ANNOUNCEMENT_SCOPES),
  levels: z.array(level).optional(), academicSession: session.optional(),
  courseCodes: z.array(code).optional(), studentMatricNumbers: z.array(z.string()).optional(),
  createdByName: z.string().default("Department Office"), createdByRole: z.string().default("HOD"),
  publishedAt: z.coerce.date().optional(), expiresAt: z.coerce.date().optional(),
});
const material = z.object({
  departmentCode: dept, title: z.string().min(2), description: z.string().optional(),
  type: z.enum(MATERIAL_TYPES), courseCode: code.optional(), level, semester: z.enum(SEMESTERS), academicSession: session,
  sharedWith: z.array(z.object({ departmentCode: dept, levels: z.array(level).optional() })).default([]),
  file: z.object({ url: z.string().url(), originalName: z.string(), mimeType: z.string(), sizeBytes: z.number().min(0) }),
  uploadedByName: z.string().default("Course Lecturer"), uploadedByRole: z.string().default("LECTURER"),
});
const assignment = z.object({
  departmentCode: dept, courseCode: code, title: z.string().min(2), instructions: z.string().min(2),
  level, academicSession: session, semester: z.enum(SEMESTERS), dueAt: z.coerce.date(),
  maxScore: z.number().min(1).default(100), allowLateSubmission: z.boolean().default(false),
  status: z.enum(ASSIGNMENT_STATUSES).default("PUBLISHED"),
  createdByName: z.string().default("Course Lecturer"), createdByRole: z.string().default("LECTURER"),
});
const attendanceSession = z.object({
  departmentCode: dept, courseCode: code, level, academicSession: session, semester: z.enum(SEMESTERS),
  title: z.string().min(2),
  /** Relative times so a re-seed re-opens the session: opens `startsInMinutes` from now (negative = already started). */
  startsInMinutes: z.number().default(0), durationMinutes: z.number().min(1).default(60),
  lateAfterMinutes: z.number().min(0).default(15),
  /** Class location; sample coordinates only, replace with your real lecture-hall coordinates. */
  latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(), allowedRadiusInMeters: z.number().min(10).max(1000).optional(),
  code: z.string().min(1).max(20).optional(),
  createdByName: z.string().default("Course Lecturer"), createdByRole: z.string().default("LECTURER"),
});
const file = z.object({
  attendanceSessions: z.array(attendanceSession).default([]),
  timetable: z.array(timetable).default([]), announcements: z.array(announcement).default([]),
  materials: z.array(material).default([]), assignments: z.array(assignment).default([]),
});

/**
 * Sample-content seeder: stands in for the lecturer / course-rep / HOD upload features of later phases.
 * Validates everything first (unknown department, level the department doesn't offer, unknown student),
 * then upserts on natural keys so it can be re-run.
 */
async function run() {
  const filePath = process.argv[2] ?? path.resolve(process.cwd(), "seeds/academic-content.json");
  const parsed = file.safeParse(readJson(filePath));
  if (!parsed.success) return reportAndExit(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const data = parsed.data;

  await connectDatabase();
  const departments = new Map((await Department.find()).map((d) => [d.code, d]));
  const errors: string[] = [];
  const getDept = (c: string, where: string, lvl?: string) => {
    const d = departments.get(c.toUpperCase());
    if (!d) errors.push(`${where}: unknown department "${c}"`);
    else if (lvl && !d.levels.includes(lvl)) errors.push(`${where}: level ${lvl} not offered by ${d.name}`);
    return d;
  };

  const matrics = data.announcements.flatMap((a) => a.studentMatricNumbers ?? []).map((m) => parseMatricNumber(m)?.normalized ?? m);
  const students = new Map((await Student.find({ matricNumber: { $in: matrics } }).select("matricNumber department")).map((s) => [s.matricNumber, s]));

  data.attendanceSessions.forEach((a, i) => getDept(a.departmentCode, `attendance session #${i}`, a.level));
  data.timetable.forEach((t, i) => getDept(t.departmentCode, `timetable #${i}`, t.level));
  data.assignments.forEach((a, i) => getDept(a.departmentCode, `assignment #${i}`, a.level));
  data.materials.forEach((m, i) => {
    getDept(m.departmentCode, `material #${i}`, m.level);
    m.sharedWith.forEach((s) => getDept(s.departmentCode, `material #${i} sharedWith`));
  });
  data.announcements.forEach((a, i) => {
    const d = getDept(a.departmentCode, `announcement #${i}`);
    a.levels?.forEach((l) => d && !d.levels.includes(l) && errors.push(`announcement #${i}: level ${l} not offered by ${d.name}`));
    if (a.scope === "LEVEL" && !a.levels?.length) errors.push(`announcement #${i}: LEVEL scope needs levels`);
    if (a.scope === "CLASS" && (!a.levels?.length || !a.academicSession)) errors.push(`announcement #${i}: CLASS scope needs levels and academicSession`);
    if (a.scope === "COURSE" && !a.courseCodes?.length) errors.push(`announcement #${i}: COURSE scope needs courseCodes`);
    if (a.scope === "GROUP") {
      if (!a.studentMatricNumbers?.length) errors.push(`announcement #${i}: GROUP scope needs studentMatricNumbers`);
      for (const m of a.studentMatricNumbers ?? []) {
        const s = students.get(parseMatricNumber(m)?.normalized ?? m);
        if (!s) errors.push(`announcement #${i}: student ${m} not found (seed students first)`);
        else if (d && String(s.department) !== String(d._id)) errors.push(`announcement #${i}: student ${m} is not in ${d.code}`);
      }
    }
  });
  if (errors.length) {
    await disconnectDatabase();
    return reportAndExit(errors);
  }

  for (const t of data.timetable) {
    const { departmentCode, ...rest } = t;
    const department = departments.get(departmentCode.toUpperCase())!._id;
    await TimetableEntry.findOneAndUpdate(
      { department, level: t.level, academicSession: t.academicSession, semester: t.semester, dayOfWeek: t.dayOfWeek, startTime: t.startTime, title: t.title },
      { $set: { ...rest, department } }, { upsert: true, runValidators: true },
    );
  }
  for (const a of data.announcements) {
    const { departmentCode, studentMatricNumbers, levels, academicSession, courseCodes, scope, ...rest } = a;
    const department = departments.get(departmentCode.toUpperCase())!._id;
    const studentIds = (studentMatricNumbers ?? []).map((m) => students.get(parseMatricNumber(m)?.normalized ?? m)!._id);
    await Announcement.findOneAndUpdate(
      { department, title: a.title },
      { $set: { ...rest, department, status: "PUBLISHED", publishedAt: a.publishedAt ?? new Date(), audience: { scope, levels, academicSession, courseCodes, studentIds: studentIds.length ? studentIds : undefined } } },
      { upsert: true, runValidators: true },
    );
  }
  for (const m of data.materials) {
    const { departmentCode, sharedWith, ...rest } = m;
    const department = departments.get(departmentCode.toUpperCase())!._id;
    await Material.findOneAndUpdate(
      { department, title: m.title, courseCode: m.courseCode, academicSession: m.academicSession },
      { $set: { ...rest, department, status: "PUBLISHED", sharedWith: sharedWith.map((s) => ({ department: departments.get(s.departmentCode.toUpperCase())!._id, levels: s.levels })) } },
      { upsert: true, runValidators: true },
    );
  }
  for (const a of data.assignments) {
    const { departmentCode, ...rest } = a;
    const department = departments.get(departmentCode.toUpperCase())!._id;
    await Assignment.findOneAndUpdate(
      { department, courseCode: a.courseCode.toUpperCase().replace(/\s+/g, ""), title: a.title, academicSession: a.academicSession, semester: a.semester },
      { $set: { ...rest, department } }, { upsert: true, runValidators: true },
    );
  }
  for (const a of data.attendanceSessions) {
    const { departmentCode, startsInMinutes, durationMinutes, code: attendanceCode, latitude, longitude, allowedRadiusInMeters, ...rest } = a;
    const department = departments.get(departmentCode.toUpperCase())!._id;
    const opensAt = new Date(Date.now() + startsInMinutes * 60_000);
    await AttendanceSession.findOneAndUpdate(
      { department, courseCode: a.courseCode.toUpperCase().replace(/\s+/g, ""), title: a.title, academicSession: a.academicSession, semester: a.semester },
      {
        $set: { ...rest, department, opensAt, closesAt: new Date(opensAt.getTime() + durationMinutes * 60_000), status: "ACTIVE", ...(latitude !== undefined && longitude !== undefined && allowedRadiusInMeters !== undefined ? { location: { latitude, longitude, allowedRadiusInMeters } } : {}), ...(attendanceCode ? { codeHash: hashAttendanceCode(attendanceCode) } : {}) },
        ...(attendanceCode ? {} : { $unset: { codeHash: "" } }),
      },
      { upsert: true, runValidators: true },
    );
  }
  logger.info(`Content seeded: ${data.attendanceSessions.length} attendance sessions, ${data.timetable.length} timetable, ${data.announcements.length} announcements, ${data.materials.length} materials, ${data.assignments.length} assignments.`);
  await disconnectDatabase();
}
run().catch(failWith);
