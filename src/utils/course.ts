/** "csc 201" -> "CSC201". Prefix is NOT tied to any department (MTH201 is valid in a CSC catalogue). */
export const normalizeCourseCode = (raw: string): string => raw.trim().toUpperCase().replace(/\s+/g, "");
export const COURSE_CODE_REGEX = /^[A-Z]{2,6}\d{3}[A-Z]?$/;
