import { Router } from "express";
import * as c from "../controllers/hod.controller";
import { pushController } from "../controllers/push.controller";
import * as pv from "../validators/push.validators";
import { authenticateHod, hodActor, requireDepartmentScope, requireHod } from "../middleware/hod";
import { forgotPasswordLimiter, hodPushLimiter, hodUploadLimiter, hodWriteLimiter, loginLimiter, resetPasswordLimiter } from "../middleware/rateLimiters";
import { announcementImageUpload, candidatePhotoUpload, profilePhotoUpload, resourceUpload } from "../middleware/upload";
import { validate } from "../middleware/validate";
import * as v from "../validators/hod.validators";

/**
 * /api/v1/hod: department administration. Chain on every protected route:
 *   authenticateHod (HOD-audience JWT, CURRENT + ACTIVE HOD, active department)
 *   -> requireHod -> requireDepartmentScope (a department id in the request that isn't the HOD's own is refused and audited) -> handler.
 * The department is always the authenticated HOD's own: no handler takes a department from the request, and every store query filters by it.
 * Deliberately NO route here for: HOD signup, changing a HOD's role / department / staff id, writing attendance records, editing the (Course Rep's) class timetable,
 * editing lecturers' / reps' materials, university-wide actions, grading or Campus Hub. Elections: a HOD manages only their own department's elections (below);
 * there is no route that lets a student nominate or approve a candidate, and tallies are never readable before voting closes.
 */
const router = Router();
const hod = [authenticateHod, requireHod, requireDepartmentScope];
const w = hodWriteLimiter;

/* public: no signup. A HOD account is provisioned by the system and activated with a one-time emailed token. */
router.post("/auth/login", loginLimiter, validate({ body: v.hodLoginSchema }), c.login);
router.post("/auth/activate", resetPasswordLimiter, validate({ body: v.hodActivateSchema }), c.activate);
router.post("/auth/forgot-password", forgotPasswordLimiter, validate({ body: v.hodForgotSchema }), c.forgotPassword);
router.post("/auth/reset-password", resetPasswordLimiter, validate({ body: v.hodResetSchema }), c.resetPassword);

/* profile / dashboard */
router.post("/auth/logout", ...hod, c.logout);
router.patch("/change-password", ...hod, validate({ body: v.hodChangePasswordSchema }), c.changePassword);
router.get("/profile", ...hod, c.profile);
router.patch("/profile", ...hod, validate({ body: v.hodProfileSchema }), c.updateProfile);
router.post("/profile/picture", ...hod, hodUploadLimiter, profilePhotoUpload, c.uploadPhoto);
router.get("/dashboard", ...hod, c.dashboard);

/* department settings / levels / term */
router.get("/department", ...hod, c.department);
router.patch("/department/settings", ...hod, w, validate({ body: v.departmentSettingsSchema }), c.updateDepartment);
router.put("/department/academic-term", ...hod, w, validate({ body: v.academicTermSchema }), c.setTerm);
router.patch("/department/registration", ...hod, w, validate({ body: v.registrationSchema }), c.updateRegistration);

/* students (static paths before :studentId) */
router.get("/students", ...hod, validate({ query: v.studentsQuery }), c.students);
router.post("/students/academic-record/bulk", ...hod, w, validate({ body: v.bulkAcademicRecordSchema }), c.bulkAcademic);
router.get("/students/:studentId", ...hod, validate({ params: v.studentIdParams }), c.student);
router.patch("/students/:studentId/status", ...hod, w, validate({ params: v.studentIdParams, body: v.studentStatusSchema }), c.studentStatus);
router.patch("/students/:studentId/academic-record", ...hod, w, validate({ params: v.studentIdParams, body: v.academicRecordSchema }), c.studentAcademic);
router.get("/students/:studentId/courses", ...hod, validate({ params: v.studentIdParams }), c.studentCourses);
router.get("/students/:studentId/attendance", ...hod, validate({ params: v.studentIdParams }), c.studentAttendance);

/* lecturers */
router.get("/lecturers", ...hod, validate({ query: v.lecturersQuery }), c.lecturers);
router.post("/lecturers", ...hod, w, validate({ body: v.createLecturerSchema }), c.createLecturer);
router.get("/lecturers/:lecturerId", ...hod, validate({ params: v.lecturerIdParams }), c.lecturer);
router.patch("/lecturers/:lecturerId", ...hod, w, validate({ params: v.lecturerIdParams, body: v.updateLecturerSchema }), c.updateLecturer);
router.patch("/lecturers/:lecturerId/status", ...hod, w, validate({ params: v.lecturerIdParams, body: v.lecturerStatusSchema }), c.lecturerStatus);
router.post("/lecturers/:lecturerId/invitation", ...hod, w, validate({ params: v.lecturerIdParams, body: v.emptyBody }), c.reinvite);
router.get("/lecturers/:lecturerId/courses", ...hod, validate({ params: v.lecturerIdParams }), c.lecturerCourses);
router.post("/lecturers/:lecturerId/courses", ...hod, w, validate({ params: v.lecturerIdParams, body: v.assignLecturerCourseSchema }), c.assignLecturer);
router.delete("/lecturers/:lecturerId/courses/:courseId", ...hod, w, validate({ params: v.lecturerCourseParams }), c.removeLecturer);

