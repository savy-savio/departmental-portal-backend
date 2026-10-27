/**
 * Writing assistant for the student complaint form ("Improve with AI").
 *
 * - Stateless: nothing is saved and no complaint is touched. The student gets a suggestion and decides whether to use it
 *   (the UI promises "Nothing changes until you approve it").
 * - Student identity (name, matric number, level, department) and the date for a letter come from the authenticated student's record,
 *   never from the request and never from the model.
 */
import { env } from "../../config/env";
import { Course } from "../../models/Course";
import type { DepartmentDocument } from "../../models/Department";
import type { StudentDocument } from "../../models/Student";
import { AppError } from "../../utils/AppError";
import type { ComplaintAiInput } from "../../validators/complaint-ai.validators";
import { createAnthropicGenerator, type TextGenerator } from "./anthropic.client";
import { createGeminiGenerator } from "./gemini.client";
import {
  COMPLAINT_AI_ACTIONS, COMPLAINT_AI_ACTION_INFO, COMPLAINT_AI_MAX_CHARS, COMPLAINT_AI_MIN_CHARS, COMPLAINT_AI_TARGET,
  buildLetter, buildPrompt, finalizeMessage, finalizeSummary, finalizeTitle, formatLetterText,
} from "./complaint-ai.rules";

let generator: TextGenerator | null = null;

/** The assistant is optional: with no API key the endpoint answers 503 and the frontend hides the button (see complaintAiInfo). */
function getGenerator(): TextGenerator {
  if (!env.aiApiKey) {
    throw new AppError(503, "The AI assistant isn't available right now.", undefined, "AI_NOT_CONFIGURED");
  }
  const cfg = { apiKey: env.aiApiKey, model: env.aiModel, timeoutMs: env.AI_TIMEOUT_MS };
  generator ??= env.aiProvider === "gemini" ? createGeminiGenerator(cfg) : createAnthropicGenerator(cfg);
  return generator;
}

const letterDate = () =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: env.PORTAL_TIMEZONE }).format(new Date());

/** What the frontend needs to draw the AI Assistant dialog (cards, limits) and whether to show the button at all. */
export function complaintAiInfo() {
  return {
    available: env.aiConfigured,
    minMessageChars: COMPLAINT_AI_MIN_CHARS,
    maxMessageChars: COMPLAINT_AI_MAX_CHARS,
    actions: COMPLAINT_AI_ACTIONS.map((id) => ({ id, ...COMPLAINT_AI_ACTION_INFO[id], target: COMPLAINT_AI_TARGET[id] })),
  };
}

export async function assistComplaint(student: StudentDocument, department: DepartmentDocument, input: ComplaintAiInput) {
  const ai = getGenerator();
  const { action } = input;
  const target = COMPLAINT_AI_TARGET[action];

  // Optional context only: naming the course in a title or letter. Same scoping rule as complaints: a course of the student's own department.
  let course: { code: string; title: string } | undefined;
  if (input.courseId && (action === "DRAFT_LETTER" || action === "SUGGEST_TITLE")) {
    const found = await Course.findOne({ _id: input.courseId, department: department._id });
    if (!found) throw new AppError(404, "Course not found.");
    course = { code: found.courseCode, title: found.title };
  }

  const raw = await ai.generate(buildPrompt({ action, message: input.message, course }));

  if (action === "DRAFT_LETTER") {
    const letter = buildLetter(
      {
        dateText: letterDate(),
        student: { fullName: `${student.firstName} ${student.lastName}`, matricNumber: student.matricNumber, level: student.level },
        department: { name: department.name, faculty: department.faculty },
        fallbackSubject: input.title ?? "",
      },
      raw,
    );
    return {
      action,
      target,
      /** The whole letter as plain text: copy it, print it, or attach it. */
      result: formatLetterText(letter),
      /** Just the paragraphs, for putting into the complaint message field (the portal already knows who it is from and who it goes to). */
      body: letter.paragraphs.join("\n\n"),
      letter,
    };
  }
  if (action === "SUGGEST_TITLE") return { action, target, result: finalizeTitle(raw) };
  if (action === "SUMMARIZE") return { action, target, result: finalizeSummary(raw) };
  return { action, target, result: finalizeMessage(raw) };
}
