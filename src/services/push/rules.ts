/** Pure push-notification rules: classification, lock-screen-safe payloads, destination and endpoint validation. */

export const PUSH_CATEGORIES = ["announcements", "timetablesAndMaterials", "assignments", "complaints"] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];
export type PushUserType = "STUDENT" | "LECTURER" | "HOD";
export type PushCategoryPrefs = Record<PushCategory, boolean>;
export const DEFAULT_CATEGORY_PREFS: PushCategoryPrefs = { announcements: true, timetablesAndMaterials: true, assignments: true, complaints: true };

export interface PushableNotification {
  id: string;
  recipientId: string;
  recipientType: PushUserType;
  departmentId: string;
  kind: string;
  title: string;
  body: string;
  link?: string | null;
  complaintId?: string | null;
}

const COMPLAINT_KINDS = new Set(["SUBMITTED", "STATUS_CHANGED", "ASSIGNED", "RESOLVED", "INFO_REQUESTED", "RESPONSE"]);

/**
 * Which preference category a notification belongs to, or null when it is NOT pushed (attendance, elections, role changes and other
 * system messages stay in-app only: push is limited to the events the portal's academic and complaint workflows define).
 */
export function categoryOf(n: Pick<PushableNotification, "kind" | "link" | "complaintId">): PushCategory | null {
  if (n.complaintId || (n.link && /\/complaints(\/|$|\?)/.test(n.link)) || COMPLAINT_KINDS.has(n.kind)) return "complaints";
  switch (n.kind) {
    case "ANNOUNCEMENT": return "announcements";
    case "MATERIAL":
    case "TIMETABLE": return "timetablesAndMaterials";
    case "ASSIGNMENT": return "assignments";
    default: return null;
  }
}

/**
 * A portal-relative destination: "/student/materials" yes; "https://evil.example", "//evil.example", "javascript:..." and anything with
 * control characters no. Returns null for anything that is not a safe in-app path.
 */
export function safePortalPath(link: string | null | undefined): string | null {
  if (typeof link !== "string") return null;
  const p = link.trim();
  if (!p || p.length > 200 || !p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return null;
  if (!/^\/[A-Za-z0-9\-._~/?=&%#@+,:]*$/.test(p)) return null;
  if (/:\/\//.test(p)) return null; // no embedded absolute URLs
  return p;
}
const HOME: Record<PushUserType, string> = { STUDENT: "/student", LECTURER: "/lecturer", HOD: "/hod" };

export interface PushPayload { title: string; body: string; url: string; tag: string; category: PushCategory }
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * What appears on a (possibly locked) screen. Complaint pushes are deliberately generic: no reference number, no complaint title, no student
 * name, no lecturer / HOD message text: the details are only visible after the user signs in to the portal.
 */
export function buildPushPayload(n: PushableNotification, category: PushCategory): PushPayload {
  const url = safePortalPath(n.link) ?? HOME[n.recipientType];
  if (category === "complaints") return { title: "Complaint update", body: "There is an update on a complaint. Open the portal to view it.", url, tag: n.id, category };
  return { title: clip(n.title, 80), body: clip(n.body, 120), url, tag: n.id, category };
}

export const DEFAULT_PUSH_HOST_SUFFIXES = [
  "fcm.googleapis.com", // Chrome, Edge, Brave, Opera, Android browsers
  "updates.push.services.mozilla.com", "push.services.mozilla.com", // Firefox
  "web.push.apple.com", "push.apple.com", // Safari / iOS web apps
  "notify.windows.com", // legacy Edge / Windows
];
/**
 * The server POSTs to the subscription endpoint, so an attacker-supplied endpoint would be a server-side request forgery vector.
 * Only https URLs on a known browser push service (no credentials, default port) are accepted; extra hosts come from configuration.
 */
export function isAllowedPushEndpoint(endpoint: string, extraHosts: string[] = []): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || endpoint.length > 2048) return false;
  const host = u.hostname.toLowerCase();
  return [...DEFAULT_PUSH_HOST_SUFFIXES, ...extraHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)].some((s) => host === s || host.endsWith(`.${s}`));
}

/** Short, harmless device description derived from the User-Agent (never the raw header). */
export function deviceLabelFrom(userAgent: string | undefined, given?: string): string {
  if (given?.trim()) return given.trim().slice(0, 60);
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** Statuses meaning "this subscription is gone for good": delete it. Everything else is a transient failure that is counted. */
export const isGoneStatus = (status: number | undefined) => status === 404 || status === 410;
export const MAX_CONSECUTIVE_FAILURES = 5;
