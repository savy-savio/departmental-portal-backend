import fs from "node:fs";
import { disconnectDatabase } from "../config/db";
import { logger } from "../utils/logger";

export const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));

export function reportAndExit(errors: string[]): never {
  logger.error(`Seeding aborted - nothing was written. ${errors.length} problem(s):`);
  errors.forEach((e) => logger.error(`  ${e}`));
  process.exit(1);
}

export async function failWith(err: unknown): Promise<void> {
  logger.error("Seeding failed:", err instanceof Error ? err.message : err);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
}
