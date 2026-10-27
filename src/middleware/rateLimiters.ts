import rateLimit from "express-rate-limit";

const make = (windowMs: number, limit: number, message: string, skip?: (req: { originalUrl: string }) => boolean) =>
  rateLimit({
    windowMs,
    limit,
    ...(skip ? { skip } : {}),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ success: false, message });
    },
  });

const MIN = 60 * 1000;

/** Connectivity probe: very high ceiling (a campus NAT puts many users behind one IP); it only blunts a flood of a no-work endpoint. */
export const pingLimiter = make(MIN, 6000, "Too many requests.");
/**
 * Live quiz traffic is exempt from the per-IP global limit: a whole class on one campus Wi-Fi shares an IP and each phone re-reads its state every few
 * seconds, which would otherwise lock everybody out mid-game. These endpoints have their own per-STUDENT limits instead (below).
 */
const LIVE_QUIZ_PATHS = ["/api/v1/student/quiz/", "/api/v1/representative/quiz-games"];
export const isLiveQuizRequest = (req: { originalUrl: string }) => LIVE_QUIZ_PATHS.some((p) => req.originalUrl.startsWith(p));
export const globalLimiter = make(15 * MIN, 6000, "Too many requests. Please slow down.", isLiveQuizRequest);
/**
 * Public auth limiters. A whole class shares one campus Wi-Fi IP (and behind an unconfigured proxy EVERY user shares the proxy's IP), so a
 * plain per-IP cap locks classmates out after a handful of tries. These are keyed by the IDENTITY being attempted (matric number / email),
 * so one person's typos never block anyone else, and they count FAILED attempts only, so a successful sign-in never uses up the allowance.
 * A generous per-IP failure cap sits behind them purely as a flood backstop (far above any real classroom).
 */
const identityOf = (pick: (body: Record<string, unknown>) => unknown) => (req: { body?: unknown; ip?: string }) => {
  const raw = pick((req.body ?? {}) as Record<string, unknown>);
  const id = typeof raw === "string" ? raw.trim().toLowerCase().replace(/\s+/g, "") : "";
  return id ? `id:${id.slice(0, 80)}` : `ip:${req.ip ?? "unknown"}`;
};
const makeByIdentity = (
  windowMs: number, limit: number, message: string, key: (req: { body?: unknown; ip?: string }) => string, failedOnly = true,
) =>
  rateLimit({
    windowMs, limit, skipSuccessfulRequests: failedOnly, standardHeaders: "draft-7", legacyHeaders: false, keyGenerator: (req) => key(req),
    handler: (_req, res) => void res.status(429).json({ success: false, message }),
  });
const byMatric = identityOf((b) => b.matricNumber);
const byEmail = identityOf((b) => b.email);
const authIpBackstop = (message: string, windowMs = 15 * MIN, limit = 300, failedOnly = true) =>
  rateLimit({
    windowMs, limit, skipSuccessfulRequests: failedOnly, standardHeaders: "draft-7", legacyHeaders: false,
    keyGenerator: (req) => `ip:${req.ip ?? "unknown"}`,
    handler: (_req, res) => void res.status(429).json({ success: false, message }),
  });

export const loginLimiter = [
  makeByIdentity(15 * MIN, 10, "Too many login attempts. Please try again later.", byEmail),
  authIpBackstop("Too many login attempts from this network. Please try again later."),
];
export const verifyLimiter = [
  makeByIdentity(15 * MIN, 10, "Too many verification attempts for this matric number. Please try again in a few minutes.", byMatric),
  authIpBackstop("Too many verification attempts from this network. Please try again later."),
];
// /onboarding/complete is already gated by the short-lived signed onboarding token, so only a flood backstop is needed.
export const onboardingLimiter = authIpBackstop("Too many attempts. Please try again later.");
// Every forgot-password request sends an email, so ALL requests count (not just failures), per email address.
export const forgotPasswordLimiter = [
  makeByIdentity(60 * MIN, 5, "Too many reset requests for this email. Please try again later.", byEmail, false),
  authIpBackstop("Too many reset requests from this network. Please try again later.", 60 * MIN, 200, false),
];
// Reset is gated by a 32+ char random token, so only a flood backstop is needed.
export const resetPasswordLimiter = authIpBackstop("Too many attempts. Please try again later.", 15 * MIN, 200);
export const uploadLimiter = make(60 * MIN, 30, "Too many uploads. Please try again later.");
export const complaintLimiter = make(60 * MIN, 10, "You're submitting complaints too quickly. Please try again later.");
export const voteLimiter = make(15 * MIN, 20, "Too many voting attempts. Please try again later.");

