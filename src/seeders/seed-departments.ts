import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { connectDatabase, disconnectDatabase } from "../config/db";
import { Department } from "../models/Department";
import { LEVEL_REGEX } from "../utils/constants";
import { logger } from "../utils/logger";

const entrySchema = z.object({
  name: z.string().trim().min(2),
  code: z.string().trim().regex(/^[A-Za-z]{2,10}$/),
  matricCode: z.string().trim().regex(/^[A-Za-z]{2,10}$/),
  faculty: z.string().trim().min(2),
  levels: z.array(z.string().regex(LEVEL_REGEX)).min(1),
  isActive: z.boolean().optional(),
});

/** Idempotent: upserts by `code`, so re-running updates levels / faculty instead of duplicating. */
async function run() {
  const file = process.argv[2] ?? path.resolve(process.cwd(), "seeds/departments.json");
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = z.array(entrySchema).parse(raw);

  await connectDatabase();
  for (const e of entries) {
    const code = e.code.toUpperCase();
    const matricCode = e.matricCode.toUpperCase();
    const clash = await Department.findOne({ matricCode, code: { $ne: code } });
    if (clash) throw new Error(`matricCode ${matricCode} is already used by department ${clash.code}`);

    const doc = await Department.findOneAndUpdate(
      { code },
      { $set: { name: e.name, matricCode, faculty: e.faculty, levels: [...new Set(e.levels)].sort(), isActive: e.isActive ?? true } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );
    logger.info(`Department ${doc.code} (${doc.name}) levels=[${doc.levels.join(", ")}] matricCode=${doc.matricCode}`);
  }
  await disconnectDatabase();
}

run().catch(async (err) => {
  logger.error("Department seeding failed:", err instanceof Error ? err.message : err);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
