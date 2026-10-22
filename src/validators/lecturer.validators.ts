import { z } from "zod";
import { SESSION_LIMITS } from "../services/attendance/session-rules";
import { passwordField } from "./student-auth.validators";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const email = z.string().trim().toLowerCase().max(254).email("Enter a valid email address");
const passwordsMatch = (d: { password: string; confirmPassword: string }) => d.password === d.confirmPassword;
const mismatch = { path: ["confirmPassword"], message: "Passwords do not match" };
/** Multipart bodies arrive as strings: "true" / "false" become booleans. */
const bool = z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean().optional());
const httpsUrl = z.string().trim().max(500).url().refine((u) => u.startsWith("https://"), "Links must use https");

/* ---- auth ---- */
export const lecturerLoginSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();
export const lecturerActivateSchema = z.object({ token: z.string().trim().min(32).max(200), password: passwordField, confirmPassword: z.string() }).strict().refine(passwordsMatch, mismatch);
export const lecturerForgotSchema = z.object({ email }).strict();
export const lecturerResetSchema = lecturerActivateSchema;
export const lecturerChangePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), password: passwordField, confirmPassword: z.string() }).strict().refine(passwordsMatch, mismatch);

/* ---- profile: only the phone is editable. name / email / staffId / department / role are rejected with a 422 ---- */
export const lecturerProfileSchema = z
  .object({ phone: z.union([z.string().trim().transform((v) => v.replace(/[\s\-()]/g, "")).refine((v) => /^\+?\d{7,15}$/.test(v), "Enter a valid phone number"), z.literal("").transform(() => null), z.null()]) })
  .strict();

/* ---- params / queries ---- */
export const courseIdParams = z.object({ courseId: objectId }).strict();
export const materialIdParams = z.object({ materialId: objectId }).strict();
export const announcementIdParams = z.object({ announcementId: objectId }).strict();
export const assignmentIdParams = z.object({ assignmentId: objectId }).strict();
export const sessionIdParams = z.object({ sessionId: objectId }).strict();
export const notificationIdParams = z.object({ notificationId: objectId }).strict();
export const courseScopedQuery = z.object({ courseId: objectId.optional() }).strict();
export const studentsQuery = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50), search: z.string().trim().max(100).optional() }).strict();
export const lecturerNotificationsQuery = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(30), unread: z.enum(["true", "false"]).optional().transform((v) => v === "true") }).strict();

/* ---- official materials ---- */
export const createMaterialSchema = z.object({ title: z.string().trim().min(2).max(200), description: z.string().trim().max(2000).optional(), published: bool, fileUrl: httpsUrl.optional() }).strict();
export const updateMaterialSchema = z.object({ title: z.string().trim().min(2).max(200).optional(), description: z.string().trim().max(2000).optional(), published: z.boolean().optional() }).strict().refine((d) => Object.keys(d).length > 0, "Provide at least one field to update");

/* ---- announcements (course-scoped only: courseId must be one of the lecturer's assigned courses) ---- */
const priority = z.enum(["NORMAL", "IMPORTANT", "URGENT"]);
/** Announcements may arrive as multipart/form-data (to attach a picture): values are strings then, so empty values and booleans are normalised. */
const emptyToUndefined = (v: unknown) => (v === "" || v === "undefined" ? undefined : v);
const emptyToNull = (v: unknown) => (v === "" || v === "null" ? null : v);
export const createAnnouncementSchema = z.object({ courseId: objectId, title: z.string().trim().min(3).max(150), content: z.string().trim().min(3).max(10_000), priority: z.preprocess(emptyToUndefined, priority.optional()), published: bool, expiresAt: z.preprocess(emptyToUndefined, z.coerce.date().optional()) }).strict();
/** "At least one change" is checked in the service, because a picture alone arrives as a file rather than a body field. */
export const updateAnnouncementSchema = z.object({ title: z.string().trim().min(3).max(150).optional(), content: z.string().trim().min(3).max(10_000).optional(), priority: z.preprocess(emptyToUndefined, priority.optional()), published: bool, expiresAt: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()), removeImage: bool }).strict();

/* ---- assignments (no marks / grades fields exist in this phase) ---- */
export const createAssignmentSchema = z.object({ title: z.string().trim().min(3).max(200), description: z.string().trim().min(3).max(10_000), dueDate: z.coerce.date(), allowLateSubmission: bool, published: bool, fileUrl: httpsUrl.optional() }).strict();
export const updateAssignmentSchema = z.object({ title: z.string().trim().min(3).max(200).optional(), description: z.string().trim().min(3).max(10_000).optional(), dueDate: z.coerce.date().optional(), allowLateSubmission: z.boolean().optional(), published: z.boolean().optional(), fileUrl: httpsUrl.nullable().optional() }).strict().refine((d) => Object.keys(d).length > 0, "Provide at least one field to update");

/** GPS location + radius are mandatory and must be real numbers (strings are rejected). Everything else about the class comes from the assignment. */
export const createAttendanceSchema = z
  .object({
    title: z.string().trim().min(2).max(150).optional(),
    latitude: z.number({ required_error: "latitude is required" }).min(-90).max(90),
    longitude: z.number({ required_error: "longitude is required" }).min(-180).max(180),
    // Browser Geolocation `coords.accuracy` (metres). Required so the venue can't be set from a poor / guessed location; the service enforces the cap.
    accuracyMeters: z.number({ required_error: "accuracyMeters is required" }).min(0).max(100_000),
    allowedRadiusInMeters: z.number({ required_error: "allowedRadiusInMeters is required" }).min(SESSION_LIMITS.minRadius).max(SESSION_LIMITS.maxRadius),
    startTime: z.coerce.date().optional(),
    endTime: z.coerce.date().optional(),
    durationMinutes: z.number().int().min(1).max(SESSION_LIMITS.maxDurationHours * 60).optional(),
    lateAfterMinutes: z.number().int().min(0).max(SESSION_LIMITS.maxDurationHours * 60).optional(),
    code: z.string().trim().regex(/^[A-Za-z0-9]{3,12}$/, "The class code must be 3-12 letters or digits").optional(),
  })
  .strict();
export const openAttendanceSchema = z.object({ durationMinutes: z.number().int().min(1).max(180).optional() }).strict();
export const emptyBody = z.object({}).strict();

/* ---- complaints forwarded to the lecturer by the HOD (the lecturer id always comes from the token) ---- */
export const complaintIdParams = z.object({ complaintId: objectId }).strict();
export const lecturerComplaintsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(20), search: z.string().trim().max(100).optional(),
  status: z.enum(["ASSIGNED", "IN_PROGRESS", "UNDER_REVIEW", "RESOLVED", "REJECTED", "CLOSED"]).optional(),
  courseId: objectId.optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(),
  sort: z.enum(["createdAt", "updatedAt", "status", "referenceNumber"]).optional(), order: z.enum(["asc", "desc"]).optional(),
}).strict();
export const complaintRespondSchema = z.object({ message: z.string().trim().min(3).max(5000), visibleToStudent: z.boolean().optional() }).strict();
/** Only these two: resolving / rejecting / closing / forwarding are the HOD's decisions. */
export const complaintStatusSchema = z.object({ status: z.enum(["IN_PROGRESS", "UNDER_REVIEW"]), note: z.string().trim().min(3).max(2000).optional(), visibleToStudent: z.boolean().optional() }).strict();
