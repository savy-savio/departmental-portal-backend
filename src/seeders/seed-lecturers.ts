import path from "node:path";
import { z } from "zod";
import { connectDatabase, disconnectDatabase } from "../config/db";
import { env } from "../config/env";
import { AcademicTerm } from "../models/AcademicTerm";
import { Course } from "../models/Course";
import { Department } from "../models/Department";
import { Lecturer } from "../models/Lecturer";
import { LecturerCourseAssignment } from "../models/LecturerCourseAssignment";
import { assignLecturerToCourse, createLecturerAccount } from "../services/lecturer/account.service";
import { normalizeCourseCode } from "../utils/course";
import { logger } from "../utils/logger";
import { failWith, readJson, reportAndExit } from "./seed-helpers";

const entry = z.object({
  departmentCode: z.string().min(2),
  staffId: z.string().min(2),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  courses: z.array(z.string().min(5)).default([]),
});

/**
 * Stand-in for the HOD "create lecturer / assign to course" screens. Acts as each department's HOD through the same services the
 * HOD phase will call, so every rule applies (same-department only, current-term courses, no duplicates).
 * New lecturers start INVITED: this prints the one-time activation link (and emails it when Resend is configured).
 * Idempotent: existing lecturers are kept; missing course assignments are added.
 */
async function run() {
  const file = process.argv[2] ?? path.resolve(process.cwd(), "seeds/lecturers.json");
  const parsed = z.array(entry).safeParse(readJson(file));
  if (!parsed.success) return reportAndExit(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));

  await connectDatabase();
  const errors: string[] = [];
  for (const [i, e] of parsed.data.entries()) {
    const dept = await Department.findOne({ code: e.departmentCode.toUpperCase() });
    if (!dept) { errors.push(`#${i}: unknown department "${e.departmentCode}"`); continue; }
    const hod = { name: "Seed script", role: "HOD" as const, departmentId: String(dept._id) };

    let lecturer = await Lecturer.findOne({ email: e.email.toLowerCase() });
    if (lecturer && String(lecturer.department) !== String(dept._id)) { errors.push(`#${i}: ${e.email} already exists in another department`); continue; }
    if (!lecturer) {
      try {
        const created = await createLecturerAccount(hod, { firstName: e.firstName, lastName: e.lastName, email: e.email, phone: e.phone, staffId: e.staffId }, { returnToken: true });
        lecturer = created.lecturer;
        logger.info(`Created lecturer ${e.email} (${dept.code}). Activation link: ${env.clientUrl}/lecturer/activate?token=${created.activationToken}`);
      } catch (err) { errors.push(`#${i} ${e.email}: ${err instanceof Error ? err.message : err}`); continue; }
    }

    const term = await AcademicTerm.findOne({ department: dept._id, isCurrent: true });
    if (e.courses.length && !term) { errors.push(`#${i}: ${dept.code} has no current term (run seed:terms)`); continue; }
    for (const code of e.courses) {
      const course = await Course.findOne({ department: dept._id, courseCode: normalizeCourseCode(code), academicSession: term!.academicSession, semester: term!.semester });
      if (!course) { errors.push(`#${i}: course ${code} not in ${dept.code}'s current catalogue`); continue; }
      if (await LecturerCourseAssignment.exists({ lecturer: lecturer._id, course: course._id, status: "ACTIVE" })) continue;
      try { await assignLecturerToCourse(hod, { lecturerId: String(lecturer._id), courseId: String(course._id) }); logger.info(`Assigned ${e.email} to ${course.courseCode}`); }
      catch (err) { errors.push(`#${i} ${e.email} ${code}: ${err instanceof Error ? err.message : err}`); }
    }
  }
  await disconnectDatabase();
  if (errors.length) reportAndExit(errors);
}
run().catch(failWith);
