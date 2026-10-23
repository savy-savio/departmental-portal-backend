import { env } from "../config/env";
import { logger } from "../utils/logger";
import { deviceVerificationEmail, lecturerInviteEmail, lecturerResetEmail, passwordChangedEmail, passwordResetEmail, welcomeEmail } from "./email.templates";

/**
 * Transactional email over HTTPS (Brevo API). Works on hosts that block SMTP ports.
 * In development with no BREVO_API_KEY the email is printed to the console instead.
 * Production requires BREVO_API_KEY and BREVO_SENDER_EMAIL (enforced in config/env.ts).
 */
const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

// The templates reference the banner as cid:email-header. The HTTP API has no inline attachments,
// so it is served as a normal image from the frontend (put assets/email-header.png in the frontend's public/ folder).
const headerUrl = (): string => env.EMAIL_HEADER_URL ?? `${env.clientUrl}/email-header.png`;

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  if (!env.emailConfigured) {
    logger.warn(`[email:dev] Brevo not configured - printing instead of sending.\nTo: ${input.to}\nSubject: ${input.subject}\n${input.text}`);
    return;
  }

  const recipients = (Array.isArray(input.to) ? input.to : [input.to]).map((email) => ({ email }));

  const res = await fetch(BREVO_URL, {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY as string,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: env.BREVO_SENDER_NAME, email: env.BREVO_SENDER_EMAIL },
      to: recipients,
      subject: input.subject,
      htmlContent: input.html.replaceAll("cid:email-header", headerUrl()),
      textContent: input.text,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Brevo ${res.status}: ${detail.slice(0, 300)}`);
  }
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