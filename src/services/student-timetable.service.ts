import type { FilterQuery } from "mongoose";
import type { DepartmentDocument } from "../models/Department";
import type { StudentDocument } from "../models/Student";
import { ITimetableEntry, TimetableEntry } from "../models/TimetableEntry";
import { DAYS_OF_WEEK } from "../utils/constants";
import type { TimetableQuery } from "../validators/student-academic.validators";
import { loadStudentContext } from "./student-context.service";

/**
 * view=class    everything scheduled for the student's level this term
 * view=mine     only slots for courses the student is registered for (includes carryovers from other levels)
 * view=combined both, de-duplicated (default)
 * The official timetable is read-only for students.
 */
export async function getTimetable(student: StudentDocument, department: DepartmentDocument, query: TimetableQuery) {
  const { term, enrolledCodes } = await loadStudentContext(student, department);
  if (!term) return { term: null, view: query.view, entries: [] };

  // `$ne: "DRAFT"` also matches official entries that have no status at all.
  const base = { department: department._id, academicSession: term.academicSession, semester: term.semester, status: { $ne: "DRAFT" as const } };
  const classFilter: FilterQuery<ITimetableEntry> = { ...base, level: student.level };
  const mineFilter: FilterQuery<ITimetableEntry> = { ...base, courseCode: { $in: enrolledCodes } };

  const filter: FilterQuery<ITimetableEntry> =
    query.view === "class" ? classFilter : query.view === "mine" ? mineFilter : { $or: [classFilter, mineFilter] };

  const rows = await TimetableEntry.find(filter);
  const mine = new Set(enrolledCodes);
  const entries = rows
    .map((e) => ({
      id: String(e._id),
      courseCode: e.courseCode ?? null,
      title: e.title,
      type: e.type,
      dayOfWeek: e.dayOfWeek,
      startTime: e.startTime,
      endTime: e.endTime,
      venue: e.venue ?? null,
      lecturerName: e.lecturerName ?? null,
      level: e.level,
      date: e.date ?? null,
      source: e.source ?? "OFFICIAL",
      isMyCourse: e.courseCode ? mine.has(e.courseCode) : false,
    }))
    .sort(
      (a, b) =>
        DAYS_OF_WEEK.indexOf(a.dayOfWeek) - DAYS_OF_WEEK.indexOf(b.dayOfWeek) || a.startTime.localeCompare(b.startTime),
    );

  return {
    term: { academicSession: term.academicSession, semester: term.semester },
    view: query.view,
    entries,
  };
}
