import path from "node:path";
import { z } from "zod";
import { connectDatabase, disconnectDatabase } from "../config/db";
import { Department } from "../models/Department";
import { Election } from "../models/Election";
import { ElectionCandidate } from "../models/ElectionCandidate";
import { ElectionPosition } from "../models/ElectionPosition";
import { Student } from "../models/Student";
import { parseMatricNumber } from "../services/matric.service";
import { ACADEMIC_SESSION_REGEX, ELECTION_STATUSES, LEVEL_REGEX } from "../utils/constants";
import { logger } from "../utils/logger";
import { failWith, readJson, reportAndExit } from "./seed-helpers";

const candidate = z.object({ matricNumber: z.string().min(5), manifesto: z.string().max(3000).optional() });
const position = z.object({ title: z.string().min(2), description: z.string().optional(), candidates: z.array(candidate).default([]) });
const election = z.object({
  departmentCode: z.string().min(2),
  title: z.string().min(2),
  description: z.string().optional(),
  academicSession: z.string().regex(ACADEMIC_SESSION_REGEX),
  eligibleLevels: z.array(z.string().regex(LEVEL_REGEX)).default([]),
  /** Relative times so a re-seed re-opens the election. */
  startsInMinutes: z.number().default(0),
  durationMinutes: z.number().min(1).default(1440),
  status: z.enum(ELECTION_STATUSES).default("PUBLISHED"),
  resultsPublished: z.boolean().default(false),
  createdByName: z.string().default("Election Committee"),
  createdByRole: z.string().default("HOD"),
  positions: z.array(position).min(1),
});

/**
 * Sample-election seeder: stands in for the Election Administration phase.
 * Validates everything first (department, levels, candidates must be existing students of the SAME department),
 * then upserts. Never deletes positions/candidates, and never touches votes.
 */
async function run() {
  const file = process.argv[2] ?? path.resolve(process.cwd(), "seeds/elections.json");
  const parsed = z.array(election).safeParse(readJson(file));
  if (!parsed.success) return reportAndExit(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));

  await connectDatabase();
  const departments = new Map((await Department.find()).map((d) => [d.code, d]));
  const matrics = parsed.data.flatMap((e) => e.positions.flatMap((p) => p.candidates.map((c) => parseMatricNumber(c.matricNumber)?.normalized ?? c.matricNumber)));
  const students = new Map((await Student.find({ matricNumber: { $in: matrics } }).select("matricNumber department")).map((s) => [s.matricNumber, s]));

  const errors: string[] = [];
  parsed.data.forEach((e, i) => {
    const dept = departments.get(e.departmentCode.toUpperCase());
    if (!dept) return void errors.push(`election #${i}: unknown department "${e.departmentCode}"`);
    e.eligibleLevels.forEach((l) => !dept.levels.includes(l) && errors.push(`election #${i}: level ${l} not offered by ${dept.name}`));
    e.positions.forEach((p) =>
      p.candidates.forEach((c) => {
        const s = students.get(parseMatricNumber(c.matricNumber)?.normalized ?? c.matricNumber);
        if (!s) errors.push(`election #${i} ${p.title}: candidate ${c.matricNumber} not found (seed students first)`);
        else if (String(s.department) !== String(dept._id)) errors.push(`election #${i} ${p.title}: candidate ${c.matricNumber} is not in ${dept.code}`);
      }),
    );
  });
  if (errors.length) {
    await disconnectDatabase();
    return reportAndExit(errors);
  }

  for (const e of parsed.data) {
    const dept = departments.get(e.departmentCode.toUpperCase())!;
    const opens = new Date(Date.now() + e.startsInMinutes * 60_000);
    const doc = await Election.findOneAndUpdate(
      { department: dept._id, academicSession: e.academicSession, title: e.title },
      {
        $set: {
          description: e.description, eligibleLevels: e.eligibleLevels, electorateMode: e.eligibleLevels.length ? "LEVELS" : "DEPARTMENT", votingOpensAt: opens,
          votingClosesAt: new Date(opens.getTime() + e.durationMinutes * 60_000), status: e.status,
          resultsPublished: e.resultsPublished, createdByName: e.createdByName, createdByRole: e.createdByRole,
        },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );

    for (const [order, p] of e.positions.entries()) {
      const pos = await ElectionPosition.findOneAndUpdate(
        { election: doc._id, title: p.title },
        { $set: { department: dept._id, description: p.description, order } },
        { upsert: true, new: true, runValidators: true },
      );
      for (const c of p.candidates) {
        const s = students.get(parseMatricNumber(c.matricNumber)?.normalized ?? c.matricNumber)!;
        await ElectionCandidate.findOneAndUpdate(
          { position: pos._id, student: s._id },
          { $set: { election: doc._id, department: dept._id, manifesto: c.manifesto, status: "APPROVED" } },
          { upsert: true, runValidators: true },
        );
      }
    }
    logger.info(`Election "${doc.title}" (${dept.code}) seeded with ${e.positions.length} position(s).`);
  }
  await disconnectDatabase();
}
run().catch(failWith);
