import { Department, DepartmentDocument } from "../models/Department";
import { ParsedMatric } from "./matric.service";

/** Find a department by the letters embedded in matric numbers (data-driven, not hardcoded). */
export async function findByMatricCode(matricCode: string): Promise<DepartmentDocument | null> {
  return Department.findOne({ matricCode: matricCode.toUpperCase() });
}

export async function resolveDepartmentFromMatric(parsed: ParsedMatric): Promise<DepartmentDocument | null> {
  return findByMatricCode(parsed.departmentCode);
}

/** Lookup map of every department by matricCode, for bulk operations such as seeding. */
export async function loadDepartmentsByMatricCode(): Promise<Map<string, DepartmentDocument>> {
  const all = await Department.find();
  return new Map(all.map((d) => [d.matricCode, d]));
}

export const departmentOffersLevel = (department: { levels: string[] }, level: string): boolean =>
  department.levels.includes(level);
