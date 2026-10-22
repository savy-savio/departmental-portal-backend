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
export const globalLimiter = make(15 * MIN, 600, "Too many requests. Please slow down.", isLiveQuizRequest);
export const loginLimiter = make(15 * MIN, 20, "Too many login attempts. Please try again later.");
export const verifyLimiter = make(15 * MIN, 10, "Too many verification attempts. Please try again later.");
export const onboardingLimiter = make(15 * MIN, 20, "Too many attempts. Please try again later.");
export const forgotPasswordLimiter = make(60 * MIN, 5, "Too many reset requests. Please try again later.");
export const resetPasswordLimiter = make(15 * MIN, 10, "Too many attempts. Please try again later.");
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
