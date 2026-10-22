const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

interface Rendered {
  subject: string;
  html: string;
  text: string;
}

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:28px">
<tr><td><h2 style="margin:0 0 16px;font-size:20px">${escapeHtml(title)}</h2>${bodyHtml}
<p style="margin:24px 0 0;font-size:12px;color:#6b7280">Departmental Portal &middot; This is an automated message, please do not reply.</p>
</td></tr></table></body></html>`;
}

const button = (url: string, label: string): string =>
  `<p style="margin:20px 0"><a href="${escapeHtml(url)}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block">${escapeHtml(label)}</a></p>`;

export function passwordResetEmail(p: { firstName: string; resetUrl: string; expiresInMinutes: number }): Rendered {
  return {
    subject: "Reset your portal password",
    html: layout(
      "Reset your password",
      `<p>Hi ${escapeHtml(p.firstName)},</p>
<p>We received a request to reset your password. This link expires in ${p.expiresInMinutes} minutes and can be used once.</p>
${button(p.resetUrl, "Reset password")}
<p style="font-size:13px;color:#6b7280">If the button doesn't work, copy this link into your browser:<br>${escapeHtml(p.resetUrl)}</p>
<p>If you didn't ask for this, you can ignore this email. Your password won't change.</p>`,
    ),
    text: `Hi ${p.firstName},\n\nReset your password using this link (valid for ${p.expiresInMinutes} minutes, one use):\n${p.resetUrl}\n\nIf you didn't request this, ignore this email.`,
  };
}

export function welcomeEmail(p: { firstName: string; loginUrl: string }): Rendered {
  return {
    subject: "Your portal account is ready",
    html: layout(
      "Welcome to the portal",
      `<p>Hi ${escapeHtml(p.firstName)},</p><p>Your account has been set up. You can now sign in with your email and password.</p>${button(p.loginUrl, "Go to login")}`,
    ),
    text: `Hi ${p.firstName},\n\nYour account has been set up. Sign in here: ${p.loginUrl}`,
  };
}

export function passwordChangedEmail(p: { firstName: string }): Rendered {
  return {
    subject: "Your portal password was changed",
    html: layout(
      "Password changed",
      `<p>Hi ${escapeHtml(p.firstName)},</p><p>The password on your portal account was just changed. If this wasn't you, reset your password immediately and contact your department.</p>`,
    ),
    text: `Hi ${p.firstName},\n\nThe password on your portal account was just changed. If this wasn't you, reset it immediately and contact your department.`,
  };
}

export function deviceVerificationEmail(p: { firstName: string; code: string; purpose: "REGISTER" | "REPLACE"; expiresInMinutes: number }): Rendered {
  const what = p.purpose === "REPLACE" ? "replace your attendance device" : "set up this device for attendance";
  return {
    subject: "Your attendance device verification code",
    html: layout(
      "Verify your attendance device",
      `<p>Hi ${escapeHtml(p.firstName)},</p>
<p>Use this code to ${what}. It expires in ${p.expiresInMinutes} minutes and works once.</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:bold;margin:18px 0">${escapeHtml(p.code)}</p>
<p>If you didn't ask for this, someone may know your password. Change it now and tell your department.</p>`,
    ),
    text: `Hi ${p.firstName},\n\nYour code to ${what}: ${p.code}\nIt expires in ${p.expiresInMinutes} minutes and works once.\n\nIf you didn't ask for this, change your password now and tell your department.`,
  };
}

export function lecturerInviteEmail(p: { firstName: string; activateUrl: string; expiresInHours: number }): Rendered {
  return {
    subject: "Activate your lecturer account",
    html: layout("Activate your account", `<p>Hi ${escapeHtml(p.firstName)},</p><p>Your department has created a lecturer account for you on the portal. Set your password to activate it. This link expires in ${p.expiresInHours} hours and works once.</p>${button(p.activateUrl, "Activate account")}<p style="font-size:13px;color:#6b7280">${escapeHtml(p.activateUrl)}</p>`),
    text: `Hi ${p.firstName},\n\nYour department created a lecturer account for you. Activate it here (expires in ${p.expiresInHours} hours, one use):\n${p.activateUrl}`,
  };
}
export function lecturerResetEmail(p: { firstName: string; resetUrl: string; expiresInMinutes: number }): Rendered {
  return {
    subject: "Reset your portal password",
    html: layout("Reset your password", `<p>Hi ${escapeHtml(p.firstName)},</p><p>Use this link to reset your password. It expires in ${p.expiresInMinutes} minutes and works once.</p>${button(p.resetUrl, "Reset password")}<p>If you didn't ask for this, ignore this email.</p>`),
    text: `Hi ${p.firstName},\n\nReset your password (valid ${p.expiresInMinutes} minutes, one use):\n${p.resetUrl}`,
  };
}
