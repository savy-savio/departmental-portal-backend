import { randomUUID } from "node:crypto";
import { env } from "../../config/env";
import { AppError } from "../../utils/AppError";
import { generateToken } from "../../utils/crypto";
import { sniffImage } from "../../utils/image";
import { notifyEnrolledStudents, removeAnnouncementImage, removeClassFile, storeAnnouncementImage, storeClassFile } from "../class-support.service";
import { sendLecturerResetEmail } from "../email.service";
import { fakePasswordCheck, hashPassword, verifyPassword } from "../password.service";
import { deleteImage, signedPrivateUrl, uploadImage } from "../storage.service";
import { signLecturerAccessToken, verifyLecturerAccessToken } from "../token.service";
import { LecturerAuthService } from "./auth.service";
import { LecturerService } from "./lecturer.service";
import { Lecturer } from "../../models/Lecturer";
import { MongoLecturerAuthStore } from "./mongo-auth-store";
import { notifyDepartmentHod } from "../hod/notify";
import { notify } from "../notification.service";
import { MongoLecturerStore } from "./mongo-store";

export const lecturerAuth = new LecturerAuthService({
  store: new MongoLecturerAuthStore(Lecturer),
  now: () => new Date(),
  hashPassword, verifyPassword, fakePasswordCheck,
  signAccessToken: signLecturerAccessToken,
  verifyAccessToken: verifyLecturerAccessToken,
  generateToken: () => generateToken(32),
  resetTtlMinutes: env.PASSWORD_RESET_EXPIRES_MINUTES,
  sendResetEmail: sendLecturerResetEmail,
});

export const lecturerService = new LecturerService({
  maxCreatorAccuracyMeters: env.ATTENDANCE_CREATOR_MAX_ACCURACY_METERS,
  store: new MongoLecturerStore(),
  now: () => new Date(),
  notifyClass: (course, n) => notifyEnrolledStudents(course, n),
  uploadFile: (f) => storeClassFile(f, "portal/course-materials"),
  uploadAnnouncementImage: (buffer) => storeAnnouncementImage(buffer),
  deleteAnnouncementImage: (publicId) => removeAnnouncementImage(publicId),
  deleteFile: (f) => removeClassFile(f),
  uploadAvatar: async (buffer, lecturerId) => {
    if (!sniffImage(buffer)) throw new AppError(415, "Only JPEG, PNG or WebP images are allowed.", undefined, "UNSUPPORTED_FILE_TYPE");
    const saved = await uploadImage(buffer, { folder: "portal/lecturer-photos", publicId: `${lecturerId}-${randomUUID()}`, squareSize: 400 });
    return { url: saved.url, publicId: saved.publicId };
  },
  deleteAvatar: (publicId) => deleteImage(publicId),
  signSubmissionFile: (f) => signedPrivateUrl(f),
  notifyHod: (departmentId, n) => notifyDepartmentHod(departmentId, { kind: n.kind, title: n.title, body: n.body, link: n.link, complaintId: n.complaintId }),
  notifyStudent: (studentId, departmentId, n) => notify({ recipient: studentId as never, department: departmentId as never, kind: n.kind as never, title: n.title, body: n.body, link: n.link }),
});
