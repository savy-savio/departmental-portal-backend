import fs from "node:fs";
import path from "node:path";
import { connectDatabase, disconnectDatabase } from "../config/db";
import { logger } from "../utils/logger";
import { seedStudents } from "./student-seeding";

/** Usage: npm run seed:students [-- path/to/students.json] [--dry-run] */
async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const file = args.find((a) => !a.startsWith("--")) ?? path.resolve(process.cwd(), "seeds/students.json");

  const records: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  await connectDatabase();
  const result = await seedStudents(records, { dryRun });
  await disconnectDatabase();

  if (result.errors.length > 0) {
    logger.error(`Seeding aborted - nothing was written. ${result.errors.length} problem(s):`);
    for (const e of result.errors) logger.error(`  #${e.index} ${e.matricNumber || "(no matric)"}: ${e.reason}`);
    process.exit(1);
  }
  logger.info(dryRun ? "Dry run OK - all records are valid." : `Seeded ${result.created} student(s). They have no password and must complete onboarding.`);
}

run().catch(async (err) => {
  logger.error("Student seeding failed:", err instanceof Error ? err.message : err);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
