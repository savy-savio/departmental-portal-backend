import { z } from "zod";
import { ENROLLMENT_TYPES } from "../utils/constants";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const enrollmentIdParams = z.object({ enrollmentId: objectId }).strict();

/** Note: no studentId / departmentId / level here. Those come from the JWT, never the client. */
export const addCourseSchema = z
  .object({
    courseId: objectId,
    enrollmentType: z.enum(ENROLLMENT_TYPES).default("REGULAR"),
  })
  .strict();

export const updateEnrollmentSchema = z.object({ enrollmentType: z.enum(ENROLLMENT_TYPES) }).strict();

export type AddCourseInput = z.infer<typeof addCourseSchema>;
export type UpdateEnrollmentInput = z.infer<typeof updateEnrollmentSchema>;