/* official course catalogue */
router.get("/courses", ...hod, validate({ query: v.coursesQuery }), c.courses);
router.post("/courses", ...hod, w, validate({ body: v.createCourseSchema }), c.createCourse);
router.get("/courses/:courseId", ...hod, validate({ params: v.courseIdParams }), c.course);
router.patch("/courses/:courseId", ...hod, w, validate({ params: v.courseIdParams, body: v.updateCourseSchema }), c.updateCourse);
router.patch("/courses/:courseId/status", ...hod, w, validate({ params: v.courseIdParams, body: v.courseStatusSchema }), c.courseStatus);

/* course representatives (reuses CourseRepresentativeAssignment) */
router.get("/representatives", ...hod, validate({ query: v.representativesQuery }), c.representatives);
router.post("/representatives", ...hod, w, validate({ body: v.appointRepSchema }), c.appointRep);
router.patch("/representatives/:assignmentId/status", ...hod, w, validate({ params: v.assignmentIdParams, body: v.repStatusSchema }), c.repStatus);
router.delete("/representatives/:assignmentId", ...hod, w, validate({ params: v.assignmentIdParams }), c.revokeRep);

/* timetable: REVIEW only (the Course Rep owns the class timetable) */
router.get("/timetable", ...hod, validate({ query: v.timetableQuery }), c.timetable);
router.get("/timetable/conflicts", ...hod, c.timetableConflicts);

/* department announcements */
router.get("/announcements", ...hod, validate({ query: v.announcementsQuery }), c.announcements);
router.post("/announcements", ...hod, hodUploadLimiter, announcementImageUpload, validate({ body: v.createAnnouncementSchema }), c.createAnnouncement); // JSON, or multipart with an optional "image" file
router.patch("/announcements/:announcementId", ...hod, hodUploadLimiter, announcementImageUpload, validate({ params: v.announcementIdParams, body: v.updateAnnouncementSchema }), c.updateAnnouncement);
router.delete("/announcements/:announcementId", ...hod, w, validate({ params: v.announcementIdParams }), c.deleteAnnouncement);

/* department documents (their own record type) + read-only materials overview */
router.get("/documents", ...hod, validate({ query: v.documentsQuery }), c.documents);
router.post("/documents", ...hod, hodUploadLimiter, resourceUpload, validate({ body: v.createDocumentSchema }), c.createDocument);
router.patch("/documents/:documentId", ...hod, w, validate({ params: v.documentIdParams, body: v.updateDocumentSchema }), c.updateDocument);
router.delete("/documents/:documentId", ...hod, w, validate({ params: v.documentIdParams }), c.deleteDocument);
router.get("/materials", ...hod, validate({ query: v.materialsQuery }), c.materials);

/* attendance oversight: READ-ONLY (static path before :sessionId) */
router.get("/attendance", ...hod, validate({ query: v.attendanceQuery }), c.attendance);
router.get("/attendance/statistics", ...hod, c.attendanceStatistics);
router.get("/attendance/:sessionId", ...hod, validate({ params: v.sessionIdParams }), c.attendanceSession);

/* complaints */
router.get("/complaints", ...hod, validate({ query: v.complaintsQuery }), c.complaints);
router.get("/complaints/:complaintId", ...hod, validate({ params: v.complaintIdParams }), c.complaint);
router.patch("/complaints/:complaintId/status", ...hod, w, validate({ params: v.complaintIdParams, body: v.complaintStatusSchema }), c.complaintStatus);
router.post("/complaints/:complaintId/assign", ...hod, w, validate({ params: v.complaintIdParams, body: v.complaintAssignSchema }), c.complaintAssign);
router.post("/complaints/:complaintId/respond", ...hod, w, validate({ params: v.complaintIdParams, body: v.complaintRespondSchema }), c.complaintRespond);

