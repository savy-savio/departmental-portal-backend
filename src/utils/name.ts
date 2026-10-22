/**
 * Name normalisation used for first-time identity verification.
 *
 * Deliberately strict: it forgives capitalisation, accents, punctuation, extra
 * whitespace, hyphens and word order ("DOE  john" == "John Doe") but it does NOT
 * allow missing or extra name parts, so one student cannot match another.
 * The matric number remains the primary identifier; the name is a second factor.
 */
export function nameTokens(input: string): string[] {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents / diacritics
    .toLowerCase()
    .replace(/['’`]/g, "") // O'Neil -> oneil
    .replace(/-/g, " ") // Ade-Bayo -> ade bayo
    .replace(/[^\p{L}\s]/gu, " ") // drop any other punctuation / digits
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

export function namesMatch(typedFullName: string, firstName: string, lastName: string): boolean {
  const typed = nameTokens(typedFullName);
  const expected = nameTokens(`${firstName} ${lastName}`);
  if (typed.length < 2 || typed.length !== expected.length) return false;
  return typed.every((token, i) => token === expected[i]);
}

/** Collapse whitespace for stored names. */
export const cleanName = (value: string): string => value.trim().replace(/\s+/g, " ");
