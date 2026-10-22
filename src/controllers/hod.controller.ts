import type { Request, Response } from "express";
import { hodActor, hodMeta } from "../middleware/hod";
import { electionAdminService as el, hodAuth, hodService as svc } from "../services/hod";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";
import { realtime } from "../realtime/instance";
import { sendMessage, sendSuccess } from "../utils/response";

const H = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncHandler(async (req, res) => void (await fn(req, res)));
const a = hodActor, m = hodMeta;
const file = (req: Request) => (req.file ? { buffer: req.file.buffer, originalName: req.file.originalname } : undefined);

/* ---- auth (public) / account ---- */
export const login = H(async (req, res) => sendSuccess(res, await hodAuth.login(req.body.email, req.body.password), "Login successful."));
export const activate = H(async (req, res) => sendSuccess(res, await hodAuth.activate(req.body.token, req.body.password), "Your account is active.", 201));
export const forgotPassword = H(async (req, res) => { await hodAuth.forgotPassword(req.body.email); sendMessage(res, "If an account exists for that email, a reset link has been sent."); });
export const resetPassword = H(async (req, res) => { await hodAuth.resetPassword(req.body.token, req.body.password); sendMessage(res, "Your password has been reset. You can now log in."); });
export const changePassword = H(async (req, res) => sendSuccess(res, await hodAuth.changePassword(a(req).hodId, req.body.currentPassword, req.body.password), "Password changed."));
export const logout = H(async (_req, res) => sendMessage(res, "Logged out."));
export const profile = H(async (req, res) => sendSuccess(res, await svc.getProfile(a(req))));
export const updateProfile = H(async (req, res) => sendSuccess(res, await svc.updateProfile(a(req), req.body, m(req)), "Profile updated."));
export const uploadPhoto = H(async (req, res) => {
  if (!req.file) throw new AppError(400, 'Attach an image in the "photo" field.');
  sendSuccess(res, await svc.setProfilePhoto(a(req), req.file.buffer, m(req)), "Profile photo updated.");
});
export const dashboard = H(async (req, res) => sendSuccess(res, await svc.dashboard(a(req))));

/* ---- department ---- */
export const department = H(async (req, res) => sendSuccess(res, await svc.getDepartment(a(req))));
export const updateDepartment = H(async (req, res) => sendSuccess(res, await svc.updateDepartmentSettings(a(req), req.body, m(req)), "Department settings updated."));
export const setTerm = H(async (req, res) => sendSuccess(res, await svc.setAcademicTerm(a(req), req.body, m(req)), "Academic term updated."));
export const updateRegistration = H(async (req, res) => sendSuccess(res, await svc.updateRegistration(a(req), req.body, m(req)), "Registration settings updated."));

/* ---- students ---- */
export const students = H(async (req, res) => sendSuccess(res, await svc.listStudents(a(req), req.query as never)));
export const student = H(async (req, res) => sendSuccess(res, await svc.getStudent(a(req), req.params.studentId, m(req))));
export const studentStatus = H(async (req, res) => sendSuccess(res, await svc.setStudentStatus(a(req), req.params.studentId, req.body.status, m(req)), "Student status updated."));
export const studentCourses = H(async (req, res) => sendSuccess(res, await svc.studentCourses(a(req), req.params.studentId, m(req))));
export const studentAttendance = H(async (req, res) => sendSuccess(res, await svc.studentAttendance(a(req), req.params.studentId, m(req))));
export const studentAcademic = H(async (req, res) => sendSuccess(res, await svc.updateStudentAcademicRecord(a(req), req.params.studentId, req.body, m(req)), "Academic record updated."));
export const bulkAcademic = H(async (req, res) => { const { studentIds, ...patch } = req.body; sendSuccess(res, await svc.bulkUpdateAcademicRecords(a(req), studentIds, patch, m(req)), "Academic records updated."); });

/* ---- lecturers ---- */
export const lecturers = H(async (req, res) => sendSuccess(res, await svc.listLecturers(a(req), req.query as never)));
export const createLecturer = H(async (req, res) => sendSuccess(res, await svc.createLecturer(a(req), req.body, m(req)), "Lecturer account created.", 201));
export const lecturer = H(async (req, res) => sendSuccess(res, await svc.getLecturer(a(req), req.params.lecturerId, m(req))));
export const updateLecturer = H(async (req, res) => sendSuccess(res, await svc.updateLecturer(a(req), req.params.lecturerId, req.body, m(req)), "Lecturer updated."));
export const lecturerStatus = H(async (req, res) => sendSuccess(res, await svc.setLecturerStatus(a(req), req.params.lecturerId, req.body.status, m(req)), "Lecturer status updated."));
export const reinvite = H(async (req, res) => sendSuccess(res, await svc.reinviteLecturer(a(req), req.params.lecturerId, m(req)), "Invitation sent."));
export const lecturerCourses = H(async (req, res) => sendSuccess(res, await svc.lecturerCourses(a(req), req.params.lecturerId, m(req))));
export const assignLecturer = H(async (req, res) => sendSuccess(res, await svc.assignLecturerToCourse(a(req), req.params.lecturerId, req.body.courseId, m(req)), "Lecturer assigned to course.", 201));
export const removeLecturer = H(async (req, res) => { await svc.removeLecturerFromCourse(a(req), req.params.lecturerId, req.params.courseId, m(req)); sendMessage(res, "Lecturer removed from course."); });