/* elections (static paths before :electionId). Structure is writable only before voting starts (enforced in the service). */
const E = { params: v.electionIdParams };
router.get("/elections", ...hod, validate({ query: v.electionsQuery }), c.elections);
router.post("/elections", ...hod, w, validate({ body: v.createElectionSchema }), c.createElection);
router.get("/elections/student-search", ...hod, validate({ query: v.electionStudentSearchQuery }), c.electionStudentSearch);
router.get("/elections/:electionId", ...hod, validate(E), c.election);
router.patch("/elections/:electionId", ...hod, w, validate({ ...E, body: v.updateElectionSchema }), c.updateElection);
router.delete("/elections/:electionId", ...hod, w, validate(E), c.deleteElection);
router.get("/elections/:electionId/readiness", ...hod, validate(E), c.electionReadiness);
router.post("/elections/:electionId/publish", ...hod, w, validate({ ...E, body: v.emptyBody }), c.publishElection);
router.post("/elections/:electionId/open", ...hod, w, validate({ ...E, body: v.emptyBody }), c.openElection);
router.post("/elections/:electionId/close", ...hod, w, validate({ ...E, body: v.emptyBody }), c.closeElection);
router.post("/elections/:electionId/cancel", ...hod, w, validate({ ...E, body: v.emptyBody }), c.cancelElection);
router.get("/elections/:electionId/turnout", ...hod, validate(E), c.electionTurnout);
router.get("/elections/:electionId/results", ...hod, validate(E), c.electionResults);
router.put("/elections/:electionId/results-release", ...hod, w, validate({ ...E, body: v.electionResultsSchema }), c.electionResultsRelease);
router.get("/elections/:electionId/group-members", ...hod, validate({ ...E, query: v.electionGroupQuery }), c.electionGroup);

router.get("/elections/:electionId/positions", ...hod, validate(E), c.electionPositions);
router.post("/elections/:electionId/positions", ...hod, w, validate({ ...E, body: v.createPositionSchema }), c.createElectionPosition);
router.put("/elections/:electionId/positions/order", ...hod, w, validate({ ...E, body: v.reorderPositionsSchema }), c.reorderElectionPositions);
router.patch("/elections/:electionId/positions/:positionId", ...hod, w, validate({ params: v.electionPositionParams, body: v.updatePositionSchema }), c.updateElectionPosition);
router.delete("/elections/:electionId/positions/:positionId", ...hod, w, validate({ params: v.electionPositionParams }), c.deleteElectionPosition);

router.get("/elections/:electionId/candidates", ...hod, validate({ ...E, query: v.electionCandidatesQuery }), c.electionCandidates);
// multipart (optional "photo" file) or JSON: the photo is checked from its bytes, not its filename / mimetype
router.post("/elections/:electionId/candidates", ...hod, hodUploadLimiter, candidatePhotoUpload, validate({ ...E, body: v.addCandidateSchema }), c.addElectionCandidate);
router.patch("/elections/:electionId/candidates/:candidateId", ...hod, w, validate({ params: v.electionCandidateParams, body: v.updateCandidateSchema }), c.updateElectionCandidate);
router.patch("/elections/:electionId/candidates/:candidateId/decision", ...hod, w, validate({ params: v.electionCandidateParams, body: v.candidateDecisionSchema }), c.decideElectionCandidate);
router.put("/elections/:electionId/candidates/:candidateId/photo", ...hod, hodUploadLimiter, validate({ params: v.electionCandidateParams }), candidatePhotoUpload, c.setElectionCandidatePhoto);
router.delete("/elections/:electionId/candidates/:candidateId/photo", ...hod, w, validate({ params: v.electionCandidateParams }), c.removeElectionCandidatePhoto);
router.delete("/elections/:electionId/candidates/:candidateId", ...hod, w, validate({ params: v.electionCandidateParams }), c.removeElectionCandidate);

/* notifications (same notification system) */
router.get("/notifications", ...hod, validate({ query: v.notificationsQuery }), c.notifications);
router.patch("/notifications/read-all", ...hod, c.markAllRead);
router.patch("/notifications/:notificationId/read", ...hod, validate({ params: v.notificationIdParams }), c.markRead);

/* browser push (devices + preferences); the owner is the authenticated HOD from the token */
const push = pushController((req) => { const a = hodActor(req); return { userId: a.hodId, userType: "HOD", departmentId: a.departmentId }; });
router.get("/push/config", ...hod, push.config);
router.get("/push/subscriptions", ...hod, push.devices);
router.post("/push/subscriptions", ...hod, hodPushLimiter, validate({ body: pv.pushSubscribeSchema }), push.subscribe);
router.delete("/push/subscriptions", ...hod, hodPushLimiter, validate({ body: pv.pushUnsubscribeSchema }), push.unsubscribe);
router.delete("/push/subscriptions/:id", ...hod, hodPushLimiter, validate({ params: pv.pushSubscriptionIdParams }), push.removeDevice);
router.get("/push/preferences", ...hod, push.preferences);
router.put("/push/preferences", ...hod, hodPushLimiter, validate({ body: pv.pushPreferencesSchema }), push.updatePreferences);
router.post("/push/test", ...hod, hodPushLimiter, push.test);

export default router;