/**
 * Attendance limits are keyed by the authenticated STUDENT. Keying by IP would lock out a whole lecture hall
 * sharing one Wi-Fi network. (Run these AFTER authenticateStudent.)
 */
const byStudent = (req: { student?: { _id: unknown } }) => String(req.student?._id ?? "anonymous");
const makeKeyed = (windowMs: number, limit: number, message: string) =>
  rateLimit({
    windowMs, limit, standardHeaders: "draft-7", legacyHeaders: false, keyGenerator: (req) => byStudent(req),
    handler: (_req, res) => void res.status(429).json({ success: false, message }),
  });
export const attendanceActionLimiter = makeKeyed(15 * MIN, 30, "Too many attendance attempts. Please try again later.");
export const deviceVerificationLimiter = makeKeyed(60 * MIN, 4, "Too many verification requests. Please try again later.");
export const deviceRegisterLimiter = makeKeyed(60 * MIN, 10, "Too many attempts. Please try again later.");
/** Generous per-IP backstop against floods only; far above any real classroom. */
export const attendanceIpBackstop = make(15 * MIN, 3000, "Too many requests from this network. Please try again later.");
export const repWriteLimiter = makeKeyed(60 * MIN, 120, "You're making changes too quickly. Please try again later.");
export const repUploadLimiter = makeKeyed(60 * MIN, 30, "Too many uploads. Please try again later.");

/** Lecturer limits are keyed by the authenticated lecturer (run after authenticateLecturer). */
const byLecturer = (req: { lecturerCtx?: { actor: { lecturerId: string } } }) => String(req.lecturerCtx?.actor.lecturerId ?? "anonymous");
const makeLecturerKeyed = (windowMs: number, limit: number, message: string) =>
  rateLimit({ windowMs, limit, standardHeaders: "draft-7", legacyHeaders: false, keyGenerator: (req) => byLecturer(req), handler: (_req, res) => void res.status(429).json({ success: false, message }) });
export const studentQuizReadLimiter = makeKeyed(MIN, 60, "Too many requests. Please wait a moment.");
export const studentQuizJoinLimiter = makeKeyed(10 * MIN, 30, "Too many tries. Please wait a few minutes before entering a PIN again."); // slows PIN guessing
export const studentQuizAnswerLimiter = makeKeyed(MIN, 90, "Too many requests. Please wait a moment.");
export const repQuizLimiter = makeKeyed(15 * MIN, 400, "You're doing that too quickly. Please wait a moment.");
export const studentPushLimiter = makeKeyed(15 * MIN, 60, "Too many notification settings changes. Please try again later.");
/** Each AI call costs money, so it is limited per student (run after authenticateStudent). A real drafting session is ~5-10 calls. */
export const aiAssistLimiter = makeKeyed(60 * MIN, 30, "You've used the AI assistant a lot. Please try again a bit later.");
export const lecturerWriteLimiter = makeLecturerKeyed(60 * MIN, 300, "You're making changes too quickly. Please try again later.");
export const lecturerUploadLimiter = makeLecturerKeyed(60 * MIN, 60, "Too many uploads. Please try again later.");

/** HOD limits are keyed by the authenticated HOD (run after authenticateHod). */
const byHod = (req: { hodCtx?: { actor: { hodId: string } } }) => String(req.hodCtx?.actor.hodId ?? "anonymous");
const makeHodKeyed = (windowMs: number, limit: number, message: string) =>
  rateLimit({ windowMs, limit, standardHeaders: "draft-7", legacyHeaders: false, keyGenerator: (req) => byHod(req), handler: (_req, res) => void res.status(429).json({ success: false, message }) });
export const lecturerPushLimiter = makeLecturerKeyed(15 * MIN, 60, "Too many notification settings changes. Please try again later.");
export const hodPushLimiter = makeHodKeyed(15 * MIN, 60, "Too many notification settings changes. Please try again later.");
export const hodWriteLimiter = makeHodKeyed(60 * MIN, 600, "You're making changes too quickly. Please try again later.");
export const hodUploadLimiter = makeHodKeyed(60 * MIN, 60, "Too many uploads. Please try again later.");