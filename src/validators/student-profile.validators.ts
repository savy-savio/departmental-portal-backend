import { z } from "zod";

/** Digits with optional leading +, spaces/dashes/brackets tolerated; stored as + and digits only. */
const phoneField = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s\-()]/g, ""))
  .refine((v) => /^\+?\d{7,15}$/.test(v), "Enter a valid phone number");

/**
 * Fields a student may change themselves. Everything else (matric number, department,
 * level, role, status, email, names) is rejected by .strict().
 * Email changes need a verification flow and names are official records; both are
 * intentionally not editable here.
 */
export const updateProfileSchema = z
  .object({
    phone: z.union([phoneField, z.literal("").transform(() => null), z.null()]).optional(),
    sex: z.enum(["MALE", "FEMALE"]).nullable().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, "Provide at least one field to update");

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
