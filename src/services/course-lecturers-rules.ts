/** Who is shown as a course's lecturer(s). Pure, so it is unit-tested. */
export interface CourseLecturer { lecturerId: string; name: string }

/**
 * Groups ACTIVE course assignments into display names per course.
 * Suspended lecturers and lecturers that no longer exist are left out; a lecturer appears once per course; names are sorted for a stable display.
 */
export function groupCourseLecturers(
  assignments: { courseId: string; lecturerId: string }[],
  lecturers: { id: string; firstName: string; lastName: string; status: string }[],
): Map<string, CourseLecturer[]> {
  const byId = new Map(lecturers.filter((l) => l.status !== "SUSPENDED").map((l) => [l.id, l]));
  const out = new Map<string, CourseLecturer[]>();
  const seen = new Set<string>();
  for (const a of assignments) {
    const l = byId.get(a.lecturerId);
    const key = `${a.courseId}|${a.lecturerId}`;
    if (!l || seen.has(key)) continue;
    seen.add(key);
    const list = out.get(a.courseId) ?? [];
    list.push({ lecturerId: l.id, name: `${l.firstName} ${l.lastName}`.trim() });
    out.set(a.courseId, list);
  }
  for (const list of out.values()) list.sort((x, y) => x.name.localeCompare(y.name));
  return out;
}

/** Students only ever see the name: no id, email or phone. */
export const publicLecturers = (list: CourseLecturer[] | undefined) => (list ?? []).map((l) => ({ name: l.name }));
