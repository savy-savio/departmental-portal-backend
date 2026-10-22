import { sniffImage } from "./image";

export interface SniffedFile {
  mimeType: string;
  ext: string;
  resourceType: "image" | "raw";
}

/**
 * Accepts PDF, JPEG/PNG/WebP, and DOCX, judged by the file's bytes (never the client's mimetype).
 * DOCX is a ZIP container, so we also require the .docx extension; other ZIP-based types are refused.
 */
export function sniffSubmissionFile(buf: Buffer, originalName: string): SniffedFile | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { mimeType: "application/pdf", ext: "pdf", resourceType: "raw" };
  }
  const img = sniffImage(buf);
  if (img) return { mimeType: img.mime, ext: img.ext, resourceType: "image" };
  const isZip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  if (isZip && originalName.toLowerCase().endsWith(".docx")) {
    return {
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ext: "docx",
      resourceType: "raw",
    };
  }
  return null;
}

/** Strip path parts and odd characters from a client-supplied file name before storing it for display. */
export function safeDisplayName(name: string): string {
  return name.replace(/^.*[\\/]/, "").replace(/[^\w.\- ()]/g, "_").slice(0, 150) || "file";
}

/**
 * Class resources: PDF, images, and Office documents (DOCX / PPTX / XLSX). Judged by bytes; the Office formats are
 * ZIP containers so they also need the matching extension. Anything else (scripts, executables, other zips) is refused.
 */
export function sniffResourceFile(buf: Buffer, originalName: string): SniffedFile | null {
  const base = sniffSubmissionFile(buf, originalName);
  if (base) return base;
  const isZip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  const lower = originalName.toLowerCase();
  if (isZip && lower.endsWith(".pptx")) return { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx", resourceType: "raw" };
  if (isZip && lower.endsWith(".xlsx")) return { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx", resourceType: "raw" };
  return null;
}
