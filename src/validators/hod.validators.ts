import { z } from "zod";
import { DAYS_OF_WEEK, ELECTORATE_MODES, MAX_ELECTION_GROUP_SIZE, SEMESTERS } from "../utils/constants";
import { passwordField } from "./student-auth.validators";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const email = z.string().trim().toLowerCase().max(254).email("Enter a valid email address");
const passwordsMatch = (d: { password: string; confirmPassword: string }) => d.password === d.confirmPassword;
const mismatch = { path: ["confirmPassword"], message: "Passwords do not match" };
const phone = z.string().trim().transform((v) => v.replace(/[\s\-()]/g, "")).refine((v) => /^\+?\d{7,15}$/.test(v), "Enter a valid phone number");
const bool = z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean().optional());
const httpsUrl = z.string().trim().max(500).url().refine((u) => u.startsWith("https://"), "Links must use https");
const level = z.string().regex(/^[1-9]\d{2}$/, 'Level must look like "100"');
const session = z.string().regex(/^\d{4}\/\d{4}$/, "Use 2026/2027");
const priority = z.enum(["NORMAL", "IMPORTANT", "URGENT"]);
const nonEmpty = (d: object) => Object.keys(d).length > 0;
const noneMsg = "Provide at least one field to update";

/* ---- list queries (server-side pagination everywhere; limit capped at 100) ---- */
const base = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), search: z.string().trim().max(100).optional(), order: z.enum(["asc", "desc"]).optional() };
const date = z.coerce.date();
export const studentsQuery = z.object({ ...base, level: level.optional(), academicSession: session.optional(), status: z.enum(["ACTIVE", "SUSPENDED", "PENDING_ONBOARDING"]).optional(), sort: z.enum(["lastName", "firstName", "matricNumber", "level", "createdAt", "status"]).optional() }).strict();
export const lecturersQuery = z.object({ ...base, status: z.enum(["INVITED", "ACTIVE", "SUSPENDED"]).optional(), sort: z.enum(["lastName", "firstName", "staffId", "status", "createdAt"]).optional() }).strict();
export const coursesQuery = z.object({ ...base, level: level.optional(), semester: z.enum(SEMESTERS).optional(), academicSession: session.optional(), status: z.enum(["ACTIVE", "ARCHIVED"]).optional(), sort: z.enum(["courseCode", "title", "level", "units", "createdAt", "status"]).optional() }).strict();
export const representativesQuery = z.object({ ...base, courseId: objectId.optional(), level: level.optional(), academicSession: session.optional(), semester: z.enum(SEMESTERS).optional(), role: z.enum(["COURSE_REP", "ASSISTANT_COURSE_REP"]).optional(), status: z.enum(["ACTIVE", "INACTIVE", "REVOKED"]).optional(), sort: z.enum(["assignedAt", "courseCode", "role", "status", "level"]).optional() }).strict();
export const timetableQuery = z.object({ ...base, courseId: objectId.optional(), level: level.optional(), day: z.enum(DAYS_OF_WEEK).optional(), source: z.enum(["OFFICIAL", "CLASS_REP"]).optional() }).strict();
export const announcementsQuery = z.object({ ...base, status: z.enum(["DRAFT", "PUBLISHED", "UNPUBLISHED"]).optional(), scope: z.enum(["DEPARTMENT", "LEVEL", "COURSE"]).optional(), mine: z.enum(["true", "false"]).optional().transform((v) => v === "true"), sort: z.enum(["createdAt", "publishedAt", "title", "priority"]).optional() }).strict();
export const documentsQuery = z.object({ ...base, status: z.enum(["PUBLISHED", "HIDDEN"]).optional(), sort: z.enum(["createdAt", "title"]).optional() }).strict();
export const materialsQuery = z.object({ ...base, type: z.enum(["OFFICIAL_COURSE_MATERIAL", "CLASS_RESOURCE"]).optional(), courseCode: z.string().trim().max(12).optional() }).strict();
export const attendanceQuery = z.object({ ...base, courseId: objectId.optional(), lecturerId: objectId.optional(), state: z.enum(["UPCOMING", "OPEN", "CLOSED"]).optional(), from: date.optional(), to: date.optional() }).strict();
export const complaintsQuery = z.object({
  ...base, status: z.enum(["SUBMITTED", "PENDING", "UNDER_REVIEW", "ASSIGNED", "IN_PROGRESS", "RESOLVED", "REJECTED", "CLOSED"]).optional(), type: z.enum(["COURSE", "HOD"]).optional(),
  courseId: objectId.optional(), assignedLecturerId: objectId.optional(), from: date.optional(), to: date.optional(), sort: z.enum(["createdAt", "updatedAt", "status", "referenceNumber"]).optional(),
}).strict();
export const notificationsQuery = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(30), unread: z.enum(["true", "false"]).optional().transform((v) => v === "true") }).strict();

