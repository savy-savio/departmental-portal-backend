import { Router } from "express";
import * as ctrl from "../controllers/representative.controller";
import * as quizCtrl from "../controllers/quiz-host.controller";
import { gameIdParams, gamePlayerParams, quizIdParams, quizInputSchema } from "../validators/quiz.validators";
import { authenticateStudent } from "../middleware/auth";
import { repQuizLimiter, repUploadLimiter, repWriteLimiter } from "../middleware/rateLimiters";
import { requireAssignedCourse, requireRepresentative, requireRepresentativePermission } from "../middleware/representative";
import { announcementImageUpload, resourceUpload } from "../middleware/upload";
import { validate } from "../middleware/validate";
import { notificationsQuery } from "../validators/student-services.validators";
import {
  announcementIdParams, courseIdParams, courseScopedQuery, createAnnouncementSchema, createResourceSchema, membersQuery,
  createTimetableSchema, resourceIdParams, timetableIdParams, timetableQuery, updateAnnouncementSchema, updateResourceSchema, updateTimetableSchema,
} from "../validators/representative.validators";

/**
 * /api/v1/representative: one shared surface for Course Reps and Assistant Course Reps.
 * Chain on every route: authenticateStudent -> requireRepresentative (ACTIVE assignment, current term)
 * -> [requireAssignedCourse] -> [requireRepresentativePermission] -> handler (which authorises the exact course + ownership again).
 * The Course Rep manages the CLASS timetable of their assigned course (create / update / delete); an Assistant can only view it.
 * There is deliberately NO route here for: assigning/revoking representatives, editing students, enrollment, the course catalogue,
 * the official departmental timetable, official materials, or attendance.
 */
const router = Router();
const rep = [authenticateStudent, requireRepresentative];

router.get("/profile", ...rep, ctrl.profile);
router.get("/assignments", ...rep, ctrl.assignments);
router.get("/overview", ...rep, requireRepresentativePermission("overview:view"), ctrl.overview);

router.get("/courses", ...rep, requireRepresentativePermission("course:view"), ctrl.courses);
router.get("/courses/:courseId", ...rep, validate({ params: courseIdParams }), requireAssignedCourse("params"), requireRepresentativePermission("course:view"), ctrl.course);
router.get(
  "/courses/:courseId/members",
  ...rep, validate({ params: courseIdParams, query: membersQuery }), requireAssignedCourse("params"), requireRepresentativePermission("members:view"), ctrl.members,
);

router.get("/announcements", ...rep, validate({ query: courseScopedQuery }), requireAssignedCourse("query"), requireRepresentativePermission("announcement:view"), ctrl.listAnnouncements);
router.post(
  "/announcements",
  ...rep, repUploadLimiter, announcementImageUpload, validate({ body: createAnnouncementSchema }), requireAssignedCourse("body"), requireRepresentativePermission("announcement:create"), ctrl.createAnnouncement,
);
router.patch(
  "/announcements/:announcementId",
  ...rep, repUploadLimiter, announcementImageUpload, validate({ params: announcementIdParams, body: updateAnnouncementSchema }), requireRepresentativePermission("announcement:update:own"), ctrl.updateAnnouncement,
);
router.delete(
  "/announcements/:announcementId",
  ...rep, repWriteLimiter, validate({ params: announcementIdParams }), requireRepresentativePermission("announcement:delete:own"), ctrl.deleteAnnouncement,
);

router.get("/resources", ...rep, validate({ query: courseScopedQuery }), requireAssignedCourse("query"), requireRepresentativePermission("resource:view"), ctrl.listResources);
router.post(
  "/resources",
  ...rep, repUploadLimiter, resourceUpload, validate({ body: createResourceSchema }), requireAssignedCourse("body"), requireRepresentativePermission("resource:create"), ctrl.createResource,
);
router.patch(
  "/resources/:resourceId",
  ...rep, repWriteLimiter, validate({ params: resourceIdParams, body: updateResourceSchema }), requireRepresentativePermission("resource:update:own"), ctrl.updateResource,
);
router.delete(
  "/resources/:resourceId",
  ...rep, repWriteLimiter, validate({ params: resourceIdParams }), requireRepresentativePermission("resource:delete:own"), ctrl.deleteResource,
);

