import { z } from "zod";
import { MATERIAL_TYPES, SEMESTERS, ACADEMIC_SESSION_REGEX } from "../utils/constants";
import { COURSE_CODE_REGEX, normalizeCourseCode } from "../utils/course";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
export const idParams = z.object({ id: objectId }).strict();

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
};
const courseCodeQuery = z
  .string()
  .transform(normalizeCourseCode)
  .refine((c) => COURSE_CODE_REGEX.test(c), "Invalid course code");

export const timetableQuery = z.object({ view: z.enum(["combined", "class", "mine"]).default("combined") }).strict();

export const announcementsQuery = z.object({ ...pagination }).strict();

export const materialsQuery = z
  .object({
    ...pagination,
    courseCode: courseCodeQuery.optional(),
    type: z.enum(MATERIAL_TYPES).optional(),
    semester: z.enum(SEMESTERS).optional(),
    academicSession: z.string().regex(ACADEMIC_SESSION_REGEX).optional(),
  })
  .strict();

export const assignmentsQuery = z.object({ status: z.enum(["all", "pending", "submitted"]).default("all") }).strict();

/** Multipart text fields. A file may be sent instead of (or with) text; the service enforces "at least one". */
export const submissionBody = z
  .object({
    content: z
      .string()
      .max(10_000)
      .optional()
      .transform((v) => (v && v.trim() ? v.trim() : undefined)),
  })
  .strict();

export type TimetableQuery = z.infer<typeof timetableQuery>;
export type AnnouncementsQuery = z.infer<typeof announcementsQuery>;
export type MaterialsQuery = z.infer<typeof materialsQuery>;
export type AssignmentsQuery = z.infer<typeof assignmentsQuery>;
export type SubmissionBody = z.infer<typeof submissionBody>;
