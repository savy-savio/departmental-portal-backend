import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { EMAIL_HEADER_PNG_BASE64 } from "./email-header";
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
const HEADER_IMAGE = Buffer.from(EMAIL_HEADER_PNG_BASE64, "base64");

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
    attachments: [{ filename: "email-header.png", content: HEADER_IMAGE, contentType: "image/png", cid: "email-header" }],
  });
}