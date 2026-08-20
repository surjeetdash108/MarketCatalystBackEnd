import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fetchJson } from "../../common/http.util";

/**
 * OpenRouter — the single LLM gateway for MarketCatalyst's AI features. One
 * account key reaches many models (including free ones), so the model is chosen
 * by the OPENROUTER_MODEL env var rather than hard-coded.
 *
 * Mirrors the FMP vendor pattern: the key is read from ConfigService, `enabled`
 * gates callers, and a missing key makes every method a silent no-op (returns
 * null) instead of crashing — so a stack deployed without the key just shows the
 * non-AI views.
 *
 * Auth is a Bearer header (unlike the ?apikey= query-param vendors), so the key
 * never lands in a URL/log. Web search: passing { web: true } appends `:online`
 * to the model id, which runs OpenRouter's web-search plugin so the model itself
 * fetches recent results — used as the news fallback when Polygon+FMP are empty.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
/**
 * A free instruction-tuned model; overridable per environment via
 * OPENROUTER_MODEL. Prefer a plain "-it"/instruct model over a *reasoning*
 * model here: reasoning models spend the token budget on thinking and can come
 * back with an empty `message.content`. OpenRouter also retires free slugs
 * without notice (the previous default, deepseek-chat-v3:free, started 404ing
 * with "unavailable for free") — check https://openrouter.ai/api/v1/models for
 * entries priced at 0 before changing this.
 */
const DEFAULT_MODEL = "openrouter/free";
/**
 * Tried only if the primary returns nothing parseable. Override with
 * OPENROUTER_FALLBACK_MODEL. Must be a capable INSTRUCT model — a small one
 * (nemotron-3-nano-30b-a3b, ~3B active) parsed fine but returned a half-filled
 * object: headline only, no momentum/news/setup. Gemma-4-31b-it fills the whole
 * schema.
 */
const DEFAULT_FALLBACK_MODEL = "google/gemma-4-31b-it:free";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenRouterChatResponse {
  choices?: Array<{
    finish_reason?: string;
    // Reasoning models leave `content` empty and put the text in `reasoning`.
    message?: { content?: string; reasoning?: string };
  }>;
  error?: { message?: string };
}

@Injectable()
export class OpenRouterService {
  private readonly logger = new Logger(OpenRouterService.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fallbackModel: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = String(this.config.get("OPENROUTER_API_KEY", "")).trim();
    this.model =
      String(this.config.get("OPENROUTER_MODEL", DEFAULT_MODEL)).trim() ||
      DEFAULT_MODEL;
    // Second-chance model, tried only when the primary produces nothing usable.
    // Deliberately a different family from the primary so a provider-side
    // outage or a bad auto-route doesn't take both attempts down together.
    this.fallbackModel =
      String(
        this.config.get("OPENROUTER_FALLBACK_MODEL", DEFAULT_FALLBACK_MODEL),
      ).trim() || DEFAULT_FALLBACK_MODEL;
    if (!this.apiKey) {
      this.logger.warn(
        "OPENROUTER_API_KEY not set — AI features stay disabled (endpoints return an ai-disabled result). Set the key to enable.",
      );
    }
  }

  /** True once a key is present — callers should skip work when disabled. */
  get enabled(): boolean {
    return !!this.apiKey;
  }

  /** The model id in use (for stamping onto AI-analysis docs / UI). */
  get modelName(): string {
    return this.model;
  }

  /** The second-chance model id, tried when the primary yields no usable JSON. */
  get fallbackModelName(): string {
    return this.fallbackModel;
  }

  /**
   * One chat completion. Returns the raw assistant string, or null when the
   * vendor is disabled or the call fails (best-effort — never throws to the
   * caller, so a hung/failed LLM degrades to "AI unavailable" rather than an
   * error page).
   *
   * @param opts.web append `:online` so the model runs OpenRouter's web-search
   *   plugin itself (news fallback when we have no first-party articles).
   */
  async chat(
    messages: ChatMessage[],
    opts: { web?: boolean; model?: string; timeoutMs?: number } = {},
  ): Promise<string | null> {
    if (!this.apiKey) return null;
    const base = opts.model?.trim() || this.model;
    const model = opts.web ? `${base}:online` : base;
    try {
      const res = await fetchJson<OpenRouterChatResponse>(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          // OpenRouter attribution headers (optional, recommended).
          "HTTP-Referer": "https://marketcatalyst.web.app",
          "X-Title": "MarketCatalyst",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.3,
          // Generous enough that a reasoning model still has budget left for the
          // answer after its thinking tokens — an exhausted budget returns an
          // empty `content` and the read silently degrades to "unavailable".
          // The answer itself is ~200 tokens; the rest is thinking headroom.
          max_tokens: 4000,
          // Best-effort structured output; we still parse defensively because
          // free models don't reliably honour response_format.
          response_format: { type: "json_object" },
        }),
        // HARD CONSTRAINT: this route is reached through a Firebase Hosting
        // rewrite, which kills the request at 60s and hands the browser a 503
        // that never reaches our error handling. So the WHOLE call — every
        // attempt — must finish inside that window. retries:1 at 45s each was
        // ~90s worst case and did exactly that on a slow upstream. One attempt,
        // generous budget: a failure caches briefly and the next view retries.
        retries: 0,
        // Budget is per attempt, and the caller may make TWO (primary then
        // fallback), so both together must still clear Hosting's 60s cutoff.
        // Caller may tighten this: the whole request also pays a COLD START
        // (this service scales to zero), and that boot time counts against
        // Hosting's 60s just like the LLM does.
        timeoutMs: opts.timeoutMs ?? (opts.web ? 26_000 : 22_000),
      });
      const choice = res?.choices?.[0];
      // Prefer `content`; fall back to `reasoning` so a reasoning model that
      // emitted its JSON as "thinking" still yields a usable read.
      const text = choice?.message?.content?.trim()
        ? choice.message.content
        : choice?.message?.reasoning;
      if (typeof text === "string" && text.trim()) return text;
      // Empty completion: a 200 with nothing usable. Log enough to tell a
      // retired/incompatible model apart from a truncated one without having to
      // redeploy for diagnostics. The key is header-only, so nothing leaks here.
      this.logger.warn(
        `OpenRouter returned an empty completion (${model}): finish_reason=${
          choice?.finish_reason ?? "n/a"
        } error=${res?.error?.message ?? "none"} choices=${
          res?.choices?.length ?? 0
        }`,
      );
      return null;
    } catch (err) {
      this.logger.warn(
        `OpenRouter chat failed (${model}): ${(err as Error).message}`,
      );
      return null;
    }
  }
}
