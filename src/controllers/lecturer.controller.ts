import type { Request, Response } from "express";
import { lecturerActor, lecturerMeta } from "../middleware/lecturer";
import { lecturerAuth, lecturerService as svc } from "../services/lecturer";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";
import { realtime } from "../realtime/instance";
import { sendMessage, sendSuccess } from "../utils/response";

const H = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncHandler(async (req, res) => void (await fn(req, res)));
const file = (req: Request) => (req.file ? { buffer: req.file.buffer, originalName: req.file.originalname } : undefined);

/* ---- auth (public) ---- */
export const login = H(async (req, res) => sendSuccess(res, await lecturerAuth.login(req.body.email, req.body.password), "Login successful."));
export const activate = H(async (req, res) => sendSuccess(res, await lecturerAuth.activate(req.body.token, req.body.password), "Your account is active.", 201));
export const forgotPassword = H(async (req, res) => {
  await lecturerAuth.forgotPassword(req.body.email);
  sendMessage(res, "If an account exists for that email, a reset link has been sent."); // identical either way
});
export const resetPassword = H(async (req, res) => { await lecturerAuth.resetPassword(req.body.token, req.body.password); sendMessage(res, "Your password has been reset. You can now log in."); });
export const changePassword = H(async (req, res) => sendSuccess(res, await lecturerAuth.changePassword(lecturerActor(req).lecturerId, req.body.currentPassword, req.body.password), "Password changed."));
export const logout = H(async (_req, res) => sendMessage(res, "Logged out."));

/* ---- profile / dashboard ---- */
export const profile = H(async (req, res) => sendSuccess(res, await svc.getProfile(lecturerActor(req))));
export const updateProfile = H(async (req, res) => sendSuccess(res, await svc.updateProfile(lecturerActor(req), req.body, lecturerMeta(req)), "Profile updated."));
export const uploadPhoto = H(async (req, res) => {
  if (!req.file) throw new AppError(400, 'Attach an image in the "photo" field.');
  sendSuccess(res, await svc.setProfilePhoto(lecturerActor(req), req.file.buffer, lecturerMeta(req)), "Profile photo updated.");
});
export const dashboard = H(async (req, res) => sendSuccess(res, await svc.dashboard(lecturerActor(req))));

/* ---- courses ---- */
export const courses = H(async (req, res) => sendSuccess(res, await svc.listCourses(lecturerActor(req))));
export const course = H(async (req, res) => sendSuccess(res, await svc.getCourse(lecturerActor(req), req.params.courseId, lecturerMeta(req))));
export const students = H(async (req, res) => sendSuccess(res, await svc.listStudents(lecturerActor(req), req.params.courseId, req.query as never, lecturerMeta(req))));
export const timetable = H(async (req, res) => sendSuccess(res, await svc.getTimetable(lecturerActor(req), req.query as never, lecturerMeta(req))));

/* ---- official materials ---- */
export const listMaterials = H(async (req, res) => sendSuccess(res, await svc.listMaterials(lecturerActor(req), req.params.courseId, lecturerMeta(req))));
export const createMaterial = H(async (req, res) => sendSuccess(res, await svc.createMaterial(lecturerActor(req), req.params.courseId, { ...req.body, file: file(req) }, lecturerMeta(req)), "Material added.", 201));
export const updateMaterial = H(async (req, res) => sendSuccess(res, await svc.updateMaterial(lecturerActor(req), req.params.materialId, req.body, lecturerMeta(req)), "Material updated."));
export const deleteMaterial = H(async (req, res) => { await svc.deleteMaterial(lecturerActor(req), req.params.materialId, lecturerMeta(req)); sendMessage(res, "Material deleted."); });

/* ---- announcements ---- */
export const listAnnouncements = H(async (req, res) => sendSuccess(res, await svc.listAnnouncements(lecturerActor(req), req.query as never, lecturerMeta(req))));
export const createAnnouncement = H(async (req, res) => sendSuccess(res, await svc.createAnnouncement(lecturerActor(req), { ...req.body, image: req.file?.buffer }, lecturerMeta(req)), "Announcement created.", 201));
export const updateAnnouncement = H(async (req, res) => sendSuccess(res, await svc.updateAnnouncement(lecturerActor(req), req.params.announcementId, { ...req.body, image: req.file?.buffer }, lecturerMeta(req)), "Announcement updated."));
export const deleteAnnouncement = H(async (req, res) => { await svc.deleteAnnouncement(lecturerActor(req), req.params.announcementId, lecturerMeta(req)); sendMessage(res, "Announcement deleted."); });

