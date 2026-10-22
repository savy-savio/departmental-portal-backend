import { connectDatabase, disconnectDatabase } from "../config/db";
import { CourseRepresentativeAssignment } from "../models/CourseRepresentativeAssignment";
import { logger } from "../utils/logger";

/**
 * One-off, safe to re-run: `npm run migrate:rep-levels`.
 *  1. Marks appointments created before level appointments existed (they have a course and no scope) as scope "COURSE", so they keep working.
 *  2. Rebuilds the collection's indexes so the new "one Course Rep per level per term" rules replace the old per-course ones.
 * New appointments (HOD > Representatives) are always for a level.
 */
async function main() {
  await connectDatabase();
  const r = await CourseRepresentativeAssignment.collection.updateMany({ scope: { $exists: false }, course: { $type: "objectId" } }, { $set: { scope: "COURSE" } });
  logger.info(`Legacy course appointments marked: ${r.modifiedCount}`);
  await CourseRepresentativeAssignment.syncIndexes();
  logger.info("Indexes synchronised.");
  await disconnectDatabase();
}
main().catch(async (err) => { logger.error(err instanceof Error ? err.message : err); await disconnectDatabase().catch(() => undefined); process.exit(1); });
