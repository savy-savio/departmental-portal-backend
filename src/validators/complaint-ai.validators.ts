import { z } from "zod";
import { COMPLAINT_AI_ACTIONS, COMPLAINT_AI_MAX_CHARS, COMPLAINT_AI_MIN_CHARS } from "../services/ai/complaint-ai.rules";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

/**
 * The student's current draft. Nothing here is stored; the assistant only returns a suggestion the student may accept.
 * `.strict()` like every other body in this API: unknown fields (departmentId, studentId, role...) are rejected.
 * `courseId` is optional context (the course the complaint is about); it is only used to name the course in a title or letter.
 */
export const complaintAiSchema = z
  .object({
    action: z.enum(COMPLAINT_AI_ACTIONS),
    message: z
      .string()
      .trim()
      .min(COMPLAINT_AI_MIN_CHARS, `Write at least ${COMPLAINT_AI_MIN_CHARS} characters in your message first, so the assistant has something to work with.`)
      .max(COMPLAINT_AI_MAX_CHARS, "Your message is too long for the assistant"),
    // The title the student typed. Only used as a fallback subject line for a letter.
    title: z.string().trim().max(150).optional(),
    courseId: objectId.optional(),
  })
  .strict();

export type ComplaintAiInput = z.infer<typeof complaintAiSchema>;
