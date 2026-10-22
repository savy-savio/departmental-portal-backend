import { z } from "zod";
import { COURSE_CODE_REGEX, normalizeCourseCode } from "../utils/course";

export const sessionIdParams = z.object({ sessionId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid id") }).strict();

export const attendanceQuery = z
  .object({
    courseCode: z.string().transform(normalizeCourseCode).refine((c) => COURSE_CODE_REGEX.test(c), "Invalid course code").optional(),
  })
  .strict();


const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
};
export const notificationsQuery = z
  .object({ ...pagination, unread: z.enum(["true", "false"]).optional().transform((v) => v === "true") })
  .strict();
