import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fetchJson } from "../../common/http.util";
import type { ChatMessage } from "../openrouter/openrouter.service";

/**
 * Groq — the PRIMARY LLM gateway.
 *
 * Chosen as primary over OpenRouter because OpenRouter's free tier allows 50
 * model requests per DAY, which this pipeline exhausts almost immediately.
 * Groq's free tier is rate-limited per minute rather than per day, so it can
 * actually sustain on-demand generation.
 *
 * The API is OpenAI-compatible, so this mirrors OpenRouterService exactly:
 * key from ConfigService, `enabled` gates callers, and every failure returns
 * null rather than throwing — a dead model degrades to "analysis unavailable",
 * never to an error page.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
/**
 * Overridable via GROQ_MODEL. Prefer an INSTRUCT model: reasoning models spend
 * their token budget thinking and can return an empty `content`, which is the
 * exact failure this pipeline treats as "no reply".
 */
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

interface GroqChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string; reasoning?: string };
  }>;
  error?: { message?: string };
}

@Injectable()
export class GroqService {
  private readonly logger = new Logger(GroqService.name);
  private readonly apiKey: string;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = String(this.config.get("GROQ_API_KEY", "")).trim();
    this.model =
      String(this.config.get("GROQ_MODEL", DEFAULT_MODEL)).trim() ||
      DEFAULT_MODEL;
    if (!this.apiKey) {
      this.logger.warn(
        "GROQ_API_KEY not set — Groq is disabled and the LLM gateway will fall back to OpenRouter.",
      );
    }
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  get modelName(): string {
    return this.model;
  }

  /** One completion. Returns the assistant text, or null on any failure. */
  async chat(
    messages: ChatMessage[],
    opts: { model?: string; timeoutMs?: number } = {},
  ): Promise<string | null> {
    if (!this.apiKey) return null;
    const model = opts.model?.trim() || this.model;
    try {
      const res = await fetchJson<GroqChatResponse>(GROQ_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.3,
          max_tokens: 4000,
          response_format: { type: "json_object" },
        }),
        // One attempt. The caller falls back to OpenRouter, so retrying here
        // only delays that.
        retries: 0,
        timeoutMs: opts.timeoutMs ?? 25_000,
      });
      const choice = res?.choices?.[0];
      const text = choice?.message?.content?.trim()
        ? choice.message.content
        : choice?.message?.reasoning;
      if (typeof text === "string" && text.trim()) return text;
      this.logger.warn(
        `Groq returned an empty completion (${model}): finish_reason=${
          choice?.finish_reason ?? "n/a"
        } error=${res?.error?.message ?? "none"}`,
      );
      return null;
    } catch (err) {
      this.logger.warn(`Groq chat failed (${model}): ${(err as Error).message}`);
      return null;
    }
  }
}
