/**
 * Matric number parsing / normalisation.
 *
 * This is the ONLY place that knows what a matric number looks like. It is pure
 * (no database, no department names). Mapping the extracted department code to a
 * Department record is done by department.service.ts, using Department.matricCode.
 *
 * Structure:  <entryYY>/<programmeNumber><DEPARTMENT_CODE>/<serial>
 * Example:    25/208CSC/987  ->  entryYear "25", programmeNumber "208",
 *                                departmentCode "CSC", serial "987"
 */
export interface ParsedMatric {
  /** Canonical form that is stored and compared, e.g. "25/208CSC/987". */
  normalized: string;
  entryYear: string;
  programmeNumber: string;
  /** Letters identifying the department; looked up against Department.matricCode. */
  departmentCode: string;
  serial: string;
}

const MATRIC_PATTERN = /^(\d{2})\/(\d{1,4})([A-Z]{2,10})\/(\d{1,5})$/;

/** Trim, uppercase, remove spaces around slashes and accept backslashes as separators. */
export function normalizeMatricNumber(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/\s*[\/\\]\s*/g, "/")
    .replace(/\s+/g, "");
}

/** Returns null when the value is not shaped like a matric number. */
export function parseMatricNumber(raw: string): ParsedMatric | null {
  if (typeof raw !== "string") return null;
  const normalized = normalizeMatricNumber(raw);
  const match = MATRIC_PATTERN.exec(normalized);
  if (!match) return null;
  const [, entryYear, programmeNumber, departmentCode, serial] = match;
  return { normalized, entryYear, programmeNumber, departmentCode, serial };
}

export const isValidMatricFormat = (raw: string): boolean => parseMatricNumber(raw) !== null;
