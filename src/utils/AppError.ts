/** An error we expect and can describe safely to the client. */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;
  /** Stable machine-readable reason (e.g. "DEVICE_BOUND_TO_OTHER_STUDENT") the frontend can branch on. */
  public readonly code?: string;

  constructor(statusCode: number, message: string, details?: unknown, code?: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.details = details;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