/* ---- params ---- */
export const studentIdParams = z.object({ studentId: objectId }).strict();
export const lecturerIdParams = z.object({ lecturerId: objectId }).strict();
export const lecturerCourseParams = z.object({ lecturerId: objectId, courseId: objectId }).strict();
export const courseIdParams = z.object({ courseId: objectId }).strict();
export const assignmentIdParams = z.object({ assignmentId: objectId }).strict();
export const announcementIdParams = z.object({ announcementId: objectId }).strict();
export const documentIdParams = z.object({ documentId: objectId }).strict();
export const sessionIdParams = z.object({ sessionId: objectId }).strict();
export const complaintIdParams = z.object({ complaintId: objectId }).strict();
export const notificationIdParams = z.object({ notificationId: objectId }).strict();

/* ---- auth / profile ---- */
export const hodLoginSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();
export const hodActivateSchema = z.object({ token: z.string().trim().min(32).max(200), password: passwordField, confirmPassword: z.string() }).strict().refine(passwordsMatch, mismatch);
export const hodForgotSchema = z.object({ email }).strict();
export const hodResetSchema = hodActivateSchema;
export const hodChangePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), password: passwordField, confirmPassword: z.string() }).strict().refine(passwordsMatch, mismatch);
/** The only editable profile field is the phone. Role, department, staff id and email are rejected with a 422. */
export const hodProfileSchema = z.object({ phone: z.union([phone, z.literal("").transform(() => null), z.null()]) }).strict();

/* ---- department ---- */
export const departmentSettingsSchema = z
  .object({
    name: z.string().trim().min(3).max(120).optional(),
    faculty: z.string().trim().min(2).max(120).optional(),
    contact: z.object({ email: email.optional(), phone: phone.optional(), office: z.string().trim().max(120).optional() }).strict().optional(),
    levels: z.array(level).min(1).max(10).optional(),
  })
  .strict()
  .refine(nonEmpty, noneMsg);
export const academicTermSchema = z.object({ academicSession: session, semester: z.enum(SEMESTERS), confirm: z.boolean() }).strict();
export const registrationSchema = z
  .object({ registrationOpen: z.boolean().optional(), registrationOpensAt: z.coerce.date().nullable().optional(), registrationClosesAt: z.coerce.date().nullable().optional(), maxUnits: z.number().int().min(1).max(60).optional() })
  .strict()
  .refine(nonEmpty, noneMsg);

/* ---- students ---- */
export const studentStatusSchema = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) }).strict();
export const academicRecordSchema = z.object({ level: level.optional(), academicSession: session.optional() }).strict().refine(nonEmpty, noneMsg);
export const bulkAcademicRecordSchema = z.object({ studentIds: z.array(objectId).min(1).max(500), level: level.optional(), academicSession: session.optional() }).strict().refine((d) => Boolean(d.level || d.academicSession), "Provide a level or an academicSession");

/* ---- lecturers ---- */
export const createLecturerSchema = z.object({ firstName: z.string().trim().min(1).max(60), lastName: z.string().trim().min(1).max(60), email, phone: phone.optional(), staffId: z.string().trim().min(2).max(30) }).strict();
export const updateLecturerSchema = z.object({ firstName: z.string().trim().min(1).max(60).optional(), lastName: z.string().trim().min(1).max(60).optional(), phone: z.union([phone, z.literal("").transform(() => null), z.null()]).optional() }).strict().refine(nonEmpty, noneMsg);
export const lecturerStatusSchema = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) }).strict();
export const assignLecturerCourseSchema = z.object({ courseId: objectId }).strict();

/* ---- courses ---- */
const units = z.number().min(0).max(12);
export const createCourseSchema = z.object({ courseCode: z.string().trim().min(5).max(12), title: z.string().trim().min(2).max(200), description: z.string().trim().max(2000).optional(), units, level, semester: z.enum(SEMESTERS), academicSession: session.optional() }).strict();
export const updateCourseSchema = z.object({ title: z.string().trim().min(2).max(200).optional(), description: z.string().trim().max(2000).optional(), units: units.optional(), level: level.optional(), semester: z.enum(SEMESTERS).optional() }).strict().refine(nonEmpty, noneMsg);
export const courseStatusSchema = z.object({ status: z.enum(["ACTIVE", "ARCHIVED"]) }).strict();

/* ---- representatives ---- */
/** A representative is appointed for a LEVEL (not a course): the term is always the department's current one. */
export const appointRepSchema = z.object({ studentId: objectId, level, role: z.enum(["COURSE_REP", "ASSISTANT_COURSE_REP"]) }).strict();
export const repStatusSchema = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) }).strict();

