import type { Request, Response } from "express";
import { actorOf } from "../middleware/representative";
import { listNotifications } from "../services/notification.service";
import { representativeService as rep } from "../services/representative";
import { asyncHandler } from "../utils/asyncHandler";
import { sendMessage, sendSuccess } from "../utils/response";

/** Thin handlers: identity comes from authenticateStudent, authority from the assignment, the real checks live in the service. */
export const profile = asyncHandler(async (req: Request, res: Response) => {
  const data = await rep.getProfile(actorOf(req));
  sendSuccess(res, { student: req.student && { id: String(req.student._id), firstName: req.student.firstName, lastName: req.student.lastName, matricNumber: req.student.matricNumber, level: req.student.level }, ...data });
});
export const assignments = asyncHandler(async (req: Request, res: Response) => sendSuccess(res, await rep.listAssignments(actorOf(req))));
export const overview = asyncHandler(async (req: Request, res: Response) => sendSuccess(res, await rep.overview(actorOf(req))));
export const courses = asyncHandler(async (req: Request, res: Response) => sendSuccess(res, await rep.listCourses(actorOf(req))));
export const course = asyncHandler(async (req: Request, res: Response) => sendSuccess(res, await rep.getCourse(actorOf(req), req.params.courseId)));
export const members = asyncHandler(async (req: Request, res: Response) =>
  sendSuccess(res, await rep.listMembers(actorOf(req), req.params.courseId, req.query as never)));
export const timetable = asyncHandler(async (req: Request, res: Response) => sendSuccess(res, await rep.getTimetable(actorOf(req), req.query as never)));
export const createTimetable = asyncHandler(async (req: Request, res: Response) =>
  sendSuccess(res, await rep.createTimetableEntry(actorOf(req), req.body), "Timetable entry added.", 201));
export const updateTimetable = asyncHandler(async (req: Request, res: Response) =>
  sendSuccess(res, await rep.updateTimetableEntry(actorOf(req), req.params.id, req.body), "Timetable entry updated."));
export const deleteTimetable = asyncHandler(async (req: Request, res: Response) => {
  await rep.deleteTimetableEntry(actorOf(req), req.params.id);
  sendMessage(res, "Timetable entry deleted.");
});

export const listAnnouncements = asyncHandler(async (req: Request, res: Response) =>
  sendSuccess(res, await rep.listAnnouncements(actorOf(req), req.query as never)));
export const createAnnouncement = asyncHandler(async (req: Request, res: Response) => {
  const { message, ...rest } = req.body;
  sendSuccess(res, await rep.createAnnouncement(actorOf(req), { ...rest, body: message, image: req.file?.buffer }), "Announcement created.", 201);
});
export const updateAnnouncement = asyncHandler(async (req: Request, res: Response) => {
  const { message, ...rest } = req.body;
  sendSuccess(res, await rep.updateAnnouncement(actorOf(req), req.params.announcementId, { ...rest, ...(message !== undefined ? { body: message } : {}), image: req.file?.buffer }), "Announcement updated.");
});
export const deleteAnnouncement = asyncHandler(async (req: Request, res: Response) => {
  await rep.deleteAnnouncement(actorOf(req), req.params.announcementId);
  sendMessage(res, "Announcement deleted.");
});

export const listResources = asyncHandler(async (req: Request, res: Response) => sendSuccess(res, await rep.listResources(actorOf(req), req.query as never)));
export const createResource = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file ? { buffer: req.file.buffer, originalName: req.file.originalname } : undefined;
  sendSuccess(res, await rep.createResource(actorOf(req), { ...req.body, file }), "Resource added.", 201);
});
export const updateResource = asyncHandler(async (req: Request, res: Response) =>
  sendSuccess(res, await rep.updateResource(actorOf(req), req.params.resourceId, req.body), "Resource updated."));
export const deleteResource = asyncHandler(async (req: Request, res: Response) => {
  await rep.deleteResource(actorOf(req), req.params.resourceId);
  sendMessage(res, "Resource deleted.");
});

/** Representatives are students: this is the very same notification feed, scoped to their own account. */
export const notifications = asyncHandler(async (req: Request, res: Response) => {
  if (!req.student) throw new Error("unreachable");
  sendSuccess(res, await listNotifications(req.student, req.query as never));
});
