import { v2 as cloudinary, UploadApiResponse } from "cloudinary";
import { env } from "../config/env";
import { AppError } from "../utils/AppError";

/**
 * Image storage on Cloudinary. Kept behind a small interface so feature code
 * (profile photos now; materials/attachments later) never imports the SDK directly.
 */
export interface StoredImage {
  /** Cloudinary public_id; keep it so the image can be deleted later. */
  publicId: string;
  /** HTTPS delivery URL. */
  url: string;
}

let configured = false;
function ensureConfigured(): void {
  if (!env.cloudinaryConfigured) {
    throw new AppError(503, "Image uploads are not configured on this server.");
  }
  if (!configured) {
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    configured = true;
  }
}

export interface UploadImageOptions {
  /** Folder inside Cloudinary, e.g. "portal/profile-photos". */
  folder: string;
  /** File name without extension. Must be unique per upload. */
  publicId: string;
  /** Square crop around the face, e.g. 400 for avatars. */
  squareSize?: number;
}

export function uploadImage(data: Buffer, opts: UploadImageOptions): Promise<StoredImage> {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: opts.folder,
        public_id: opts.publicId,
        resource_type: "image",
        overwrite: false,
        // Cloudinary re-validates the bytes server-side; this is a second line of defence after our own check.
        allowed_formats: ["jpg", "png", "webp"],
        ...(opts.squareSize
          ? { transformation: [{ width: opts.squareSize, height: opts.squareSize, crop: "fill", gravity: "auto" }] }
          : {}),
        quality: "auto",
        fetch_format: "auto",
      },
      (error, result?: UploadApiResponse) => {
        if (error || !result) return reject(error ?? new Error("Cloudinary returned no result"));
        resolve({ publicId: result.public_id, url: result.secure_url });
      },
    );
    stream.end(data);
  });
}

export async function deleteImage(publicId: string): Promise<void> {
  ensureConfigured();
  await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
}

/* ----------------- private files (assignment submissions) ----------------- */

export interface StoredPrivateFile {
  publicId: string;
  resourceType: "image" | "raw";
}

/**
 * Uploads with `type: "authenticated"`: the file has NO public URL. Access needs a signed URL,
 * which the API only hands to the owner (and, in later phases, the course's staff).
 * For "raw" files (pdf/docx) the public_id must include the extension.
 */
export function uploadPrivateFile(
  data: Buffer,
  opts: { folder: string; publicId: string; resourceType: "image" | "raw" },
): Promise<StoredPrivateFile> {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: opts.folder,
        public_id: opts.publicId,
        resource_type: opts.resourceType,
        type: "authenticated",
        overwrite: false,
      },
      (error, result?: UploadApiResponse) => {
        if (error || !result) return reject(error ?? new Error("Cloudinary returned no result"));
        resolve({ publicId: result.public_id, resourceType: opts.resourceType });
      },
    );
    stream.end(data);
  });
}

export function signedPrivateUrl(file: StoredPrivateFile): string {
  ensureConfigured();
  return cloudinary.url(file.publicId, {
    resource_type: file.resourceType,
    type: "authenticated",
    sign_url: true,
    secure: true,
  });
}

export async function deletePrivateFile(file: StoredPrivateFile): Promise<void> {
  ensureConfigured();
  await cloudinary.uploader.destroy(file.publicId, { resource_type: file.resourceType, type: "authenticated", invalidate: true });
}

/* ----------------- public files (class resources) ----------------- */
/** Class resources are meant to be opened by the whole class, so they are PUBLIC deliveries with unguessable names. */
export function uploadPublicFile(
  data: Buffer,
  opts: { folder: string; publicId: string; resourceType: "image" | "raw" },
): Promise<{ publicId: string; url: string; resourceType: "image" | "raw" }> {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: opts.folder, public_id: opts.publicId, resource_type: opts.resourceType, overwrite: false },
      (error, result?: UploadApiResponse) => {
        if (error || !result) return reject(error ?? new Error("Cloudinary returned no result"));
        resolve({ publicId: result.public_id, url: result.secure_url, resourceType: opts.resourceType });
      },
    );
    stream.end(data);
  });
}
export async function deletePublicFile(publicId: string, resourceType: "image" | "raw"): Promise<void> {
  ensureConfigured();
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
}
