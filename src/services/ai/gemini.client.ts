/**
 * Minimal client for the Google Gemini API (Google AI Studio key, which has a free tier), using Node's built-in fetch.
 * Implements the same `TextGenerator` contract as anthropic.client.ts, so the rest of the feature does not care which provider is used.
 *
 * Privacy: complaint text is personal. It is sent to the provider (that is the feature) but NEVER logged here: only HTTP status codes
 * and the provider's error status are logged. Note that Google may use free-tier traffic to improve its products; see the README.
 */
import { AppError } from "../../utils/AppError";
import { logger } from "../../utils/logger";
import type { TextGenerator } from "./anthropic.client";

export interface GeminiConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

const unavailable = () => new AppError(503, "The AI assistant is unavailable right now. Please try again shortly.", undefined, "AI_UNAVAILABLE");
const busy = () => new AppError(503, "The AI assistant is busy right now. Please try again in a moment.", undefined, "AI_BUSY");

interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

// Reasons Gemini gives when it declines to produce (or finish) a reply for safety or policy reasons.
const REFUSAL_REASONS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "LANGUAGE"]);

/** Gemini 2.5 Flash models "think" by default and thinking tokens count against maxOutputTokens, which would cut replies short. Turn it off where allowed. */
const canDisableThinking = (model: string) => /^gemini-2\.5-flash/.test(model);

export function createGeminiGenerator(cfg: GeminiConfig): TextGenerator {
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = (cfg.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  const url = `${base}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;

  return {
    async generate({ system, user, maxTokens }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      const generationConfig: Record<string, unknown> = { maxOutputTokens: maxTokens };
      if (canDisableThinking(cfg.model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          // The key travels in a header, never in the URL, so it can't leak into logs or error messages.
          headers: { "content-type": "application/json", "x-goog-api-key": cfg.apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new AppError(504, "The AI assistant took too long to respond. Please try again.", undefined, "AI_TIMEOUT");
        }
        logger.warn("AI request failed:", err instanceof Error ? err.name : "unknown error");
        throw unavailable();
      } finally {
        clearTimeout(timer);
      }

      let data: GenerateContentResponse | undefined;
      try {
        data = (await res.json()) as GenerateContentResponse;
      } catch {
        data = undefined;
      }

      if (!res.ok) {
        const status = data?.error?.status ?? "unknown";
        if (res.status === 429 || res.status >= 500) {
          // 429 RESOURCE_EXHAUSTED = free-tier rate limit or daily quota reached.
          logger.warn(`AI provider busy (HTTP ${res.status}, ${status})`);
          throw busy();
        }
        // Gemini answers 400 for a bad API key as well as for a bad model name or request, and 403/404 for a key without access or an unknown model.
        logger.error(
          `AI provider rejected the request (HTTP ${res.status}, ${status}). Check GEMINI_API_KEY and AI_MODEL: ${(data?.error?.message ?? "").slice(0, 200)}`,
        );
        throw unavailable();
      }

      if (!data || typeof data !== "object") {
        logger.error("AI provider returned an unreadable response");
        throw new AppError(502, "The AI assistant returned an unreadable response. Please try again.", undefined, "AI_BAD_RESPONSE");
      }
      if (data.promptFeedback?.blockReason) {
        throw new AppError(422, "The AI assistant couldn't work with this text. Try rewording it.", undefined, "AI_REFUSED");
      }
      const candidate = data.candidates?.[0];
      if (!candidate) {
        logger.error("AI provider returned no candidates");
        throw new AppError(502, "The AI assistant returned an unreadable response. Please try again.", undefined, "AI_BAD_RESPONSE");
      }
      if (candidate.finishReason && REFUSAL_REASONS.has(candidate.finishReason)) {
        throw new AppError(422, "The AI assistant couldn't work with this text. Try rewording it.", undefined, "AI_REFUSED");
      }
      if (candidate.finishReason === "MAX_TOKENS") {
        // A cut-off reply would silently drop the end of the student's complaint, so refuse it rather than hand it back.
        throw new AppError(502, "The assistant's reply was cut off. Please try again.", undefined, "AI_TRUNCATED");
      }
      const parts = candidate.content?.parts;
      if (!Array.isArray(parts)) {
        logger.error("AI provider returned a reply with no content");
        throw new AppError(502, "The AI assistant returned an unreadable response. Please try again.", undefined, "AI_BAD_RESPONSE");
      }
      return parts
        .filter((p) => !p.thought && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("");
    },
  };
}
