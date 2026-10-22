import { z } from "zod";

/** Only these keys are accepted. studentId, deviceId, courseId, sessionId-in-body, department... are all rejected (.strict()):
 *  identity comes from the JWT, the device from the X-Attendance-Device header, the session from the URL. */
export const passwordBody = z.object({ password: z.string().min(1).max(128) }).strict();

export const registerDeviceBody = z
  .object({
    code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your email"),
    label: z.string().trim().min(1).max(60).optional(),
  })
  .strict();

export const challengeBody = z.object({}).strict();

export const markAttendanceBody = z
  .object({
    attendanceToken: z.string().regex(/^[a-f0-9]{64}$/, "Invalid attendance token"),
    // Required: GPS is one mandatory layer. Numbers only (no strings), within valid ranges.
    latitude: z.number({ required_error: "latitude is required" }).min(-90).max(90),
    longitude: z.number({ required_error: "longitude is required" }).min(-180).max(180),
    accuracyMeters: z.number({ required_error: "accuracyMeters is required" }).min(0).max(100_000), // required: a client can no longer skip the accuracy check by omitting it
    code: z.string().trim().min(1).max(20).optional(),
  })
  .strict();

export type MarkAttendanceBody = z.infer<typeof markAttendanceBody>;
