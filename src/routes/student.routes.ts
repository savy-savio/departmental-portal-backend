import { Router } from "express";
import * as ctrl from "../controllers/student-auth.controller";
import * as academic from "../controllers/student-academic.controller";
import * as courses from "../controllers/student-courses.controller";
import * as electionCtrl from "../controllers/student-elections.controller";
import * as quizCtrl from "../controllers/student-quiz.controller";
import { answerSchema, gameIdParams as quizGameParams, joinSchema } from "../validators/quiz.validators";
import * as svc from "../controllers/student-services.controller";
import * as profile from "../controllers/student-profile.controller";
import { pushController } from "../controllers/push.controller";
import * as pv from "../validators/push.validators";
import { authenticateOnboarding, authenticateStudent } from "../middleware/auth";
import {
  forgotPasswordLimiter,
  loginLimiter,
  studentPushLimiter,
  studentQuizAnswerLimiter,
  studentQuizJoinLimiter,
  studentQuizReadLimiter,
  onboardingLimiter,
  attendanceActionLimiter,
  attendanceIpBackstop,
  deviceRegisterLimiter,
  deviceVerificationLimiter,
  complaintLimiter,
  aiAssistLimiter,
  resetPasswordLimiter,
  uploadLimiter,
  voteLimiter,
  verifyLimiter,
} from "../middleware/rateLimiters";
import { complaintAttachmentUpload, profilePhotoUpload, submissionUpload } from "../middleware/upload";
import { validate } from "../middleware/validate";
import {
  announcementsQuery, assignmentsQuery, idParams, materialsQuery, submissionBody, timetableQuery,
} from "../validators/student-academic.validators";
import { addCourseSchema, enrollmentIdParams, updateEnrollmentSchema } from "../validators/student-courses.validators";
import { createComplaintSchema, complaintsQuery, updateComplaintSchema } from "../validators/student-complaints.validators";
import { complaintAiSchema } from "../validators/complaint-ai.validators";
import { challengeBody, markAttendanceBody, passwordBody, registerDeviceBody } from "../validators/student-attendance.validators";
import { attendanceQuery, notificationsQuery, sessionIdParams } from "../validators/student-services.validators";
import { castVotesSchema, electionIdParams } from "../validators/student-elections.validators";
import { updateProfileSchema } from "../validators/student-profile.validators";
import {
  changePasswordSchema,
  completeOnboardingSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  verifyIdentitySchema,
} from "../validators/student-auth.validators";

const router = Router();

/* Public: first-time onboarding */
router.post("/onboarding/verify", verifyLimiter, validate({ body: verifyIdentitySchema }), ctrl.verifyIdentity);
router.post(
  "/onboarding/complete",
  onboardingLimiter,
  authenticateOnboarding,
  validate({ body: completeOnboardingSchema }),
  ctrl.completeOnboarding,
);

/* Public: normal auth */
router.post("/auth/login", loginLimiter, validate({ body: loginSchema }), ctrl.login);
router.post("/auth/forgot-password", forgotPasswordLimiter, validate({ body: forgotPasswordSchema }), ctrl.forgotPassword);
router.post("/auth/reset-password", resetPasswordLimiter, validate({ body: resetPasswordSchema }), ctrl.resetPassword);

/* Protected */
router.post("/auth/logout", authenticateStudent, ctrl.logout);
router.patch("/change-password", authenticateStudent, validate({ body: changePasswordSchema }), ctrl.changePassword);

/* Profile (Stage 6) */
router.get("/profile", authenticateStudent, profile.getProfile);
router.patch("/profile", authenticateStudent, validate({ body: updateProfileSchema }), profile.updateProfile);
router.post("/profile/picture", authenticateStudent, uploadLimiter, profilePhotoUpload, profile.uploadPhoto);
router.delete("/profile/picture", authenticateStudent, profile.deletePhoto);

/* Courses & enrollment (Stage 7). Static paths first so they are never read as :enrollmentId. */
router.get("/courses", authenticateStudent, courses.listMine);
router.get("/courses/available", authenticateStudent, courses.listAvailable);
router.get("/courses/carryover-options", authenticateStudent, courses.listCarryoverOptions);
router.get("/courses/history", authenticateStudent, courses.history);
router.post("/courses", authenticateStudent, validate({ body: addCourseSchema }), courses.add);
router.patch(
  "/courses/:enrollmentId",
  authenticateStudent,
  validate({ params: enrollmentIdParams, body: updateEnrollmentSchema }),
  courses.update,
);
router.delete("/courses/:enrollmentId", authenticateStudent, validate({ params: enrollmentIdParams }), courses.remove);

/* Academic features (Stage 8) - read-only except assignment submissions */
router.get("/timetable", authenticateStudent, validate({ query: timetableQuery }), academic.getTimetable);
router.get("/announcements", authenticateStudent, validate({ query: announcementsQuery }), academic.listAnnouncements);
router.get("/announcements/:id", authenticateStudent, validate({ params: idParams }), academic.getAnnouncement);
router.get("/materials", authenticateStudent, validate({ query: materialsQuery }), academic.listMaterials);
router.get("/department-documents", authenticateStudent, academic.listDepartmentDocuments);
router.get("/assignments", authenticateStudent, validate({ query: assignmentsQuery }), academic.listAssignments);
router.get("/assignments/:id", authenticateStudent, validate({ params: idParams }), academic.getAssignment);
router.post(
  "/assignments/:id/submissions",
  authenticateStudent,
  uploadLimiter,
  validate({ params: idParams }),
  submissionUpload,
  validate({ body: submissionBody }),
  academic.submitAssignment,
);

