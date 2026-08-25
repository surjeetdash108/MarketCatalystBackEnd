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
const DEFAULT_MODEL = "";
const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

/**
 * Preference order used when no GROQ_MODEL is configured.
 *
 * Model availability differs per ACCOUNT — llama-3.3-70b-versatile returned
 * "model_not_found" on this key even though it is a documented Groq model. So
 * rather than hard-code a name that may 404, the service asks the API which
 * models this key can actually use and picks the best match from the list
 * below. Anything unmatched falls back to the first non-audio model offered,
 * so a completely new line-up still works.
 *
 * Substring matching, most capable first. Instruct models are preferred over
 * reasoning ones: reasoning models spend their budget thinking and can return
 * an empty `content`, which this pipeline reads as "no reply".
 */
const MODEL_PREFERENCE = [
  "llama-3.3-70b",
  "llama-3.1-70b",
  "gpt-oss-120b",
  "qwen3-32b",
  "kimi-k2",
  "gpt-oss-20b",
  "llama-3.1-8b",
];
/** Never select these for text analysis. */
const MODEL_EXCLUDE = /whisper|tts|guard|vision|embed/i;

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
    return this.resolved ?? this.model ?? "(auto)";
  }

  private resolved: string | null = null;
  private resolving: Promise<string | null> | null = null;

  /**
   * The model to use, discovered once and cached for the process lifetime.
   * A configured GROQ_MODEL wins outright — discovery is only for when the
   * operator has not pinned one.
   */
  private async pickModel(): Promise<string | null> {
    if (this.model) return this.model;
    if (this.resolved) return this.resolved;
    if (this.resolving) return this.resolving;
    this.resolving = (async () => {
      try {
        const res = await fetchJson<{ data?: Array<{ id?: string }> }>(
          GROQ_MODELS_URL,
          {
            headers: { Authorization: `Bearer ${this.apiKey}` },
            retries: 0,
            timeoutMs: 8_000,
          },
        );
        const ids = (res?.data ?? [])
          .map((m) => String(m.id ?? ""))
          .filter((id) => id && !MODEL_EXCLUDE.test(id));
        if (!ids.length) return null;
        for (const want of MODEL_PREFERENCE) {
          const hit = ids.find((id) => id.includes(want));
          if (hit) {
            this.resolved = hit;
            this.logger.log(`Groq model resolved to ${hit}`);
            return hit;
          }
        }
        this.resolved = ids[0];
        this.logger.log(
          `Groq: no preferred model available, using ${ids[0]} (offered: ${ids.slice(0, 6).join(", ")})`,
        );
        return ids[0];
      } catch (err) {
        this.logger.warn(
          `Groq model discovery failed: ${(err as Error).message}`,
        );
        return null;
      } finally {
        this.resolving = null;
      }
    })();
    return this.resolving;
  }

  /** One completion. Returns the assistant text, or null on any failure. */
  async chat(
    messages: ChatMessage[],
    opts: { model?: string; timeoutMs?: number } = {},
  ): Promise<string | null> {
    if (!this.apiKey) return null;
    const model = opts.model?.trim() || (await this.pickModel());
    if (!model) {
      this.logger.warn("Groq: no usable model for this key");
      return null;
    }
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
