import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(5000),
    MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    JWT_EXPIRES_IN: z.string().default("7d"),
    ONBOARDING_TOKEN_EXPIRES_IN: z.string().default("15m"),
    PASSWORD_RESET_EXPIRES_MINUTES: z.coerce.number().int().positive().default(30),
    BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
    // Gmail (App Password). Set both together, or none (development then prints emails to the console).
    GMAIL_USER: z.string().email().optional(),
    GMAIL_APP_PASSWORD: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    CLIENT_URL: z.string().min(1, "CLIENT_URL is required"),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    CLOUDINARY_CLOUD_NAME: z.string().optional(),
    CLOUDINARY_API_KEY: z.string().optional(),
    CLOUDINARY_API_SECRET: z.string().optional(),
    MAX_PROFILE_PHOTO_MB: z.coerce.number().positive().max(10).default(2),
    ATTENDANCE_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(15).max(600).default(90),
    ATTENDANCE_MAX_ACCURACY_METERS: z.coerce.number().positive().max(1000).default(100),
    // How accurate the LECTURER's own location must be when setting the venue (metres). Keep it small: the venue centre is what every student is measured against.
    ATTENDANCE_CREATOR_MAX_ACCURACY_METERS: z.coerce.number().positive().max(1000).default(100),
    // GPS uncertainty (student + venue accuracy) may widen the allowed radius by at most this many metres. 0 = strict radius.
    ATTENDANCE_ACCURACY_ALLOWANCE_MAX_METERS: z.coerce.number().min(0).max(200).default(50),
    // Tell a rejected student roughly how far they appeared to be (rounded to 10 m).
    ATTENDANCE_SHOW_DISTANCE: z.enum(["true", "false"]).default("true"),
    DEVICE_CHANGE_LIMIT_30D: z.coerce.number().int().min(1).max(10).default(2),
    DEVICE_VERIFICATION_TTL_MINUTES: z.coerce.number().int().min(3).max(60).default(10),
    MAX_RESOURCE_MB: z.coerce.number().positive().max(50).default(15),
    MAX_SUBMISSION_MB: z.coerce.number().positive().max(25).default(10),
    MAX_ANNOUNCEMENT_IMAGE_MB: z.coerce.number().positive().max(10).default(5),
    // Web push (all three together, or none: push stays off). Generate with `npx web-push generate-vapid-keys`.
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),
    VAPID_SUBJECT: z.string().optional(),
    PUSH_EXTRA_ENDPOINT_HOSTS: z.string().optional(),
    PUSH_MAX_DEVICES_PER_USER: z.coerce.number().int().min(1).max(20).default(10),
    // Real-time (Socket.IO). A socket session lasts at most this long before the client must reconnect (which re-checks the token and the account).
    SOCKET_ENABLED: z.enum(["true", "false"]).default("true"),
    SOCKET_MAX_SESSION_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  })
  .superRefine((env, ctx) => {
    const vapid = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT];
    if (vapid.some(Boolean) && !vapid.every(Boolean)) {
      ctx.addIssue({ code: "custom", path: ["VAPID_PUBLIC_KEY"], message: "Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together (or none to keep push off)" });
    }
    if (env.VAPID_SUBJECT && !/^(mailto:|https:\/\/)/.test(env.VAPID_SUBJECT)) {
      ctx.addIssue({ code: "custom", path: ["VAPID_SUBJECT"], message: "VAPID_SUBJECT must start with mailto: or https://" });
    }
    if (env.VAPID_PUBLIC_KEY && !/^[A-Za-z0-9_-]{87}$/.test(env.VAPID_PUBLIC_KEY)) {
      ctx.addIssue({ code: "custom", path: ["VAPID_PUBLIC_KEY"], message: "VAPID_PUBLIC_KEY must be the 87-character URL-safe key from `web-push generate-vapid-keys`" });
    }
    const gmailKeys = ["GMAIL_USER", "GMAIL_APP_PASSWORD"] as const;
    if (gmailKeys.some((k) => env[k]) && !gmailKeys.every((k) => env[k])) {
      ctx.addIssue({ code: "custom", path: ["GMAIL_USER"], message: "Set GMAIL_USER and GMAIL_APP_PASSWORD together (or none in development)" });
    }
    if (env.NODE_ENV === "production") {
      for (const key of gmailKeys) {
        if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "Required in production" });
      }
      for (const key of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"] as const) {
        if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "Required in production" });
      }
      if (!env.EMAIL_FROM) {
        ctx.addIssue({ code: "custom", path: ["EMAIL_FROM"], message: "Required in production" });
      }
    }
  });

// Treat `KEY=` (empty) in .env the same as "not set".
const source = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ""));
const parsed = schema.safeParse(source);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const data = parsed.data;
const clientOrigins = data.CLIENT_URL.split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

export const env = {
  ...data,
  clientOrigins,
  /** Used when building links inside emails. */
  clientUrl: clientOrigins[0],
  isProduction: data.NODE_ENV === "production",
  socketEnabled: data.SOCKET_ENABLED === "true",
  pushConfigured: Boolean(data.VAPID_PUBLIC_KEY && data.VAPID_PRIVATE_KEY && data.VAPID_SUBJECT),
  pushExtraHosts: (data.PUSH_EXTRA_ENDPOINT_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
  gmailConfigured: Boolean(data.GMAIL_USER && data.GMAIL_APP_PASSWORD),
  cloudinaryConfigured: Boolean(data.CLOUDINARY_CLOUD_NAME && data.CLOUDINARY_API_KEY && data.CLOUDINARY_API_SECRET),
};