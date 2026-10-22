import type { Response } from "express";

export function sendSuccess<T>(res: Response, data: T, message?: string, status = 200): Response {
  return res.status(status).json({ success: true, ...(message ? { message } : {}), data });
}

export function sendMessage(res: Response, message: string, status = 200): Response {
  return res.status(status).json({ success: true, message });
}
