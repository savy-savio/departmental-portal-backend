import path from "node:path";
import { z } from "zod";
import { connectDatabase, disconnectDatabase } from "../config/db";
import { AcademicTerm } from "../models/AcademicTerm";
import { Department } from "../models/Department";
import { ACADEMIC_SESSION_REGEX, SEMESTERS } from "../utils/constants";
import { logger } from "../utils/logger";
import { failWith, readJson, reportAndExit } from "./seed-helpers";

const entry = z.object({
  departmentCode: z.string().trim().min(2),
  academicSession: z.string().regex(ACADEMIC_SESSION_REGEX),
  semester: z.enum(SEMESTERS),
  isCurrent: z.boolean().default(false),
  registrationOpen: z.boolean().default(true),
  registrationOpensAt: z.coerce.date().optional(),
  registrationClosesAt: z.coerce.date().optional(),
  maxUnits: z.number().int().min(1).max(60).default(24),
});

/** Idempotent upsert per (department, session, semester). Marking a term current un-marks the department's previous one. */
async function run() {
  const file = process.argv[2] ?? path.resolve(process.cwd(), "seeds/academic-terms.json");
  const parsed = z.array(entry).safeParse(readJson(file));
  if (!parsed.success) return reportAndExit(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));

  await connectDatabase();
  const departments = new Map((await Department.find()).map((d) => [d.code, d]));
  const errors: string[] = [];
  const currentPerDept = new Map<string, number>();
  parsed.data.forEach((t, i) => {
    const code = t.departmentCode.toUpperCase();
    if (!departments.has(code)) errors.push(`#${i}: unknown department "${t.departmentCode}"`);
    if (t.isCurrent) currentPerDept.set(code, (currentPerDept.get(code) ?? 0) + 1);
  });
  for (const [code, n] of currentPerDept) if (n > 1) errors.push(`${code}: more than one term marked current`);
  if (errors.length) {
    await disconnectDatabase();
    return reportAndExit(errors);
  }

  for (const t of parsed.data) {
    const dept = departments.get(t.departmentCode.toUpperCase())!;
    if (t.isCurrent) {
      await AcademicTerm.updateMany(
        { department: dept._id, isCurrent: true, $or: [{ academicSession: { $ne: t.academicSession } }, { semester: { $ne: t.semester } }] },
        { $set: { isCurrent: false } },
      );
    }
    const { departmentCode: _ignored, ...fields } = t;
    await AcademicTerm.findOneAndUpdate(
      { department: dept._id, academicSession: t.academicSession, semester: t.semester },
      { $set: fields },
      { upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
    logger.info(`Term ${dept.code} ${t.academicSession} ${t.semester}${t.isCurrent ? " (current)" : ""}`);
  }
  await disconnectDatabase();
}
run().catch(failWith);
