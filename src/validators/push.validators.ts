import { z } from "zod";
import { PUSH_CATEGORIES } from "../services/push/rules";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const base64url = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/, "Invalid key encoding");

/** Exactly what `PushSubscription.toJSON()` produces in the browser. No user / department / role fields: identity comes from the token. */
export const pushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().trim().url().max(2048),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: base64url.min(80).max(100), auth: base64url.min(16).max(32) }).strict(),
  }).strict(),
  deviceLabel: z.string().trim().max(60).optional(),
}).strict();
export const pushUnsubscribeSchema = z.object({ endpoint: z.string().trim().url().max(2048) }).strict();
export const pushSubscriptionIdParams = z.object({ id: objectId }).strict();
const categoryFlags = z.object(Object.fromEntries(PUSH_CATEGORIES.map((c) => [c, z.boolean().optional()])) as Record<(typeof PUSH_CATEGORIES)[number], z.ZodOptional<z.ZodBoolean>>).strict();
export const pushPreferencesSchema = z.object({ pushEnabled: z.boolean().optional(), categories: categoryFlags.optional() }).strict()
  .refine((d) => d.pushEnabled !== undefined || (d.categories && Object.keys(d.categories).length > 0), "Provide pushEnabled or at least one category");
