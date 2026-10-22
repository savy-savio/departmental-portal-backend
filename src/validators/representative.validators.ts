import { z } from "zod";
import { RESOURCE_TYPES, DAYS_OF_WEEK, TIMETABLE_TYPES, TIME_REGEX } from "../utils/constants";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const priority = z.enum(["NORMAL", "IMPORTANT", "URGENT"]);
/** Multipart forms send every value as a string and empty inputs as "": treat those as "not provided" (or "clear" for nullable fields). */
const emptyToUndefined = (v: unknown) => (v === "" || v === "undefined" ? undefined : v);
const emptyToNull = (v: unknown) => (v === "" || v === "null" ? null : v);
const bool = z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean().optional());

export const courseIdParams = z.object({ courseId: objectId }).strict();
export const announcementIdParams = z.object({ announcementId: objectId }).strict();
export const resourceIdParams = z.object({ resourceId: objectId }).strict();

export const courseScopedQuery = z.object({ courseId: objectId.optional() }).strict();
export const timetableQuery = z.object({ courseId: objectId.optional(), view: z.enum(["course", "class"]).default("course") }).strict();
export const membersQuery = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    search: z.string().trim().max(100).optional(),
  })
  .strict();

/**
 * Only these keys are accepted. Audience, department, level, term, author and role are NOT inputs: the class is
 * derived from the assigned course and the author from the JWT. Extra keys (studentId, representativeId, departmentId...) get a 422.
 */
export const createAnnouncementSchema = z
  .object({
    // Optional: leave it out to announce to your whole level; pass a course of your level to address that course's class only.
    courseId: z.preprocess(emptyToUndefined, objectId.optional()),
    title: z.string().trim().min(3).max(150),
    message: z.string().trim().min(3).max(5000),
    priority: z.preprocess(emptyToUndefined, priority.optional()),
    status: z.preprocess(emptyToUndefined, z.enum(["DRAFT", "PUBLISHED"]).optional()),
    expiresAt: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
  })
  .strict();

export const updateAnnouncementSchema = z
  .object({
    title: z.string().trim().min(3).max(150).optional(),
    message: z.string().trim().min(3).max(5000).optional(),
    priority: z.preprocess(emptyToUndefined, priority.optional()),
    status: z.preprocess(emptyToUndefined, z.enum(["DRAFT", "PUBLISHED", "UNPUBLISHED"]).optional()),
    expiresAt: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
    /** Remove the current picture (a new file in the "image" field replaces it instead). */
    removeImage: bool,
  })
  .strict(); // "at least one change" is checked in the service, because a picture alone arrives as a file, not a body field

/** Multipart (file) or JSON (fileUrl): all values arrive as strings, which is fine for these fields. */
export const createResourceSchema = z
  .object({
    courseId: objectId.optional(),
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(2000).optional(),
    resourceType: z.enum(RESOURCE_TYPES),
    fileUrl: z
      .string()
      .trim()
      .max(500)
      .url()
      .refine((u) => u.startsWith("https://"), "Links must use https")
      .optional(),
  })
  .strict();

export const updateResourceSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    resourceType: z.enum(RESOURCE_TYPES).optional(),
    status: z.enum(["PUBLISHED", "HIDDEN"]).optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, "Provide at least one field to update");

export const timetableIdParams = z.object({ id: objectId }).strict();
const time = z.string().regex(TIME_REGEX, "Use HH:mm (24-hour)");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/**
 * Class timetable slot. The rep SELECTS the course (`courseId`, one of the courses of their level); the class (department, level, term)
 * comes from that course and the lecturer(s) from the course's lecturer assignments, so neither is typed. The venue is optional.
 * Extra keys (studentId, departmentId, level, source, lecturerName...) get a 422.
 */
const venue = z.union([z.string().trim().max(100), z.null()]).optional();
export const createTimetableSchema = z
  .object({
    courseId: objectId,
    title: z.string().trim().min(2).max(200).optional(),
    type: z.enum(TIMETABLE_TYPES).optional(),
    dayOfWeek: z.enum(DAYS_OF_WEEK).optional(),
    date: isoDate.optional(),
    startTime: time,
    endTime: time,
    venue,
    status: z.enum(["DRAFT", "PUBLISHED"]).optional(),
  })
  .strict()
  .refine((d) => d.dayOfWeek || d.date, { message: "Provide a dayOfWeek or a date", path: ["dayOfWeek"] });

export const updateTimetableSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    type: z.enum(TIMETABLE_TYPES).optional(),
    dayOfWeek: z.enum(DAYS_OF_WEEK).optional(),
    date: isoDate.nullable().optional(),
    startTime: time.optional(),
    endTime: time.optional(),
    venue,
    status: z.enum(["DRAFT", "PUBLISHED"]).optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, "Provide at least one field to update");
