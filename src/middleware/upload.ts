import multer from "multer";
import { env } from "../config/env";
import { COMPLAINT_MAX_FILE_MB } from "../utils/constants";

/** In-memory, single file, size-capped. Content type is verified later from the bytes. */
export const profilePhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.floor(env.MAX_PROFILE_PHOTO_MB * 1024 * 1024), files: 1, fields: 0 },
}).single("photo");

/** Assignment submission: optional single "file" plus a few text fields (parsed into req.body). */
export const submissionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.floor(env.MAX_SUBMISSION_MB * 1024 * 1024), files: 1, fields: 5 },
}).single("file");

/** Complaint attachment: one "file" per request, size-capped (the controller enforces the per-complaint file count). */
export const complaintAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: COMPLAINT_MAX_FILE_MB * 1024 * 1024, files: 1, fields: 0 },
}).single("file");

/** Class resource: optional single "file" (multipart) OR a plain JSON body with fileUrl; multer ignores non-multipart requests. */
export const resourceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.floor(env.MAX_RESOURCE_MB * 1024 * 1024), files: 1, fields: 8 },
}).single("file");

/** Optional picture on an announcement: one "image" file plus the announcement's text fields (parsed into req.body). JSON requests pass straight through. */
export const announcementImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.floor(env.MAX_ANNOUNCEMENT_IMAGE_MB * 1024 * 1024), files: 1, fields: 12 },
}).single("image");

/** Candidate photo: optional single "photo" plus a few text fields (positionId, studentId, manifesto, approve) parsed into req.body. */
export const candidatePhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.floor(env.MAX_PROFILE_PHOTO_MB * 1024 * 1024), files: 1, fields: 6 },
}).single("photo");
