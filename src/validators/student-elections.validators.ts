import { z } from "zod";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
export const electionIdParams = z.object({ electionId: objectId }).strict();

/** No studentId / departmentId anywhere: the voter is always the authenticated student. */
export const castVotesSchema = z
  .object({
    votes: z
      .array(z.object({ positionId: objectId, candidateId: objectId }).strict())
      .min(1, "Select at least one candidate")
      .max(20),
  })
  .strict();

export type CastVotesInput = z.infer<typeof castVotesSchema>;
