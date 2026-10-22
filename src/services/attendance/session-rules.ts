import { isValidLatitude, isValidLongitude } from "./geo";

/** Course Reps / Assistant Course Reps are deliberately NOT creator roles: they have no attendance management at all. */
export type SessionCreatorRole = "LECTURER" | "HOD";
export interface SessionInput {
  courseCode: string;
  title: string;
  opensAt: Date;
  closesAt: Date;
  lateAfterMinutes?: number;
  code?: string;
  location: { latitude: number; longitude: number; allowedRadiusInMeters: number };
}

/** maxCreatorAccuracyMeters: the lecturer's own GPS fix must be at least this good, or the venue centre could be kilometres off (e.g. a laptop's Wi-Fi/IP location). */
export const SESSION_LIMITS = { minRadius: 10, maxRadius: 1000, maxDurationHours: 6, maxFutureDays: 30, maxCreatorAccuracyMeters: 100 } as const;

/**
 * Who may open attendance for a course: only someone from the course's own department, and either that department's HOD
 * or a lecturer explicitly assigned to the course. Representatives (course rep / assistant) never qualify, and there is
 * no global role that crosses the department boundary. (The lecturer API enforces the same rule from LecturerCourseAssignment.)
 */
export function authorizeSessionCreator(creator: { role: string; departmentId: string; assignedCourseCodes?: string[] }, course: { departmentId: string; courseCode: string }): { ok: true } | { ok: false; reason: string } {
  if (creator.departmentId !== course.departmentId) return { ok: false, reason: "You can only open attendance for courses in your own department." };
  if (creator.role === "HOD") return { ok: true };
  if (creator.role === "LECTURER") {
    return creator.assignedCourseCodes?.includes(course.courseCode) ? { ok: true } : { ok: false, reason: "You are not assigned to this course." };
  }
  return { ok: false, reason: "Your role cannot open attendance sessions." };
}

/** Returns a list of human-readable problems (empty = valid). */
export function validateSessionInput(input: SessionInput, now: Date): string[] {
  const errors: string[] = [];
  const { location } = input;
  if (!input.title?.trim() || input.title.trim().length < 2) errors.push("A title is required.");
  if (!(input.opensAt instanceof Date) || Number.isNaN(input.opensAt.getTime())) errors.push("opensAt is not a valid date.");
  if (!(input.closesAt instanceof Date) || Number.isNaN(input.closesAt.getTime())) errors.push("closesAt is not a valid date.");
  if (errors.length) return errors;

  if (input.closesAt <= input.opensAt) errors.push("The session must close after it opens.");
  const hours = (input.closesAt.getTime() - input.opensAt.getTime()) / 3_600_000;
  if (hours > SESSION_LIMITS.maxDurationHours) errors.push(`A session can stay open for at most ${SESSION_LIMITS.maxDurationHours} hours.`);
  if (input.opensAt.getTime() - now.getTime() > SESSION_LIMITS.maxFutureDays * 86_400_000) errors.push("The session starts too far in the future.");
  if (input.closesAt <= now) errors.push("The session would already be closed.");
  if (!isValidLatitude(location?.latitude) || !isValidLongitude(location?.longitude)) errors.push("Valid class coordinates are required.");
  if (!(location?.allowedRadiusInMeters >= SESSION_LIMITS.minRadius && location?.allowedRadiusInMeters <= SESSION_LIMITS.maxRadius)) {
    errors.push(`The radius must be between ${SESSION_LIMITS.minRadius} and ${SESSION_LIMITS.maxRadius} metres.`);
  }
  if (input.lateAfterMinutes !== undefined && (input.lateAfterMinutes < 0 || input.lateAfterMinutes > hours * 60)) {
    errors.push("lateAfterMinutes must be between 0 and the session length.");
  }
  if (input.code !== undefined && !/^[A-Za-z0-9]{3,12}$/.test(input.code)) errors.push("The in-class code must be 3-12 letters or digits.");
  return errors;
}
