import path from "node:path";
import { z } from "zod";
import { connectDatabase, disconnectDatabase } from "../config/db";
import { AcademicTerm } from "../models/AcademicTerm";
import { CourseRepresentativeAssignment } from "../models/CourseRepresentativeAssignment";
import { Department } from "../models/Department";
import { Student } from "../models/Student";
import { parseMatricNumber } from "../services/matric.service";
import { assignRepresentative } from "../services/representative/assignment.service";
import { REP_ROLES } from "../utils/constants";
import { logger } from "../utils/logger";
import { failWith, readJson, reportAndExit } from "./seed-helpers";

const entry = z.object({
  departmentCode: z.string().min(2),
  matricNumber: z.string().min(5),
  level: z.string().regex(/^[1-9]\d{2}$/, 'Level must look like "200"'),
  role: z.enum(REP_ROLES),
});

/**
 * Stand-in for the HOD "assign representative" screen. Acts as that department's HOD (via the same service the HOD phase will call,
 * so every business rule applies). Idempotent: an identical ACTIVE assignment is left alone.
 * Students must already be seeded AND onboarded (status ACTIVE).
 */
async function run() {
  const file = process.argv[2] ?? path.resolve(process.cwd(), "seeds/representatives.json");
  const parsed = z.array(entry).safeParse(readJson(file));
  if (!parsed.success) return reportAndExit(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));

  await connectDatabase();
  const errors: string[] = [];
  for (const [i, e] of parsed.data.entries()) {
    const dept = await Department.findOne({ code: e.departmentCode.toUpperCase() });
    if (!dept) { errors.push(`#${i}: unknown department "${e.departmentCode}"`); continue; }
    const term = await AcademicTerm.findOne({ department: dept._id, isCurrent: true });
    if (!term) { errors.push(`#${i}: ${dept.code} has no current term (run seed:terms)`); continue; }
    const student = await Student.findOne({ matricNumber: parseMatricNumber(e.matricNumber)?.normalized ?? e.matricNumber });
    if (!student) { errors.push(`#${i}: student ${e.matricNumber} not found`); continue; }

    const existing = await CourseRepresentativeAssignment.findOne({ student: student._id, scope: "LEVEL", level: e.level, academicSession: term.academicSession, semester: term.semester, status: "ACTIVE" });
    if (existing?.role === e.role) { logger.info(`Already assigned: ${e.matricNumber} ${e.role} ${e.level} Level`); continue; }
    try {
      await assignRepresentative({ name: "Seed script", role: "HOD", departmentId: String(dept._id) }, { studentId: String(student._id), level: e.level, role: e.role });
      logger.info(`Assigned ${e.matricNumber} as ${e.role} for ${e.level} Level (${dept.code})`);
    } catch (err) {
      errors.push(`#${i} ${e.matricNumber}: ${err instanceof Error ? err.message : err}`);
    }
  }
  await disconnectDatabase();
  if (errors.length) reportAndExit(errors);
}
run().catch(failWith);
