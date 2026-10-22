import path from "node:path";
import { z } from "zod";
import { connectDatabase, disconnectDatabase } from "../config/db";
import { env } from "../config/env";
import { Hod } from "../models/Hod";
import { createHodAccount } from "../services/hod/account.service";
import { logger } from "../utils/logger";
import { failWith, readJson, reportAndExit } from "./seed-helpers";

const entry = z.object({
  departmentCode: z.string().min(2), staffId: z.string().min(2), firstName: z.string().min(1), lastName: z.string().min(1), email: z.string().email(), phone: z.string().optional(),
});

/**
 * System provisioning of department heads (there is no signup endpoint). Run by a trusted operator with database access.
 * New HODs start INVITED: this prints the one-time activation link (and emails it when Resend is configured). Idempotent per email.
 */
async function run() {
  const file = process.argv[2] ?? path.resolve(process.cwd(), "seeds/hods.json");
  const parsed = z.array(entry).safeParse(readJson(file));
  if (!parsed.success) return reportAndExit(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  await connectDatabase();
  const errors: string[] = [];
  for (const [i, e] of parsed.data.entries()) {
    if (await Hod.exists({ email: e.email.toLowerCase() })) { logger.info(`HOD ${e.email} already exists`); continue; }
    try {
      const r = await createHodAccount({ name: "Provisioning script", role: "SYSTEM_SETUP" }, e, { returnToken: true });
      logger.info(`Created HOD ${e.email} (${e.departmentCode}). Activation link: ${env.clientUrl}/hod/activate?token=${r.activationToken}`);
    } catch (err) { errors.push(`#${i} ${e.email}: ${err instanceof Error ? err.message : err}`); }
  }
  await disconnectDatabase();
  if (errors.length) reportAndExit(errors);
}
run().catch(failWith);