/* ---- assignments ---- */
export const listAssignments = H(async (req, res) => sendSuccess(res, await svc.listCourseWork(lecturerActor(req), req.query as never, lecturerMeta(req))));
export const createAssignment = H(async (req, res) => sendSuccess(res, await svc.createCourseWork(lecturerActor(req), req.params.courseId, { ...req.body, file: file(req) }, lecturerMeta(req)), "Assignment created.", 201));
export const updateAssignment = H(async (req, res) => sendSuccess(res, await svc.updateCourseWork(lecturerActor(req), req.params.assignmentId, req.body, lecturerMeta(req)), "Assignment updated."));
export const deleteAssignment = H(async (req, res) => { await svc.deleteCourseWork(lecturerActor(req), req.params.assignmentId, lecturerMeta(req)); sendMessage(res, "Assignment deleted."); });
export const submissions = H(async (req, res) => sendSuccess(res, await svc.listSubmissions(lecturerActor(req), req.params.assignmentId, lecturerMeta(req))));

/* ---- attendance ---- */
export const listSessions = H(async (req, res) => sendSuccess(res, await svc.listAttendanceSessions(lecturerActor(req), req.params.courseId, lecturerMeta(req))));
export const createSession = H(async (req, res) => sendSuccess(res, await svc.createAttendanceSession(lecturerActor(req), req.params.courseId, req.body, lecturerMeta(req)), "Attendance session created.", 201));
export const attendanceStats = H(async (req, res) => sendSuccess(res, await svc.attendanceStatistics(lecturerActor(req), req.params.courseId, lecturerMeta(req))));
export const getSession = H(async (req, res) => sendSuccess(res, await svc.getAttendanceSession(lecturerActor(req), req.params.sessionId, lecturerMeta(req))));
export const closeSession = H(async (req, res) => sendSuccess(res, await svc.closeAttendanceSession(lecturerActor(req), req.params.sessionId, lecturerMeta(req)), "Attendance closed."));
export const openSession = H(async (req, res) => sendSuccess(res, await svc.openAttendanceSession(lecturerActor(req), req.params.sessionId, req.body, lecturerMeta(req)), "Attendance open."));

/* ---- notifications ---- */
export const notifications = H(async (req, res) => sendSuccess(res, await svc.listNotifications(lecturerActor(req), req.query as never)));
export const markRead = H(async (req, res) => { const r = await svc.markNotificationRead(lecturerActor(req), req.params.notificationId); realtime.emitToUser({ userType: "LECTURER", userId: lecturerActor(req).lecturerId }, "notification:read", { id: req.params.notificationId }); sendSuccess(res, r); });
export const markAllRead = H(async (req, res) => { const r = await svc.markAllNotificationsRead(lecturerActor(req)); realtime.emitToUser({ userType: "LECTURER", userId: lecturerActor(req).lecturerId }, "notification:read", { all: true }); sendSuccess(res, r); });

/* ---- complaints forwarded by the HOD ---- */
export const complaints = H(async (req, res) => sendSuccess(res, await svc.listComplaints(lecturerActor(req), req.query as never)));
export const complaint = H(async (req, res) => sendSuccess(res, await svc.getComplaint(lecturerActor(req), req.params.complaintId, lecturerMeta(req))));
export const complaintHistory = H(async (req, res) => sendSuccess(res, await svc.complaintHistory(lecturerActor(req), req.params.complaintId, lecturerMeta(req))));
export const respondComplaint = H(async (req, res) => sendSuccess(res, await svc.respondToComplaint(lecturerActor(req), req.params.complaintId, req.body, lecturerMeta(req)), "Response recorded."));
export const complaintStatus = H(async (req, res) => sendSuccess(res, await svc.setComplaintStatus(lecturerActor(req), req.params.complaintId, req.body, lecturerMeta(req)), "Complaint updated."));
