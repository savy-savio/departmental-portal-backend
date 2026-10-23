const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

interface Rendered {
  subject: string;
  html: string;
  text: string;
}

const BRAND = {
  green: "#168540", // portal sign-in green
  page: "#0F6B33", // darker green behind the card so the rounded corners show
  lightGreen: "#EAF6EE",
  text: "#17251C",
  muted: "#68776D",
  border: "#E1E9E3",
  white: "#FFFFFF",
};

const FONT = "Arial, Helvetica, sans-serif";

/**
 * Shared layout. The banner (portal pattern + NACOS logo) is attached by
 * email.service.ts from assets/email-header.png and referenced here as cid:email-header.
 */
function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.page};border-radius:16px;font-family:${FONT};color:${BRAND.text}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${BRAND.page}" style="background:${BRAND.page}">
<tr><td align="center" style="padding:32px 14px">

  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%">

    <!-- Banner: portal pattern + NACOS logo -->
    <tr><td bgcolor="${BRAND.green}" style="background:${BRAND.green};border-radius:16px;line-height:0;font-size:0">
      <img src="cid:email-header" width="600" alt="NACOS Student Portal"
        style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:16px;color:#ffffff;font-family:${FONT};font-size:20px;font-weight:bold;line-height:1.4" />
    </td></tr>

    <tr><td height="12" style="height:12px;line-height:12px;font-size:12px">&nbsp;</td></tr>

    <!-- Card -->
    <tr><td bgcolor="${BRAND.white}" style="background:${BRAND.white};border-radius:16px;padding:36px 32px">
      <h1 style="margin:0 0 22px;color:${BRAND.text};font-family:${FONT};font-size:25px;font-weight:bold;line-height:1.35;letter-spacing:-0.4px">${escapeHtml(title)}</h1>
      ${bodyHtml}
    </td></tr>

    <!-- Footer -->
    <tr><td align="center" style="padding:24px 12px 0">
      <p style="margin:0;color:#D6EBDD;font-family:${FONT};font-size:12px;line-height:1.8">Departmental Portal &middot; This is an automated message, please do not reply.</p>
    </td></tr>

  </table>

</td></tr>
</table>
</body>
</html>`;
}

const paragraph = (content: string): string =>
  `<p style="margin:0 0 18px;color:${BRAND.text};font-family:${FONT};font-size:15px;line-height:1.8">${content}</p>`;

const button = (url: string, label: string): string =>
  `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:26px 0"><tr>
<td bgcolor="${BRAND.green}" style="border-radius:8px"><a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:15px 28px;color:#ffffff;font-family:${FONT};font-size:15px;font-weight:bold;line-height:20px;text-decoration:none;border-radius:8px">${escapeHtml(label)}</a></td>
</tr></table>`;

/** The raw link, shown under a button for when the button doesn't work. */
const linkFallback = (url: string, intro = "If the button doesn't work, copy this link into your browser:"): string =>
  paragraph(
    `<span style="font-size:13px;color:${BRAND.muted}">${escapeHtml(intro)}<br /><a href="${escapeHtml(url)}" style="color:${BRAND.green};overflow-wrap:anywhere;word-break:break-all">${escapeHtml(url)}</a></span>`,
  );

/** Light-green panel for key details (expiry, codes). */
const infoBox = (content: string): string =>
  `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0;border-collapse:separate"><tr>
<td bgcolor="${BRAND.lightGreen}" style="background:${BRAND.lightGreen};border:1px solid #D3EADB;border-radius:12px;padding:18px 20px;color:${BRAND.text};font-family:${FONT};font-size:14px;line-height:1.7">${content}</td>
</tr></table>`;

/** Amber panel for "if this wasn't you" warnings. */
const notice = (content: string): string =>
  `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:24px;border-collapse:separate"><tr>
<td bgcolor="#FFF8E8" style="background:#FFF8E8;border:1px solid #F3E4BC;border-radius:12px;padding:16px 18px;color:#72551A;font-family:${FONT};font-size:13px;line-height:1.7">${content}</td>
</tr></table>`;

export function passwordResetEmail(p: { firstName: string; resetUrl: string; expiresInMinutes: number }): Rendered {
  return {
    subject: "Reset your portal password",
    html: layout(
      "Reset your password",
      `${paragraph(`Hi ${escapeHtml(p.firstName)},`)}