/* ---- courses ---- */
export const courses = H(async (req, res) => sendSuccess(res, await svc.listCourses(a(req), req.query as never)));
export const createCourse = H(async (req, res) => sendSuccess(res, await svc.createCourse(a(req), req.body, m(req)), "Course created.", 201));
export const course = H(async (req, res) => sendSuccess(res, await svc.getCourse(a(req), req.params.courseId, m(req))));
export const updateCourse = H(async (req, res) => sendSuccess(res, await svc.updateCourse(a(req), req.params.courseId, req.body, m(req)), "Course updated."));
export const courseStatus = H(async (req, res) => sendSuccess(res, await svc.setCourseStatus(a(req), req.params.courseId, req.body.status, m(req)), "Course status updated."));

/* ---- representatives ---- */
export const representatives = H(async (req, res) => sendSuccess(res, await svc.listRepresentatives(a(req), req.query as never)));
export const appointRep = H(async (req, res) => sendSuccess(res, await svc.appointRepresentative(a(req), req.body, m(req)), "Representative appointed.", 201));
export const repStatus = H(async (req, res) => sendSuccess(res, await svc.setRepresentativeStatus(a(req), req.params.assignmentId, req.body.status, m(req)), "Appointment updated."));
export const revokeRep = H(async (req, res) => { await svc.revokeRepresentative(a(req), req.params.assignmentId, m(req)); sendMessage(res, "Appointment revoked."); });

/* ---- timetable (read-only) ---- */
export const timetable = H(async (req, res) => sendSuccess(res, await svc.listTimetable(a(req), req.query as never)));
export const timetableConflicts = H(async (req, res) => sendSuccess(res, await svc.timetableConflicts(a(req))));

/* ---- announcements / documents / materials ---- */
export const announcements = H(async (req, res) => sendSuccess(res, await svc.listAnnouncements(a(req), req.query as never)));
export const createAnnouncement = H(async (req, res) => sendSuccess(res, await svc.createAnnouncement(a(req), { ...req.body, image: req.file?.buffer }, m(req)), "Announcement created.", 201));
export const updateAnnouncement = H(async (req, res) => sendSuccess(res, await svc.updateAnnouncement(a(req), req.params.announcementId, { ...req.body, image: req.file?.buffer }, m(req)), "Announcement updated."));
export const deleteAnnouncement = H(async (req, res) => { await svc.deleteAnnouncement(a(req), req.params.announcementId, m(req)); sendMessage(res, "Announcement deleted."); });
export const documents = H(async (req, res) => sendSuccess(res, await svc.listDocuments(a(req), req.query as never)));
export const createDocument = H(async (req, res) => sendSuccess(res, await svc.createDocument(a(req), { ...req.body, file: file(req) }, m(req)), "Document published.", 201));
export const updateDocument = H(async (req, res) => sendSuccess(res, await svc.updateDocument(a(req), req.params.documentId, req.body, m(req)), "Document updated."));
export const deleteDocument = H(async (req, res) => { await svc.deleteDocument(a(req), req.params.documentId, m(req)); sendMessage(res, "Document deleted."); });
export const materials = H(async (req, res) => sendSuccess(res, await svc.materialsOverview(a(req), req.query as never)));

/* ---- attendance oversight (read-only) ---- */
export const attendance = H(async (req, res) => sendSuccess(res, await svc.listAttendanceSessions(a(req), req.query as never)));
export const attendanceStatistics = H(async (req, res) => sendSuccess(res, await svc.attendanceStatistics(a(req))));
export const attendanceSession = H(async (req, res) => sendSuccess(res, await svc.getAttendanceSession(a(req), req.params.sessionId, m(req))));

/* ---- complaints ---- */
export const complaints = H(async (req, res) => sendSuccess(res, await svc.listComplaints(a(req), req.query as never)));
export const complaint = H(async (req, res) => sendSuccess(res, await svc.getComplaint(a(req), req.params.complaintId, m(req))));
export const complaintStatus = H(async (req, res) => sendSuccess(res, await svc.setComplaintStatus(a(req), req.params.complaintId, req.body, m(req)), "Complaint updated."));
export const complaintAssign = H(async (req, res) => sendSuccess(res, await svc.assignComplaint(a(req), req.params.complaintId, req.body, m(req)), "Complaint forwarded."));
export const complaintRespond = H(async (req, res) => sendSuccess(res, await svc.respondToComplaint(a(req), req.params.complaintId, req.body, m(req)), "Response sent."));

