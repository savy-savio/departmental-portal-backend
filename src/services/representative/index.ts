import type { DepartmentDocument } from "../../models/Department";
import { Notification } from "../../models/Notification";
import type { StudentDocument } from "../../models/Student";
import { notifyEnrolledStudents, notifyLevelStudents, removeAnnouncementImage, removeClassFile, storeAnnouncementImage, storeClassFile } from "../class-support.service";
import { MongoRepresentativeStore } from "./mongo-store";
import { RepresentativeService } from "./representative.service";
import type { RepActor } from "./types";

/** Identity for the engine always comes from the authenticated student + their own department; never from the request. */
export const repActorFrom = (student: StudentDocument, department: DepartmentDocument): RepActor => ({
  studentId: String(student._id), departmentId: String(department._id), firstName: student.firstName, lastName: student.lastName,
});

export const representativeService = new RepresentativeService({
  store: new MongoRepresentativeStore(),
  now: () => new Date(),
  notifyClass: (course, n, excludeStudentId) => notifyEnrolledStudents(course, n, excludeStudentId),
  notifyLevel: (c, n, excludeStudentId) => notifyLevelStudents(c, n, excludeStudentId),
  uploadAnnouncementImage: (buffer) => storeAnnouncementImage(buffer),
  deleteAnnouncementImage: (publicId) => removeAnnouncementImage(publicId),
  unreadNotifications: (studentId) => Notification.countDocuments({ recipient: studentId, readAt: { $exists: false } }),
  uploadFile: (f) => storeClassFile(f, "portal/class-resources"),
  deleteFile: (f) => removeClassFile(f),
});