${paragraph("We received a request to reset your password.")}
${infoBox(`This link expires in <strong>${p.expiresInMinutes} minutes</strong> and can be used once.`)}
${button(p.resetUrl, "Reset password")}
${linkFallback(p.resetUrl)}
${notice("If you didn't ask for this, you can ignore this email. Your password won't change.")}`,
    ),
    text: `Hi ${p.firstName},\n\nReset your password using this link (valid for ${p.expiresInMinutes} minutes, one use):\n${p.resetUrl}\n\nIf you didn't request this, ignore this email.`,
  };
}

export function welcomeEmail(p: { firstName: string; loginUrl: string }): Rendered {
  return {
    subject: "Your portal account is ready",
    html: layout(
      "Welcome to the portal",
      `${paragraph(`Hi ${escapeHtml(p.firstName)},`)}
${paragraph("Your account has been set up. You can now sign in with your email and password.")}
${button(p.loginUrl, "Go to login")}`,
    ),
    text: `Hi ${p.firstName},\n\nYour account has been set up. Sign in here: ${p.loginUrl}`,
  };
}

export function passwordChangedEmail(p: { firstName: string }): Rendered {
  return {
    subject: "Your portal password was changed",
    html: layout(
      "Password changed",
      `${paragraph(`Hi ${escapeHtml(p.firstName)},`)}
${paragraph("The password on your portal account was just changed.")}
${notice("If this wasn't you, reset your password immediately and contact your department.")}`,
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
      `${paragraph(`Hi ${escapeHtml(p.firstName)},`)}
${paragraph(`Use this code to ${escapeHtml(what)}. It expires in ${p.expiresInMinutes} minutes and works once.`)}
${infoBox(`<p style="margin:0;text-align:center;color:${BRAND.green};font-family:${FONT};font-size:32px;font-weight:bold;letter-spacing:8px;line-height:1.5">${escapeHtml(p.code)}</p>`)}
${notice("If you didn't ask for this, someone may know your password. Change it now and tell your department.")}`,
    ),
    text: `Hi ${p.firstName},\n\nYour code to ${what}: ${p.code}\nIt expires in ${p.expiresInMinutes} minutes and works once.\n\nIf you didn't ask for this, change your password now and tell your department.`,
  };
}

export function lecturerInviteEmail(p: { firstName: string; activateUrl: string; expiresInHours: number }): Rendered {
  return {
    subject: "Activate your lecturer account",
    html: layout(
      "Activate your account",
      `${paragraph(`Hi ${escapeHtml(p.firstName)},`)}
${paragraph("Your department has created a lecturer account for you on the portal. Set your password to activate it.")}
${infoBox(`This link expires in <strong>${p.expiresInHours} hours</strong> and works once.`)}
${button(p.activateUrl, "Activate account")}
${linkFallback(p.activateUrl, "Unable to use the button? Copy this link into your browser:")}`,
    ),
    text: `Hi ${p.firstName},\n\nYour department created a lecturer account for you. Activate it here (expires in ${p.expiresInHours} hours, one use):\n${p.activateUrl}`,
  };
}

export function lecturerResetEmail(p: { firstName: string; resetUrl: string; expiresInMinutes: number }): Rendered {
  return {
    subject: "Reset your portal password",
    html: layout(
      "Reset your password",
      `${paragraph(`Hi ${escapeHtml(p.firstName)},`)}
${paragraph("Use this link to reset your password.")}
${infoBox(`This link expires in <strong>${p.expiresInMinutes} minutes</strong> and works once.`)}
${button(p.resetUrl, "Reset password")}
${notice("If you didn't ask for this, ignore this email.")}`,
    ),
    text: `Hi ${p.firstName},\n\nReset your password (valid ${p.expiresInMinutes} minutes, one use):\n${p.resetUrl}`,
  };
}