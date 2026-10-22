import { Assignment } from "../../models/Assignment";
import { AssignmentSubmission } from "../../models/AssignmentSubmission";
import { CourseEnrollment } from "../../models/CourseEnrollment";
import { notify } from "../notification.service";
import { DEFAULT_REMINDER_HOURS, isInReminderWindow, reminderKey, reminderText, studentsToRemind } from "./reminder-rules";

/**
 * Reminds enrolled students who have NOT submitted that a PUBLISHED assignment is due within `hours`. Run it on a schedule (e.g. hourly cron):
 * each (student, assignment, window) is notified once, because the notification carries an idempotency key. The in-app entry is saved first;
 * the browser push (respecting the student's preferences) follows through the normal notify() path.
 */
export async function sendDeadlineReminders(now = new Date(), hours = DEFAULT_REMINDER_HOURS): Promise<{ assignments: number; recipients: number }> {
  const due = await Assignment.find({ status: "PUBLISHED", dueAt: { $gt: now, $lte: new Date(now.getTime() + hours * 3_600_000) } });
  let recipients = 0;
  for (const a of due) {
    if (!isInReminderWindow(a.dueAt, now, hours)) continue;
    const [enrolled, submitted] = await Promise.all([
      CourseEnrollment.find({ department: a.department, courseCode: a.courseCode, academicSession: a.academicSession, semester: a.semester, status: "ENROLLED" }).select("student"),
      AssignmentSubmission.distinct("student", { assignment: a._id }),
    ]);
    const targets = studentsToRemind(enrolled.map((e) => String(e.student)), submitted.map(String));
    if (!targets.length) continue;
    const text = reminderText(a.courseCode, a.title, a.dueAt, now);
    await notify(targets.map((student) => ({
      recipient: student as never, department: a.department as never, kind: "ASSIGNMENT" as const, title: text.title, body: text.body, link: "/student/assignments", dedupeKey: reminderKey(String(a._id), hours),
    })));
    recipients += targets.length;
  }
  return { assignments: due.length, recipients };
}
