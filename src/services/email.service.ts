import fs from "fs";
import path from "path";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { deviceVerificationEmail, lecturerInviteEmail, lecturerResetEmail, passwordChangedEmail, passwordResetEmail, welcomeEmail } from "./email.templates";

/**
 * Reusable transactional email service (Gmail App Password, sent with Nodemailer).
 * In development with no Gmail settings the email is printed to the console instead.
 * Production requires GMAIL_USER and GMAIL_APP_PASSWORD (enforced in config/env.ts).
 */
let transporter: Transporter | null = null;
const getTransporter = (): Transporter | null => {
  if (!env.gmailConfigured) return null;
  transporter ??= nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: env.GMAIL_USER,
      pass: env.GMAIL_APP_PASSWORD?.replace(/\s/g, ""),
    },
  });
  return transporter;
};

// Banner image used by every email template (referenced there as cid:email-header).
const HEADER_IMAGE = path.resolve(process.cwd(), "assets", "email-header.png");

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const mailer = getTransporter();
  if (!mailer) {
    logger.warn(`[email:dev] Gmail not configured - printing instead of sending.\nTo: ${input.to}\nSubject: ${input.subject}\n${input.text}`);
    return;
  }
  // Gmail always sends from the authenticated account; EMAIL_FROM only controls the display name (or an alias you added under "Send mail as").
  await mailer.sendMail({
    from: env.EMAIL_FROM ?? `Departmental Portal <${env.GMAIL_USER}>`,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    attachments: fs.existsSync(HEADER_IMAGE)
      ? [{ filename: "email-header.png", path: HEADER_IMAGE, cid: "email-header" }]
      : [],
  });
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