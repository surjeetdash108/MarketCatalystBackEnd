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
/** A strong free model; overridable per environment via OPENROUTER_MODEL. */
const DEFAULT_MODEL = "deepseek/deepseek-chat-v3:free";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenRouterChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

@Injectable()
export class OpenRouterService {
  private readonly logger = new Logger(OpenRouterService.name);
  private readonly apiKey: string;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = String(this.config.get("OPENROUTER_API_KEY", "")).trim();
    this.model =
      String(this.config.get("OPENROUTER_MODEL", DEFAULT_MODEL)).trim() ||
      DEFAULT_MODEL;
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
    opts: { web?: boolean } = {},
  ): Promise<string | null> {
    if (!this.apiKey) return null;
    const model = opts.web ? `${this.model}:online` : this.model;
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
          max_tokens: 900,
          // Best-effort structured output; we still parse defensively because
          // free models don't reliably honour response_format.
          response_format: { type: "json_object" },
        }),
        // Keep the user-facing path snappy; :online web search can be slow.
        retries: 1,
        timeoutMs: opts.web ? 60_000 : 45_000,
      });
      const text = res?.choices?.[0]?.message?.content;
      return typeof text === "string" && text.trim() ? text : null;
    } catch (err) {
      this.logger.warn(
        `OpenRouter chat failed (${model}): ${(err as Error).message}`,
      );
      return null;
    }
  }
}
