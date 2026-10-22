import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Cryptographically secure random token (hex). */
export const generateToken = (bytes = 32): string => randomBytes(bytes).toString("hex");

/** One-way hash for tokens we store (reset tokens). High-entropy input, so SHA-256 is appropriate. */
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Attendance codes are compared case-insensitively and ignoring surrounding spaces. */
export const hashAttendanceCode = (code: string): string => sha256(code.trim().toUpperCase());


/** 256-bit device token, hex (64 chars). Only its hash is ever stored. */
export const generateDeviceToken = (): string => randomBytes(32).toString("hex");
export const DEVICE_TOKEN_REGEX = /^[a-f0-9]{64}$/;

/** 6-digit one-time code, uniform and cryptographically random. */
export const generateOtp = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

export const hmacSha256 = (key: string, value: string): string => createHmac("sha256", key).update(value).digest("hex");

/** Constant-time comparison of two hex/utf8 strings (false if lengths differ). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
