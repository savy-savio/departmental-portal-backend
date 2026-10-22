import { z } from "zod";
import { COMPLAINT_MAX_FILES, COMPLAINT_STATUSES, COMPLAINT_TYPES } from "../utils/constants";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const title = z.string().trim().min(3, "Title is too short").max(150);
const message = z.string().trim().min(10, "Please describe the issue in a bit more detail").max(5000);

/** The recipient is never sent by the client: HOD complaints go to the student's own department HOD,
 *  COURSE complaints go to the lecturer of a course the student is registered for. */
export const createComplaintSchema = z
  .object({ type: z.enum(COMPLAINT_TYPES), title, message, courseId: objectId.optional() })
  .strict()
  .superRefine((d, ctx) => {
    if (d.type === "COURSE" && !d.courseId) ctx.addIssue({ code: "custom", path: ["courseId"], message: "Choose the course this complaint is about" });
    if (d.type === "HOD" && d.courseId) ctx.addIssue({ code: "custom", path: ["courseId"], message: "A complaint to the HOD isn't tied to a course" });
  });

export const updateComplaintSchema = z
  .object({ title, message, removeAttachmentIds: z.array(objectId).max(COMPLAINT_MAX_FILES).default([]) })
  .strict();

export const complaintsQuery = z
  .object({
    search: z.string().trim().max(100).optional(),
    status: z.enum(COMPLAINT_STATUSES).optional(),
  })
  .strict();

export type CreateComplaintInput = z.infer<typeof createComplaintSchema>;
export type UpdateComplaintInput = z.infer<typeof updateComplaintSchema>;
