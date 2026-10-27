/**
 * Minimal client for the Anthropic Messages API (https://docs.anthropic.com), using Node's built-in fetch, so there is no extra dependency.
 *
 * Config is passed in (not read from env) so the client can be tested with a fake fetch, and so swapping to another provider later means
 * writing one more `TextGenerator` and changing one line in complaint-ai.service.ts.
 *
 * Privacy: complaint text is personal. It is sent to the provider (that is the feature) but NEVER logged here: only HTTP status codes
 * and the provider's error type are logged.
 */
import { AppError } from "../../utils/AppError";
import { logger } from "../../utils/logger";

export interface GenerateRequest {
  system: string;
  user: string;
  maxTokens: number;
}
export interface TextGenerator {
  generate(req: GenerateRequest): Promise<string>;
}
export interface AnthropicConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

const API_VERSION = "2023-06-01";

const unavailable = () => new AppError(503, "The AI assistant is unavailable right now. Please try again shortly.", undefined, "AI_UNAVAILABLE");
const busy = () => new AppError(503, "The AI assistant is busy right now. Please try again in a moment.", undefined, "AI_BUSY");

interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  error?: { type?: string; message?: string };
}

export function createAnthropicGenerator(cfg: AnthropicConfig): TextGenerator {
  const doFetch = cfg.fetchImpl ?? fetch;
  const url = `${(cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`;

  return {
    async generate({ system, user, maxTokens }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": API_VERSION },
          body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
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

      let data: MessagesResponse | undefined;
      try {
        data = (await res.json()) as MessagesResponse;
      } catch {
        data = undefined;
      }

      if (!res.ok) {
        const type = data?.error?.type ?? "unknown";
        if (res.status === 401 || res.status === 403) {
          logger.error(`AI provider rejected the API key (HTTP ${res.status}). Check ANTHROPIC_API_KEY and AI_MODEL.`);
          throw unavailable();
        }
        if (res.status === 429 || res.status === 529 || res.status >= 500) {
          logger.warn(`AI provider busy (HTTP ${res.status}, ${type})`);
          throw busy();
        }
        // 400 / 404: our request is wrong (for instance AI_MODEL is not a real model name). The provider's message describes the request, not the complaint.
        logger.error(`AI provider rejected the request (HTTP ${res.status}, ${type}): ${(data?.error?.message ?? "").slice(0, 200)}`);
        throw unavailable();
      }

      if (!data || !Array.isArray(data.content)) {
        logger.error("AI provider returned an unreadable response");
        throw new AppError(502, "The AI assistant returned an unreadable response. Please try again.", undefined, "AI_BAD_RESPONSE");
      }
      if (data.stop_reason === "refusal") {
        throw new AppError(422, "The AI assistant couldn't work with this text. Try rewording it.", undefined, "AI_REFUSED");
      }
      if (data.stop_reason === "max_tokens") {
        // A cut-off reply would silently drop the end of the student's complaint, so refuse it rather than hand it back.
        throw new AppError(502, "The assistant's reply was cut off. Please try again.", undefined, "AI_TRUNCATED");
      }
      return data.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
    },
  };
}