/* ---- announcements / documents ---- */
/** Announcements may be sent as multipart/form-data (to attach a picture): every value then arrives as a string, so empty values and booleans are normalised. */
const emptyToUndefined = (v: unknown) => (v === "" || v === "undefined" ? undefined : v);
const emptyToNull = (v: unknown) => (v === "" || v === "null" ? null : v);
const levelList = z.preprocess((v) => (typeof v === "string" ? (v === "" ? undefined : v.split(",").map((x) => x.trim()).filter(Boolean)) : v), z.array(level).max(10).optional());
export const createAnnouncementSchema = z.object({ title: z.string().trim().min(3).max(150), content: z.string().trim().min(3).max(10_000), priority: z.preprocess(emptyToUndefined, priority.optional()), published: bool, levels: levelList, expiresAt: z.preprocess(emptyToUndefined, z.coerce.date().optional()) }).strict();
/** "At least one change" is checked in the service, because a picture alone arrives as a file rather than a body field. */
export const updateAnnouncementSchema = z.object({ title: z.string().trim().min(3).max(150).optional(), content: z.string().trim().min(3).max(10_000).optional(), priority: z.preprocess(emptyToUndefined, priority.optional()), published: bool, levels: levelList, expiresAt: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()), removeImage: bool }).strict();
/** Multipart (file) or JSON (fileUrl): multipart values arrive as strings, hence the preprocessors. */
export const createDocumentSchema = z.object({
  title: z.string().trim().min(2).max(200), description: z.string().trim().max(2000).optional(), published: bool, fileUrl: httpsUrl.optional(),
  levels: z.preprocess((v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v), z.array(level).max(10).optional()),
}).strict();
export const updateDocumentSchema = z.object({ title: z.string().trim().min(2).max(200).optional(), description: z.string().trim().max(2000).optional(), published: z.boolean().optional(), levels: z.array(level).max(10).optional() }).strict().refine(nonEmpty, noneMsg);

/* ---- complaints ---- */
export const complaintStatusSchema = z.object({ status: z.enum(["UNDER_REVIEW", "IN_PROGRESS", "RESOLVED", "REJECTED", "CLOSED"]), note: z.string().trim().min(3).max(2000).optional(), resolution: z.string().trim().min(3).max(5000).optional() }).strict();
export const complaintAssignSchema = z.object({ lecturerId: objectId, note: z.string().trim().max(2000).optional() }).strict();
export const complaintRespondSchema = z.object({ message: z.string().trim().min(3).max(5000) }).strict();
export const emptyBody = z.object({}).strict();

/* ---- elections ---- */
export const electionIdParams = z.object({ electionId: objectId }).strict();
export const electionPositionParams = z.object({ electionId: objectId, positionId: objectId }).strict();
export const electionCandidateParams = z.object({ electionId: objectId, candidateId: objectId }).strict();
const lifecycle = z.enum(["DRAFT", "SCHEDULED", "ACTIVE", "CLOSED", "CANCELLED"]);
export const electionsQuery = z.object({ ...base, status: lifecycle.optional(), sort: z.enum(["votingOpensAt", "title"]).optional() }).strict()
  .transform(({ status, ...rest }) => ({ ...rest, lifecycle: status }));
export const electionStudentSearchQuery = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(20), search: z.string().trim().min(1).max(100).optional(), level: level.optional() }).strict();
export const electionGroupQuery = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
export const electionCandidatesQuery = z.object({ positionId: objectId.optional() }).strict();

/** Who can vote. DEPARTMENT: everyone; LEVELS: students of the listed levels (a class); GROUP: an explicit list of students. */
const electorateSchema = z.object({
  mode: z.enum(ELECTORATE_MODES),
  levels: z.array(level).max(10).optional(),
  studentIds: z.array(objectId).max(MAX_ELECTION_GROUP_SIZE).optional(),
}).strict();
const electionTitle = z.string().trim().min(3).max(200);
const electionDescription = z.string().trim().max(3000);
export const createElectionSchema = z.object({
  title: electionTitle, description: electionDescription.optional(), academicSession: session.optional(),
  votingOpensAt: z.coerce.date(), votingClosesAt: z.coerce.date(), electorate: electorateSchema.optional(),
}).strict();
export const updateElectionSchema = z.object({
  title: electionTitle.optional(), description: z.union([electionDescription, z.literal("").transform(() => null), z.null()]).optional(), academicSession: session.optional(),
  votingOpensAt: z.coerce.date().optional(), votingClosesAt: z.coerce.date().optional(), electorate: electorateSchema.optional(),
}).strict().refine(nonEmpty, noneMsg);
export const electionResultsSchema = z.object({ published: z.boolean() }).strict();

export const createPositionSchema = z.object({ title: z.string().trim().min(2).max(120), description: z.string().trim().max(1000).optional() }).strict();
export const updatePositionSchema = z.object({ title: z.string().trim().min(2).max(120).optional(), description: z.union([z.string().trim().max(1000), z.literal("").transform(() => null), z.null()]).optional() }).strict().refine(nonEmpty, noneMsg);
export const reorderPositionsSchema = z.object({ positionIds: z.array(objectId).min(1).max(50) }).strict();

const manifesto = z.string().trim().max(3000);
/** JSON or multipart (with an optional "photo" file): multipart values arrive as strings, hence the boolean preprocessor. */
export const addCandidateSchema = z.object({ positionId: objectId, studentId: objectId, manifesto: manifesto.optional(), approve: bool }).strict();
export const updateCandidateSchema = z.object({ manifesto: z.union([manifesto, z.literal("").transform(() => null), z.null()]) }).strict();
export const candidateDecisionSchema = z.object({ decision: z.enum(["APPROVED", "REJECTED"]) }).strict();
