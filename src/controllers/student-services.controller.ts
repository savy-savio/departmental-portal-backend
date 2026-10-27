import type { Request, Response } from "express";
import * as attendance from "../services/student-attendance.service";
import { attendanceSecurity } from "../services/attendance";
import * as complaints from "../services/student-complaints.service";
import * as complaintAi from "../services/ai/complaint-ai.service";
import * as notifications from "../services/notification.service";
import { AppError } from "../utils/AppError";
import { asyncHandler } from "../utils/asyncHandler";
import { realtime } from "../realtime/instance";
import { sendMessage, sendSuccess } from "../utils/response";

function authed(req: Request) {
  if (!req.student || !req.department) throw new AppError(401, "Authentication required.");
  return { student: req.student, department: req.department };
}

/* attendance */
export const listAttendance = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await attendance.listAttendance(student, department, (req.query as { courseCode?: string }).courseCode));
});
/* attendance security (device binding, challenge, mark) */
const DEVICE_HEADER = "x-attendance-device";
function attendanceContext(req: Request) {
  const { student, department } = authed(req);
  return {
    actor: { studentId: String(student._id), departmentId: String(department._id), firstName: student.firstName, email: student.email },
    // The IP is recorded for audit / suspicious-activity detection only. It is never an identity.
    meta: { ip: req.ip ?? "unknown", userAgent: req.get("user-agent") ?? undefined },
    presentedDevice: req.get(DEVICE_HEADER) ?? undefined,
  };
}
export const deviceStatus = asyncHandler(async (req: Request, res: Response) => {
  const c = attendanceContext(req);
  sendSuccess(res, await attendanceSecurity.getDeviceStatus(c.actor, c.presentedDevice));
});
export const requestDeviceVerification = asyncHandler(async (req: Request, res: Response) => {
  const c = attendanceContext(req);
  const data = await attendanceSecurity.requestDeviceVerification(c.actor, c.meta, req.body.password, c.presentedDevice);
  sendSuccess(res, data, "A verification code has been sent to your email.");
});
export const registerDevice = asyncHandler(async (req: Request, res: Response) => {
  const c = attendanceContext(req);
  const data = await attendanceSecurity.completeDeviceRegistration(c.actor, c.meta, req.body, c.presentedDevice);
  sendSuccess(res, data, data.replaced ? "Your new attendance device is ready." : "This device is now registered for attendance.", 201);
});
export const createChallenge = asyncHandler(async (req: Request, res: Response) => {
  const c = attendanceContext(req);
  sendSuccess(res, await attendanceSecurity.createChallenge(c.actor, c.meta, req.params.sessionId, c.presentedDevice), "Attendance token issued.");
});
export const markAttendance = asyncHandler(async (req: Request, res: Response) => {
  const c = attendanceContext(req);
  sendSuccess(res, await attendanceSecurity.markAttendance(c.actor, c.meta, req.params.sessionId, c.presentedDevice, req.body), "Attendance marked.", 201);
});

/* complaints */
export const listComplaints = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await complaints.listComplaints(student, department, req.query as never));
});
export const complaintStats = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, await complaints.complaintStats(authed(req).student));
});
export const complaintConstraints = asyncHandler(async (_req: Request, res: Response) => {
  sendSuccess(res, complaints.uploadConstraints());
});
export const complaintAiInfo = asyncHandler(async (_req: Request, res: Response) => {
  sendSuccess(res, complaintAi.complaintAiInfo());
});
export const complaintAiAssist = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await complaintAi.assistComplaint(student, department, req.body));
});
export const getComplaint = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await complaints.getComplaint(student, department, req.params.id));
});
export const createComplaint = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await complaints.createComplaint(student, department, req.body), "Complaint submitted.", 201);
});
export const updateComplaint = asyncHandler(async (req: Request, res: Response) => {
  const { student, department } = authed(req);
  sendSuccess(res, await complaints.updateComplaint(student, department, req.params.id, req.body), "Complaint updated.");
});
export const addComplaintAttachment = asyncHandler(async (req: Request, res: Response) => {
  const { student } = authed(req);
  sendSuccess(res, await complaints.addAttachment(student, req.params.id, req.file), "Attachment added.", 201);
});

/* notifications */
export const listNotifications = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, await notifications.listNotifications(authed(req).student, req.query as never));
});
export const markNotificationRead = asyncHandler(async (req: Request, res: Response) => {
  const result = await notifications.markRead(authed(req).student, req.params.id);
  realtime.emitToUser({ userType: "STUDENT", userId: String(authed(req).student._id) }, "notification:read", { id: req.params.id });
  sendSuccess(res, result);
});
export const markAllNotificationsRead = asyncHandler(async (req: Request, res: Response) => {
  const updated = await notifications.markAllRead(authed(req).student);
  realtime.emitToUser({ userType: "STUDENT", userId: String(authed(req).student._id) }, "notification:read", { all: true });
  sendMessage(res, updated ? `${updated} notification(s) marked as read.` : "No unread notifications.");
});
