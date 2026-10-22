import { z } from "zod";
import { Department, DepartmentDocument } from "../models/Department";
import { Student } from "../models/Student";
import { ACADEMIC_SESSION_REGEX, LEVEL_REGEX } from "../utils/constants";
import { cleanName } from "../utils/name";
import { loadDepartmentsByMatricCode, departmentOffersLevel } from "../services/department.service";
import { parseMatricNumber } from "../services/matric.service";

export const seedStudentSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  matricNumber: z.string().trim().min(5),
  level: z.string().regex(LEVEL_REGEX, 'level must look like "100"'),
  academicSession: z.string().regex(ACADEMIC_SESSION_REGEX, 'academicSession must look like "2026/2027"'),
});
export type SeedStudentInput = z.infer<typeof seedStudentSchema>;

export interface SeedResult {
  created: number;
  errors: { index: number; matricNumber: string; reason: string }[];
}

interface Prepared {
  index: number;
  doc: {
    firstName: string;
    lastName: string;
    matricNumber: string;
    department: DepartmentDocument["_id"];
    level: string;
    academicSession: string;
  };
}

/**
 * All-or-nothing: every record is validated first. If ANY record is bad
 * (unknown department code, level the department doesn't offer, duplicate matric...)
 * nothing is written and every problem is reported, so a student is never created
 * under the wrong department.
 *
 * Students are created with NO password, status PENDING_ONBOARDING, onboardingCompleted=false.
 */
export async function seedStudents(rawRecords: unknown, { dryRun = false } = {}): Promise<SeedResult> {
  const errors: SeedResult["errors"] = [];
  if (!Array.isArray(rawRecords)) {
    return { created: 0, errors: [{ index: -1, matricNumber: "", reason: "Seed file must contain a JSON array." }] };
  }

  const departments = await loadDepartmentsByMatricCode();
  const seenInFile = new Set<string>();
  const prepared: Prepared[] = [];

  rawRecords.forEach((raw, index) => {
    const matricForError = String((raw as { matricNumber?: unknown })?.matricNumber ?? "");
    const fail = (reason: string) => errors.push({ index, matricNumber: matricForError, reason });

    const result = seedStudentSchema.safeParse(raw);
    if (!result.success) return fail(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const rec = result.data;

    const parsed = parseMatricNumber(rec.matricNumber);
    if (!parsed) return fail("Matric number format is invalid.");

    const department = departments.get(parsed.departmentCode);
    if (!department) return fail(`Unknown department code "${parsed.departmentCode}" - no Department has this matricCode.`);
    if (!department.isActive) return fail(`Department ${department.code} is not active.`);
    if (!departmentOffersLevel(department, rec.level)) {
      return fail(`Level ${rec.level} is not offered by ${department.name} (offers: ${department.levels.join(", ")}).`);
    }
    if (seenInFile.has(parsed.normalized)) return fail("Duplicate matric number inside the seed file.");
    seenInFile.add(parsed.normalized);

    prepared.push({
      index,
      doc: {
        firstName: cleanName(rec.firstName),
        lastName: cleanName(rec.lastName),
        matricNumber: parsed.normalized,
        department: department._id,
        level: rec.level,
        academicSession: rec.academicSession,
      },
    });
  });

  if (prepared.length > 0) {
    const existing = await Student.find({ matricNumber: { $in: prepared.map((p) => p.doc.matricNumber) } }).select("matricNumber");
    const taken = new Set(existing.map((s) => s.matricNumber));
    for (const p of prepared) {
      if (taken.has(p.doc.matricNumber)) {
        errors.push({ index: p.index, matricNumber: p.doc.matricNumber, reason: "A student with this matric number already exists." });
      }
    }
  }

  if (errors.length > 0 || dryRun) return { created: 0, errors };

  const inserted = await Student.insertMany(
    prepared.map((p) => ({ ...p.doc, role: "STUDENT", status: "PENDING_ONBOARDING", onboardingCompleted: false })),
  );
  return { created: inserted.length, errors };
}

// Re-exported for tests / future importers.
export { Department };
