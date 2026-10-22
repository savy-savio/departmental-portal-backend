/** Pure rules for assignment-deadline reminders. */
export const DEFAULT_REMINDER_HOURS = 24;

/** Due in the future, but within the reminder window. Past-due and far-future assignments are never reminded. */
export const isInReminderWindow = (dueAt: Date, now: Date, hours = DEFAULT_REMINDER_HOURS) =>
  dueAt.getTime() > now.getTime() && dueAt.getTime() <= now.getTime() + hours * 3_600_000;

/** One reminder per (student, assignment, window): the notification's idempotency key, so re-running the job never notifies twice. */
export const reminderKey = (assignmentId: string, hours = DEFAULT_REMINDER_HOURS) => `assignment-due:${assignmentId}:${hours}h`;

export function reminderText(courseCode: string, title: string, dueAt: Date, now: Date) {
  const hoursLeft = Math.max(1, Math.ceil((dueAt.getTime() - now.getTime()) / 3_600_000));
  return { title: `${courseCode}: assignment due soon`, body: `${title} is due in about ${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}.` };
}

/** Enrolled students who have not handed in yet. */
export const studentsToRemind = (enrolled: string[], submitted: string[]) => {
  const done = new Set(submitted);
  return [...new Set(enrolled)].filter((s) => !done.has(s));
};
