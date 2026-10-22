import { Resend } from "resend";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { deviceVerificationEmail, lecturerInviteEmail, lecturerResetEmail, passwordChangedEmail, passwordResetEmail, welcomeEmail } from "./email.templates";

/**
 * Reusable transactional email service (Resend).
 * In development with no RESEND_API_KEY the email is printed to the console instead,
 * so the reset flow can be tested without an email account. Production requires the key
 * (enforced in config/env.ts).
 */
let client: Resend | null = null;
const getClient = (): Resend | null => {
  if (!env.RESEND_API_KEY) return null;
  client ??= new Resend(env.RESEND_API_KEY);
  return client;
};

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const resend = getClient();
  if (!resend) {
    logger.warn(`[email:dev] RESEND_API_KEY not set - printing instead of sending.\nTo: ${input.to}\nSubject: ${input.subject}\n${input.text}`);
    return;
  }
  const { error } = await resend.emails.send({
    from: env.EMAIL_FROM ?? "Departmental Portal <onboarding@resend.dev>",
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
  });
  if (error) throw new Error(`Resend failed: ${error.message}`);
}

/** Emails must never break the main request, and must never leak whether an account exists. */
export function sendInBackground(label: string, task: Promise<void>): void {
  task.catch((err) => logger.error(`Email "${label}" failed:`, err instanceof Error ? err.message : err));
}

export const sendPasswordResetEmail = (to: string, firstName: string, rawToken: string): Promise<void> =>
  sendEmail({
    to,
    ...passwordResetEmail({
      firstName,
      resetUrl: `${env.clientUrl}/reset-password?token=${encodeURIComponent(rawToken)}`,
      expiresInMinutes: env.PASSWORD_RESET_EXPIRES_MINUTES,
    }),
  });

export const sendWelcomeEmail = (to: string, firstName: string): Promise<void> =>
  sendEmail({ to, ...welcomeEmail({ firstName, loginUrl: `${env.clientUrl}/login` }) });

export const sendPasswordChangedEmail = (to: string, firstName: string): Promise<void> =>
  sendEmail({ to, ...passwordChangedEmail({ firstName }) });

export const sendDeviceVerificationEmail = (to: string, firstName: string, code: string, purpose: "REGISTER" | "REPLACE"): Promise<void> =>
  sendEmail({ to, ...deviceVerificationEmail({ firstName, code, purpose, expiresInMinutes: env.DEVICE_VERIFICATION_TTL_MINUTES }) });

export const sendLecturerInviteEmail = (to: string, firstName: string, rawToken: string, expiresInHours: number): Promise<void> =>
  sendEmail({ to, ...lecturerInviteEmail({ firstName, activateUrl: `${env.clientUrl}/lecturer/activate?token=${encodeURIComponent(rawToken)}`, expiresInHours }) });
export const sendLecturerResetEmail = (to: string, firstName: string, rawToken: string): Promise<void> =>
  sendEmail({ to, ...lecturerResetEmail({ firstName, resetUrl: `${env.clientUrl}/lecturer/reset-password?token=${encodeURIComponent(rawToken)}`, expiresInMinutes: env.PASSWORD_RESET_EXPIRES_MINUTES }) });

export const sendHodInviteEmail = (to: string, firstName: string, rawToken: string, expiresInHours: number): Promise<void> =>
  sendEmail({ to, ...lecturerInviteEmail({ firstName, activateUrl: `${env.clientUrl}/hod/activate?token=${encodeURIComponent(rawToken)}`, expiresInHours }) });
export const sendHodResetEmail = (to: string, firstName: string, rawToken: string): Promise<void> =>
  sendEmail({ to, ...lecturerResetEmail({ firstName, resetUrl: `${env.clientUrl}/hod/reset-password?token=${encodeURIComponent(rawToken)}`, expiresInMinutes: env.PASSWORD_RESET_EXPIRES_MINUTES }) });
