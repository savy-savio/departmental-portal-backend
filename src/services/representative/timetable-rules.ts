import { TIME_REGEX } from "../../utils/constants";

export const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export type Day = (typeof DAYS)[number];
const JS_DAY_TO_DAY: Day[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export interface TimetableSlot {
  dayOfWeek?: Day;
  date?: string | null;
  startTime: string;
  endTime: string;
}

const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** "2026-10-14" -> "WED" (null if it isn't a real calendar date). */
export function dayOfDate(date: string): Day | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return null;
  return JS_DAY_TO_DAY[d.getUTCDay()];
}

/**
 * Validates a slot and works out its weekday. Either a weekday (weekly class) or a date (one-off) is needed;
 * if both are given they must agree. Returns the problems and the resolved weekday.
 */
export function validateSlot(slot: TimetableSlot): { errors: string[]; dayOfWeek?: Day } {
  const errors: string[] = [];
  if (!TIME_REGEX.test(slot.startTime)) errors.push("startTime must be HH:mm (24-hour).");
  if (!TIME_REGEX.test(slot.endTime)) errors.push("endTime must be HH:mm (24-hour).");
  if (!errors.length && toMinutes(slot.endTime) <= toMinutes(slot.startTime)) errors.push("endTime must be after startTime.");

  let day: Day | undefined = slot.dayOfWeek;
  if (slot.date) {
    const fromDate = dayOfDate(slot.date);
    if (!fromDate) errors.push("date must be a real calendar date (YYYY-MM-DD).");
    else if (day && day !== fromDate) errors.push(`That date is a ${fromDate}, not a ${day}.`);
    else day = fromDate;
  }
  if (!day) errors.push("Provide a dayOfWeek or a date.");
  return { errors, dayOfWeek: day };
}

/** Two slots clash when they are on the same day (weekly with weekly, or the same one-off date) and the times overlap. */
export function slotsOverlap(a: TimetableSlot & { dayOfWeek: Day }, b: TimetableSlot & { dayOfWeek: Day }): boolean {
  const sameDay = a.date || b.date ? (a.date ?? null) === (b.date ?? null) : a.dayOfWeek === b.dayOfWeek;
  return sameDay && toMinutes(a.startTime) < toMinutes(b.endTime) && toMinutes(b.startTime) < toMinutes(a.endTime);
}
