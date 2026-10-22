import type { ErrorRequestHandler, RequestHandler } from "express";
import mongoose from "mongoose";
import { ZodError } from "zod";
import { AppError } from "../utils/AppError";
import { env } from "../config/env";
import { logger } from "../utils/logger";

export const notFound: RequestHandler = (req, _res, next) => {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

interface MongoDuplicateError {
  code: number;
  keyPattern?: Record<string, unknown>;
}
const isDuplicateKeyError = (err: unknown): err is MongoDuplicateError =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000;

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let message = "Something went wrong. Please try again.";
  let errors: unknown;
  let code: string | undefined;

  if (err instanceof AppError) {
    status = err.statusCode;
    message = err.message;
    errors = err.details;
    code = err.code;
  } else if (err instanceof ZodError) {
    status = 422;
    message = "Validation failed";
    errors = err.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = 422;
    message = "Validation failed";
    errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    message = `Invalid value for ${err.path}`;
  } else if (err instanceof Error && err.name === "MulterError") {
    const code = (err as Error & { code?: string }).code;
    status = code === "LIMIT_FILE_SIZE" ? 413 : 400;
    message = code === "LIMIT_FILE_SIZE" ? "That file is too large." : "Upload a single file in the expected field.";
  } else if (isDuplicateKeyError(err)) {
    status = 409;
    const field = Object.keys(err.keyPattern ?? {})[0];
    message = field === "email" ? "This email address is already registered." : "That record already exists.";
  } else if (typeof err === "object" && err !== null && "type" in err) {
    const type = (err as { type: string }).type;
    if (type === "entity.parse.failed") {
      status = 400;
      message = "Request body is not valid JSON.";
    } else if (type === "entity.too.large") {
      status = 413;
      message = "Request body is too large.";
    }
  }

  if (status >= 500) {
    logger.error(`${req.method} ${req.originalUrl}`, err);
    if (env.isProduction) message = "Something went wrong. Please try again.";
    else if (err instanceof Error) message = err.message;
  }

  res.status(status).json({ success: false, message, ...(code ? { code } : {}), ...(errors ? { errors } : {}) });
};