/* ---- notifications ---- */
export const notifications = H(async (req, res) => sendSuccess(res, await svc.listNotifications(a(req), req.query as never)));
export const markRead = H(async (req, res) => { const r = await svc.markNotificationRead(a(req), req.params.notificationId); realtime.emitToUser({ userType: "HOD", userId: a(req).hodId }, "notification:read", { id: req.params.notificationId }); sendSuccess(res, r); });
export const markAllRead = H(async (req, res) => { const r = await svc.markAllNotificationsRead(a(req)); realtime.emitToUser({ userType: "HOD", userId: a(req).hodId }, "notification:read", { all: true }); sendSuccess(res, r); });

/* ---- elections (department election management) ---- */
export const elections = H(async (req, res) => sendSuccess(res, await el.list(a(req), req.query as never)));
export const createElection = H(async (req, res) => sendSuccess(res, await el.create(a(req), req.body, m(req)), "Election created.", 201));
export const election = H(async (req, res) => sendSuccess(res, await el.get(a(req), req.params.electionId, m(req))));
export const updateElection = H(async (req, res) => sendSuccess(res, await el.update(a(req), req.params.electionId, req.body, m(req)), "Election updated."));
export const deleteElection = H(async (req, res) => { await el.remove(a(req), req.params.electionId, m(req)); sendMessage(res, "Election deleted."); });
export const electionReadiness = H(async (req, res) => sendSuccess(res, await el.readinessReport(a(req), req.params.electionId, m(req))));
export const publishElection = H(async (req, res) => sendSuccess(res, await el.publish(a(req), req.params.electionId, m(req)), "Election published."));
export const openElection = H(async (req, res) => sendSuccess(res, await el.openNow(a(req), req.params.electionId, m(req)), "Voting is now open."));
export const closeElection = H(async (req, res) => sendSuccess(res, await el.closeNow(a(req), req.params.electionId, m(req)), "Voting is now closed."));
export const cancelElection = H(async (req, res) => sendSuccess(res, await el.cancel(a(req), req.params.electionId, m(req)), "Election cancelled."));
export const electionTurnout = H(async (req, res) => sendSuccess(res, await el.turnout(a(req), req.params.electionId, m(req))));
export const electionResults = H(async (req, res) => sendSuccess(res, await el.results(a(req), req.params.electionId, m(req))));
export const electionResultsRelease = H(async (req, res) => sendSuccess(res, await el.setResultsPublished(a(req), req.params.electionId, req.body.published, m(req)), req.body.published ? "Results released to students." : "Results withdrawn."));
export const electionStudentSearch = H(async (req, res) => sendSuccess(res, await el.searchStudents(a(req), req.query as never)));
export const electionGroup = H(async (req, res) => sendSuccess(res, await el.groupMembers(a(req), req.params.electionId, req.query as never, m(req))));
export const electionPositions = H(async (req, res) => sendSuccess(res, await el.listPositions(a(req), req.params.electionId, m(req))));
export const createElectionPosition = H(async (req, res) => sendSuccess(res, await el.createPosition(a(req), req.params.electionId, req.body, m(req)), "Position added.", 201));
export const reorderElectionPositions = H(async (req, res) => sendSuccess(res, await el.reorderPositions(a(req), req.params.electionId, req.body.positionIds, m(req)), "Positions reordered."));
export const updateElectionPosition = H(async (req, res) => sendSuccess(res, await el.updatePosition(a(req), req.params.electionId, req.params.positionId, req.body, m(req)), "Position updated."));
export const deleteElectionPosition = H(async (req, res) => { await el.deletePosition(a(req), req.params.electionId, req.params.positionId, m(req)); sendMessage(res, "Position removed."); });
export const electionCandidates = H(async (req, res) => sendSuccess(res, await el.listCandidates(a(req), req.params.electionId, (req.query as { positionId?: string }).positionId, m(req))));
export const addElectionCandidate = H(async (req, res) => sendSuccess(res, await el.addCandidate(a(req), req.params.electionId, { ...req.body, photo: req.file?.buffer }, m(req)), "Candidate added.", 201));
export const updateElectionCandidate = H(async (req, res) => sendSuccess(res, await el.updateCandidate(a(req), req.params.electionId, req.params.candidateId, req.body, m(req)), "Candidate updated."));
export const decideElectionCandidate = H(async (req, res) => sendSuccess(res, await el.decideCandidate(a(req), req.params.electionId, req.params.candidateId, req.body.decision, m(req)), "Candidate updated."));
export const removeElectionCandidate = H(async (req, res) => { await el.removeCandidate(a(req), req.params.electionId, req.params.candidateId, m(req)); sendMessage(res, "Candidate removed."); });
export const setElectionCandidatePhoto = H(async (req, res) => {
  if (!req.file) throw new AppError(400, 'Attach an image in the "photo" field.');
  sendSuccess(res, await el.setCandidatePhoto(a(req), req.params.electionId, req.params.candidateId, req.file.buffer, m(req)), "Candidate photo saved.");
});
export const removeElectionCandidatePhoto = H(async (req, res) => sendSuccess(res, await el.removeCandidatePhoto(a(req), req.params.electionId, req.params.candidateId, m(req)), "Candidate photo removed."));
