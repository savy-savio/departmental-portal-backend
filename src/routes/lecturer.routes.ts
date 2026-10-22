import { Router } from "express";
import * as c from "../controllers/lecturer.controller";
import { pushController } from "../controllers/push.controller";
import * as pv from "../validators/push.validators";
import { authenticateLecturer, lecturerActor, requireLecturer, requireLecturerCourseAssignment } from "../middleware/lecturer";
import { forgotPasswordLimiter, lecturerPushLimiter, lecturerUploadLimiter, lecturerWriteLimiter, loginLimiter, resetPasswordLimiter } from "../middleware/rateLimiters";
import { announcementImageUpload, profilePhotoUpload, resourceUpload } from "../middleware/upload";
import { validate } from "../middleware/validate";
import * as v from "../validators/lecturer.validators";

/**
 * /api/v1/lecturer. Chain on every protected route:
 *   authenticateLecturer (lecturer-audience JWT, ACTIVE lecturer, active department) -> requireLecturer
 *   -> [requireLecturerCourseAssignment: ACTIVE assignment for exactly this course in the current term] -> handler
 * (the service authorises the course / ownership again). Resource-id routes (:materialId, :announcementId, :assignmentId, :sessionId)
 * are resolved inside the service to the course they belong to and checked against the lecturer's assignments.
 * There is deliberately NO route here to create courses, assign courses or lecturers, edit students / enrollment, write the timetable, or grade.
 */
const router = Router();
const lec = [authenticateLecturer, requireLecturer];
const course = (source: "params" | "body" | "query" = "params") => requireLecturerCourseAssignment(source);

/* public */
router.post("/auth/login", loginLimiter, validate({ body: v.lecturerLoginSchema }), c.login);
router.post("/auth/activate", resetPasswordLimiter, validate({ body: v.lecturerActivateSchema }), c.activate);
router.post("/auth/forgot-password", forgotPasswordLimiter, validate({ body: v.lecturerForgotSchema }), c.forgotPassword);
router.post("/auth/reset-password", resetPasswordLimiter, validate({ body: v.lecturerResetSchema }), c.resetPassword);

/* profile / dashboard */
router.post("/auth/logout", ...lec, c.logout);
router.patch("/change-password", ...lec, validate({ body: v.lecturerChangePasswordSchema }), c.changePassword);
router.get("/profile", ...lec, c.profile);
router.patch("/profile", ...lec, validate({ body: v.lecturerProfileSchema }), c.updateProfile);
router.post("/profile/picture", ...lec, lecturerUploadLimiter, profilePhotoUpload, c.uploadPhoto);
router.get("/dashboard", ...lec, c.dashboard);

/* courses */
router.get("/courses", ...lec, c.courses);
router.get("/courses/:courseId", ...lec, validate({ params: v.courseIdParams }), course(), c.course);
router.get("/courses/:courseId/students", ...lec, validate({ params: v.courseIdParams, query: v.studentsQuery }), course(), c.students);

/* official course materials */
router.get("/courses/:courseId/materials", ...lec, validate({ params: v.courseIdParams }), course(), c.listMaterials);
router.post("/courses/:courseId/materials", ...lec, lecturerUploadLimiter, validate({ params: v.courseIdParams }), course(), resourceUpload, validate({ body: v.createMaterialSchema }), c.createMaterial);
router.patch("/materials/:materialId", ...lec, lecturerWriteLimiter, validate({ params: v.materialIdParams, body: v.updateMaterialSchema }), c.updateMaterial);
router.delete("/materials/:materialId", ...lec, lecturerWriteLimiter, validate({ params: v.materialIdParams }), c.deleteMaterial);

/* announcements */
router.get("/announcements", ...lec, validate({ query: v.courseScopedQuery }), course("query"), c.listAnnouncements);
router.post("/announcements", ...lec, lecturerUploadLimiter, announcementImageUpload, validate({ body: v.createAnnouncementSchema }), course("body"), c.createAnnouncement); // JSON, or multipart with an optional "image" file
router.patch("/announcements/:announcementId", ...lec, lecturerUploadLimiter, announcementImageUpload, validate({ params: v.announcementIdParams, body: v.updateAnnouncementSchema }), c.updateAnnouncement);
router.delete("/announcements/:announcementId", ...lec, lecturerWriteLimiter, validate({ params: v.announcementIdParams }), c.deleteAnnouncement);

