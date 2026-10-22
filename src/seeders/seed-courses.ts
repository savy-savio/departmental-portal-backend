import path from "node:path";
import { z } from "zod";
import { connectDatabase, disconnectDatabase } from "../config/db";
import { Course } from "../models/Course";
import { Department } from "../models/Department";
import { ACADEMIC_SESSION_REGEX, COURSE_STATUSES, LEVEL_REGEX, SEMESTERS } from "../utils/constants";
import { COURSE_CODE_REGEX, normalizeCourseCode } from "../utils/course";
import { logger } from "../utils/logger";
import { failWith, readJson, reportAndExit } from "./seed-helpers";

const entry = z.object({
  departmentCode: z.string().trim().min(2),
  courseCode: z.string().trim().transform(normalizeCourseCode).refine((c) => COURSE_CODE_REGEX.test(c), "Course code must look like CSC201"),
  title: z.string().trim().min(2).max(200),
  units: z.number().min(0).max(12),
  level: z.string().regex(LEVEL_REGEX),
  semester: z.enum(SEMESTERS),
  academicSession: z.string().regex(ACADEMIC_SESSION_REGEX),
  status: z.enum(COURSE_STATUSES).default("ACTIVE"),
});

/**
 * Seeds the course catalogue. This is the stand-in for the HOD / course-rep upload feature built in later phases.
 * All-or-nothing validation, then idempotent upsert on (department, courseCode, session, semester).
 */
async function run() {
  const file = process.argv[2] ?? path.resolve(process.cwd(), "seeds/courses.json");
  const parsed = z.array(entry).safeParse(readJson(file));
  if (!parsed.success) return reportAndExit(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));

  await connectDatabase();
  const departments = new Map((await Department.find()).map((d) => [d.code, d]));
  const errors: string[] = [];
  const seen = new Set<string>();

  parsed.data.forEach((c, i) => {
    const dept = departments.get(c.departmentCode.toUpperCase());
    if (!dept) return void errors.push(`#${i} ${c.courseCode}: unknown department "${c.departmentCode}"`);
    if (!dept.levels.includes(c.level)) {
      return void errors.push(`#${i} ${c.courseCode}: level ${c.level} is not offered by ${dept.name} (offers ${dept.levels.join(", ")})`);
    }
    const key = `${dept.code}|${c.courseCode}|${c.academicSession}|${c.semester}`;
    if (seen.has(key)) errors.push(`#${i} ${c.courseCode}: duplicate entry in file`);
    seen.add(key);
  });
  if (errors.length) {
    await disconnectDatabase();
    return reportAndExit(errors);
  }

  const ops = parsed.data.map((c) => {
    const dept = departments.get(c.departmentCode.toUpperCase())!;
    return {
      updateOne: {
        filter: { department: dept._id, courseCode: c.courseCode, academicSession: c.academicSession, semester: c.semester },
        update: { $set: { title: c.title, units: c.units, level: c.level, status: c.status }},
        upsert: true,
      },
    };
  });
  const result = await Course.bulkWrite(ops);
  logger.info(`Courses: ${result.upsertedCount} created, ${result.modifiedCount} updated, ${parsed.data.length} processed.`);
  await disconnectDatabase();
}
run().catch(failWith);