/* Student services (Stage 9) */
router.get("/attendance", authenticateStudent, validate({ query: attendanceQuery }), svc.listAttendance);

// Attendance device (bound only to attendance; normal login on other devices is unaffected). Static paths before :sessionId.
router.get("/attendance/device", authenticateStudent, svc.deviceStatus);
router.post(
  "/attendance/device/verification",
  authenticateStudent, deviceVerificationLimiter, validate({ body: passwordBody }), svc.requestDeviceVerification,
);
router.post(
  "/attendance/device/register",
  authenticateStudent, deviceRegisterLimiter, validate({ body: registerDeviceBody }), svc.registerDevice,
);
// Two-step marking: challenge (short-lived single-use token) -> mark (token + location).
router.post(
  "/attendance/:sessionId/challenge",
  authenticateStudent, attendanceIpBackstop, attendanceActionLimiter, validate({ params: sessionIdParams, body: challengeBody }), svc.createChallenge,
);
router.post(
  "/attendance/:sessionId",
  authenticateStudent, attendanceIpBackstop, attendanceActionLimiter, validate({ params: sessionIdParams, body: markAttendanceBody }), svc.markAttendance,
);

// Static complaint paths before :id so they are never read as an id.
router.get("/complaints", authenticateStudent, validate({ query: complaintsQuery }), svc.listComplaints);
router.get("/complaints/stats", authenticateStudent, svc.complaintStats);
router.get("/complaints/upload-constraints", authenticateStudent, svc.complaintConstraints);
router.post("/complaints", authenticateStudent, complaintLimiter, validate({ body: createComplaintSchema }), svc.createComplaint);
// AI writing assistant (stateless: returns a suggestion, saves nothing). Static paths, so they stay above "/complaints/:id".
router.get("/complaints/ai-assist", authenticateStudent, svc.complaintAiInfo);
router.post("/complaints/ai-assist", authenticateStudent, aiAssistLimiter, validate({ body: complaintAiSchema }), svc.complaintAiAssist);
router.get("/complaints/:id", authenticateStudent, validate({ params: idParams }), svc.getComplaint);
router.patch("/complaints/:id", authenticateStudent, validate({ params: idParams, body: updateComplaintSchema }), svc.updateComplaint);
router.post(
  "/complaints/:id/attachments",
  authenticateStudent,
  uploadLimiter,
  validate({ params: idParams }),
  complaintAttachmentUpload,
  svc.addComplaintAttachment,
);

router.get("/notifications", authenticateStudent, validate({ query: notificationsQuery }), svc.listNotifications);
router.patch("/notifications/read-all", authenticateStudent, svc.markAllNotificationsRead);
router.patch("/notifications/:id/read", authenticateStudent, validate({ params: idParams }), svc.markNotificationRead);

/* Browser push (devices + preferences). The owner is the authenticated student (never a request field); reps are students, so they use these too. */
const push = pushController((req) => ({ userId: String(req.student!._id), userType: "STUDENT", departmentId: String(req.department!._id) }));
router.get("/push/config", authenticateStudent, push.config);
router.get("/push/subscriptions", authenticateStudent, push.devices);
router.post("/push/subscriptions", authenticateStudent, studentPushLimiter, validate({ body: pv.pushSubscribeSchema }), push.subscribe);
router.delete("/push/subscriptions", authenticateStudent, studentPushLimiter, validate({ body: pv.pushUnsubscribeSchema }), push.unsubscribe);
router.delete("/push/subscriptions/:id", authenticateStudent, studentPushLimiter, validate({ params: pv.pushSubscriptionIdParams }), push.removeDevice);
router.get("/push/preferences", authenticateStudent, push.preferences);
router.put("/push/preferences", authenticateStudent, studentPushLimiter, validate({ body: pv.pushPreferencesSchema }), push.updatePreferences);
router.post("/push/test", authenticateStudent, studentPushLimiter, push.test);

/* Departmental elections (Stage 10). Department comes from the JWT; ineligible elections are a 404. */
router.get("/elections", authenticateStudent, electionCtrl.list);
router.get("/elections/:electionId", authenticateStudent, validate({ params: electionIdParams }), electionCtrl.get);
router.get("/elections/:electionId/results", authenticateStudent, validate({ params: electionIdParams }), electionCtrl.results);
router.post(
  "/elections/:electionId/vote",
  authenticateStudent,
  voteLimiter,
  validate({ params: electionIdParams, body: castVotesSchema }),
  electionCtrl.vote,
);

/* live quiz (play): the student, department and level come from the token; eligibility for a game is checked in the service. */
router.post("/quiz/join", authenticateStudent, studentQuizJoinLimiter, validate({ body: joinSchema }), quizCtrl.join);
router.get("/quiz/active", authenticateStudent, studentQuizReadLimiter, quizCtrl.active);
router.get("/quiz/results", authenticateStudent, studentQuizReadLimiter, quizCtrl.results);
router.get("/quiz/games/:gameId", authenticateStudent, studentQuizReadLimiter, validate({ params: quizGameParams }), quizCtrl.gameState);
router.post("/quiz/games/:gameId/answer", authenticateStudent, studentQuizAnswerLimiter, validate({ params: quizGameParams, body: answerSchema }), quizCtrl.answer);
router.post("/quiz/games/:gameId/leave", authenticateStudent, studentQuizReadLimiter, validate({ params: quizGameParams }), quizCtrl.leave);
router.get("/quiz/games/:gameId/result", authenticateStudent, studentQuizReadLimiter, validate({ params: quizGameParams }), quizCtrl.result);

export default router;
