import { randomUUID } from "node:crypto";
import { env } from "../../config/env";
import { Hod } from "../../models/Hod";
import { AppError } from "../../utils/AppError";
import { generateToken, sha256 } from "../../utils/crypto";
import { sniffImage } from "../../utils/image";
import { removeAnnouncementImage, removeClassFile, storeAnnouncementImage, storeClassFile } from "../class-support.service";
import { sendHodResetEmail, sendLecturerInviteEmail } from "../email.service";
import { MongoLecturerAuthStore } from "../lecturer/mongo-auth-store";
import { LecturerAuthService } from "../lecturer/auth.service";
import { notify } from "../notification.service";
import { fakePasswordCheck, hashPassword, verifyPassword } from "../password.service";
import { deleteImage, signedPrivateUrl, uploadImage } from "../storage.service";
import { signHodAccessToken, verifyHodAccessToken } from "../token.service";
import { HodService } from "./hod.service";
import { MongoHodStore } from "./mongo-store";
import { notifyDepartmentStudentsBatch, notifyElectionVoters } from "./notify";
import { ElectionAdminService } from "./election/election.service";
import { MongoElectionStore } from "./election/mongo-store";

/** The SAME login engine as lecturers, configured for HODs: own collection, own token audience, role HOD. */
export const hodAuth = new LecturerAuthService({
  store: new MongoLecturerAuthStore(Hod as never),
  now: () => new Date(), hashPassword, verifyPassword, fakePasswordCheck,
  signAccessToken: signHodAccessToken, verifyAccessToken: verifyHodAccessToken, generateToken: () => generateToken(32),
  role: "HOD", notRoleCode: "NOT_A_HOD", resetTtlMinutes: env.PASSWORD_RESET_EXPIRES_MINUTES, sendResetEmail: sendHodResetEmail,
});

export const hodService = new HodService({
  store: new MongoHodStore(),
  now: () => new Date(),
  generateToken: () => generateToken(32),
  hashToken: sha256,
  sendInvite: sendLecturerInviteEmail, // a HOD invites LECTURERS, so the lecturer activation page is used
  uploadFile: (f) => storeClassFile(f, "portal/department-documents"),
  uploadAnnouncementImage: (buffer) => storeAnnouncementImage(buffer),
  deleteAnnouncementImage: (publicId) => removeAnnouncementImage(publicId),
  deleteFile: (f) => removeClassFile(f),
  uploadAvatar: async (buffer, hodId) => {
    if (!sniffImage(buffer)) throw new AppError(415, "Only JPEG, PNG or WebP images are allowed.", undefined, "UNSUPPORTED_FILE_TYPE");
    const saved = await uploadImage(buffer, { folder: "portal/hod-photos", publicId: `${hodId}-${randomUUID()}`, squareSize: 400 });
    return { url: saved.url, publicId: saved.publicId };
  },
  deleteAvatar: (publicId) => deleteImage(publicId),
  signPrivateFile: (f) => signedPrivateUrl(f),
  notifyStudent: (studentId, departmentId, n) => notify({ recipient: studentId as never, department: departmentId as never, kind: n.kind as never, title: n.title, body: n.body, link: n.link }),
  notifyLecturer: (lecturerId, departmentId, n) => notify({ recipient: lecturerId as never, recipientType: "LECTURER", department: departmentId as never, kind: n.kind as never, title: n.title, body: n.body, link: n.link }),
  notifyDepartmentStudents: (departmentId, levels, n) => notifyDepartmentStudentsBatch(departmentId, levels, n),
});

/** Election administration (own store; the same HOD authorization chain protects every route). Candidate photos live in their own Cloudinary folder. */
export const electionAdminService = new ElectionAdminService({
  store: new MongoElectionStore(),
  now: () => new Date(),
  uploadCandidatePhoto: async (buffer, electionId) => {
    const saved = await uploadImage(buffer, { folder: "portal/election-candidates", publicId: `${electionId}-${randomUUID()}`, squareSize: 600 });
    return { url: saved.url, publicId: saved.publicId };
  },
  deleteCandidatePhoto: (publicId) => deleteImage(publicId),
  notifyVoters: (e, n) => notifyElectionVoters(e, n),
});
