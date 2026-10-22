import { randomUUID } from "node:crypto";
import type { DepartmentDocument } from "../models/Department";
import { Student, StudentDocument } from "../models/Student";
import { AppError } from "../utils/AppError";
import { toStudentDTO } from "../utils/dto";
import { sniffImage } from "../utils/image";
import { logger } from "../utils/logger";
import type { UpdateProfileInput } from "../validators/student-profile.validators";
import { deleteImage, uploadImage } from "./storage.service";

export async function updateProfile(student: StudentDocument, department: DepartmentDocument, input: UpdateProfileInput) {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, ""> = {};
  for (const key of ["phone", "sex"] as const) {
    if (input[key] === undefined) continue;
    if (input[key] === null) $unset[key] = "";
    else $set[key] = input[key];
  }

  const update: Record<string, unknown> = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;

  // Query is pinned to the authenticated student's own _id.
  const updated = await Student.findByIdAndUpdate(student._id, update, { new: true, runValidators: true });
  if (!updated) throw new AppError(401, "Authentication required.");
  return toStudentDTO(updated, department);
}

export async function setProfilePhoto(student: StudentDocument, department: DepartmentDocument, file: Buffer | undefined) {
  if (!file || file.length === 0) throw new AppError(400, 'Attach an image in the "photo" field.');
  if (!sniffImage(file)) throw new AppError(415, "Only JPEG, PNG or WebP images are allowed.");

  const current = await Student.findById(student._id).select("+profilePhotoPublicId");
  if (!current) throw new AppError(401, "Authentication required.");

  // Random per-upload id: unguessable, and a fresh URL means no stale cached avatar after a change.
  const saved = await uploadImage(file, {
    folder: "portal/profile-photos",
    publicId: `${String(student._id)}-${randomUUID()}`,
    squareSize: 400,
  });

  const updated = await Student.findByIdAndUpdate(
    student._id,
    { $set: { profilePhoto: saved.url, profilePhotoPublicId: saved.publicId } },
    { new: true },
  );
  if (!updated) {
    await deleteImage(saved.publicId).catch(() => undefined);
    throw new AppError(401, "Authentication required.");
  }

  if (current.profilePhotoPublicId) {
    await deleteImage(current.profilePhotoPublicId).catch((e) => logger.warn("Could not delete old photo:", e));
  }
  return toStudentDTO(updated, department);
}

export async function removeProfilePhoto(student: StudentDocument, department: DepartmentDocument) {
  const current = await Student.findById(student._id).select("+profilePhotoPublicId");
  if (!current) throw new AppError(401, "Authentication required.");

  const updated = await Student.findByIdAndUpdate(
    student._id,
    { $unset: { profilePhoto: "", profilePhotoPublicId: "" } },
    { new: true },
  );
  if (!updated) throw new AppError(401, "Authentication required.");

  if (current.profilePhotoPublicId) {
    await deleteImage(current.profilePhotoPublicId).catch((e) => logger.warn("Could not delete photo:", e));
  }
  return toStudentDTO(updated, department);
}