/* assignments (view submissions only: no grading) */
router.get("/assignments", ...lec, validate({ query: v.courseScopedQuery }), course("query"), c.listAssignments);
router.post("/courses/:courseId/assignments", ...lec, lecturerUploadLimiter, validate({ params: v.courseIdParams }), course(), resourceUpload, validate({ body: v.createAssignmentSchema }), c.createAssignment);
router.patch("/assignments/:assignmentId", ...lec, lecturerWriteLimiter, validate({ params: v.assignmentIdParams, body: v.updateAssignmentSchema }), c.updateAssignment);
router.delete("/assignments/:assignmentId", ...lec, lecturerWriteLimiter, validate({ params: v.assignmentIdParams }), c.deleteAssignment);
router.get("/assignments/:assignmentId/submissions", ...lec, validate({ params: v.assignmentIdParams }), c.submissions);

/* attendance (static path before :sessionId) */
router.get("/courses/:courseId/attendance", ...lec, validate({ params: v.courseIdParams }), course(), c.listSessions);
router.post("/courses/:courseId/attendance", ...lec, lecturerWriteLimiter, validate({ params: v.courseIdParams, body: v.createAttendanceSchema }), course(), c.createSession);
router.get("/courses/:courseId/attendance/statistics", ...lec, validate({ params: v.courseIdParams }), course(), c.attendanceStats);
router.get("/attendance/:sessionId", ...lec, validate({ params: v.sessionIdParams }), c.getSession);
router.patch("/attendance/:sessionId/close", ...lec, lecturerWriteLimiter, validate({ params: v.sessionIdParams, body: v.emptyBody }), c.closeSession);
router.patch("/attendance/:sessionId/open", ...lec, lecturerWriteLimiter, validate({ params: v.sessionIdParams, body: v.openAttendanceSchema }), c.openSession);

/* timetable: VIEW only (Course Reps own the class timetable) */
router.get("/timetable", ...lec, validate({ query: v.courseScopedQuery }), course("query"), c.timetable);

/* complaints the HOD forwarded to this lecturer. Scope = assignedLecturer is the token's lecturer + same department (checked in the service).
 * No assign / resolve / reject / close route exists here: those stay with the HOD. */
router.get("/complaints", ...lec, validate({ query: v.lecturerComplaintsQuery }), c.complaints);
router.get("/complaints/:complaintId", ...lec, validate({ params: v.complaintIdParams }), c.complaint);
router.get("/complaints/:complaintId/history", ...lec, validate({ params: v.complaintIdParams }), c.complaintHistory);
router.post("/complaints/:complaintId/respond", ...lec, lecturerWriteLimiter, validate({ params: v.complaintIdParams, body: v.complaintRespondSchema }), c.respondComplaint);
router.patch("/complaints/:complaintId/status", ...lec, lecturerWriteLimiter, validate({ params: v.complaintIdParams, body: v.complaintStatusSchema }), c.complaintStatus);

/* notifications (same notification system students use) */
router.get("/notifications", ...lec, validate({ query: v.lecturerNotificationsQuery }), c.notifications);
router.patch("/notifications/read-all", ...lec, c.markAllRead);
router.patch("/notifications/:notificationId/read", ...lec, validate({ params: v.notificationIdParams }), c.markRead);

/* browser push (devices + preferences); the owner is the authenticated user from the token */
const push = pushController((req) => { const a = lecturerActor(req); return { userId: a.lecturerId, userType: "LECTURER", departmentId: a.departmentId }; });
router.get("/push/config", ...lec, push.config);
router.get("/push/subscriptions", ...lec, push.devices);
router.post("/push/subscriptions", ...lec, lecturerPushLimiter, validate({ body: pv.pushSubscribeSchema }), push.subscribe);
router.delete("/push/subscriptions", ...lec, lecturerPushLimiter, validate({ body: pv.pushUnsubscribeSchema }), push.unsubscribe);
router.delete("/push/subscriptions/:id", ...lec, lecturerPushLimiter, validate({ params: pv.pushSubscriptionIdParams }), push.removeDevice);
router.get("/push/preferences", ...lec, push.preferences);
router.put("/push/preferences", ...lec, lecturerPushLimiter, validate({ body: pv.pushPreferencesSchema }), push.updatePreferences);
router.post("/push/test", ...lec, lecturerPushLimiter, push.test);

export default router;
