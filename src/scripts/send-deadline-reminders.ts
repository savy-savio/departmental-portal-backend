import { connectDatabase, disconnectDatabase } from "../config/db";
import { sendDeadlineReminders } from "../services/push/deadline-reminders";
import { DEFAULT_REMINDER_HOURS } from "../services/push/reminder-rules";
import { logger } from "../utils/logger";

/** `npm run reminders:deadlines [-- <hours>]`: schedule hourly (cron / platform scheduler). Safe to run repeatedly. */
async function main() {
  const hours = Number(process.argv[2] ?? DEFAULT_REMINDER_HOURS);
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new Error("hours must be between 1 and 168");
  await connectDatabase();
  const r = await sendDeadlineReminders(new Date(), hours);
  logger.info(`Deadline reminders: ${r.assignments} assignment(s) due within ${hours}h, ${r.recipients} student(s) reminded.`);
  await disconnectDatabase();
}
main().catch(async (err) => { logger.error(err instanceof Error ? err.message : err); await disconnectDatabase().catch(() => undefined); process.exit(1); });