router.get("/timetable", ...rep, validate({ query: timetableQuery }), requireAssignedCourse("query"), requireRepresentativePermission("timetable:view"), ctrl.timetable);
router.post(
  "/timetable",
  ...rep, repWriteLimiter, validate({ body: createTimetableSchema }), requireAssignedCourse("body"), requireRepresentativePermission("timetable:create"), ctrl.createTimetable,
);
router.patch(
  "/timetable/:id",
  ...rep, repWriteLimiter, validate({ params: timetableIdParams, body: updateTimetableSchema }), requireRepresentativePermission("timetable:update"), ctrl.updateTimetable,
);
router.delete(
  "/timetable/:id",
  ...rep, repWriteLimiter, validate({ params: timetableIdParams }), requireRepresentativePermission("timetable:delete"), ctrl.deleteTimetable,
);
router.get("/notifications", ...rep, requireRepresentativePermission("notification:view"), validate({ query: notificationsQuery }), ctrl.notifications);

/* live quizzes: a rep writes quizzes and hosts games for their level. Every handler works on the caller's OWN quizzes / games only. */
router.get("/quizzes", ...rep, requireRepresentativePermission("quiz:manage"), quizCtrl.listQuizzes);
router.post("/quizzes", ...rep, requireRepresentativePermission("quiz:manage"), repWriteLimiter, validate({ body: quizInputSchema }), quizCtrl.createQuiz);
router.get("/quizzes/:id", ...rep, requireRepresentativePermission("quiz:manage"), validate({ params: quizIdParams }), quizCtrl.getQuiz);
router.put("/quizzes/:id", ...rep, requireRepresentativePermission("quiz:manage"), repWriteLimiter, validate({ params: quizIdParams, body: quizInputSchema }), quizCtrl.updateQuiz);
router.delete("/quizzes/:id", ...rep, requireRepresentativePermission("quiz:manage"), repWriteLimiter, validate({ params: quizIdParams }), quizCtrl.deleteQuiz);
router.post("/quizzes/:id/games", ...rep, requireRepresentativePermission("quiz:host"), repQuizLimiter, validate({ params: quizIdParams }), quizCtrl.hostGame);
router.get("/quiz-games", ...rep, requireRepresentativePermission("quiz:host"), repQuizLimiter, quizCtrl.listGames);
router.get("/quiz-games/:gameId", ...rep, requireRepresentativePermission("quiz:host"), repQuizLimiter, validate({ params: gameIdParams }), quizCtrl.gameState);
router.post("/quiz-games/:gameId/start", ...rep, requireRepresentativePermission("quiz:host"), repQuizLimiter, validate({ params: gameIdParams }), quizCtrl.startGame);
router.post("/quiz-games/:gameId/end-question", ...rep, requireRepresentativePermission("quiz:host"), repQuizLimiter, validate({ params: gameIdParams }), quizCtrl.endQuestion);
router.post("/quiz-games/:gameId/next", ...rep, requireRepresentativePermission("quiz:host"), repQuizLimiter, validate({ params: gameIdParams }), quizCtrl.nextQuestion);
router.post("/quiz-games/:gameId/cancel", ...rep, requireRepresentativePermission("quiz:host"), repQuizLimiter, validate({ params: gameIdParams }), quizCtrl.cancelGame);
router.delete("/quiz-games/:gameId/players/:playerId", ...rep, requireRepresentativePermission("quiz:host"), repQuizLimiter, validate({ params: gamePlayerParams }), quizCtrl.kickPlayer);

export default router;
