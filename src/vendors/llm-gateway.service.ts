import { Injectable, Logger } from "@nestjs/common";
import { GroqService } from "./groq/groq.service";
import {
  OpenRouterService,
  type ChatMessage,
} from "./openrouter/openrouter.service";

/**
 * Single entry point for LLM calls: Groq first, OpenRouter as fallback.
 *
 * WHY GROQ IS PRIMARY
 * OpenRouter's free tier allows 50 model requests per DAY. This pipeline
 * exhausted it within the first cycles of each day, after which every
 * analysis failed with a 429. Groq's free tier limits per minute rather than
 * per day, so it can sustain on-demand generation; OpenRouter is kept as the
 * safety net for when Groq is unconfigured, rate-limited, or returns nothing
 * usable.
 *
 * "Nothing usable" deliberately includes an EMPTY reply, not just an error —
 * a model that returns 200 with blank content is as useless to the caller as
 * one that throws, and the whole point of a fallback is to try someone else.
 */
@Injectable()
export class LlmGatewayService {
  private readonly logger = new Logger(LlmGatewayService.name);

  constructor(
    private readonly groq: GroqService,
    private readonly openrouter: OpenRouterService,
  ) {}

  /** True when at least one provider can serve a call. */
  get enabled(): boolean {
    return this.groq.enabled || this.openrouter.enabled;
  }

  /** Which provider a call would try first — for stamping onto stored docs. */
  get primaryName(): string {
    return this.groq.enabled ? `groq:${this.groq.modelName}` : `openrouter:${this.openrouter.modelName}`;
  }

  /**
   * @param opts.timeoutMs budget PER PROVIDER. A caller behind the Firebase
   *   Hosting rewrite must keep the total (both attempts) under 60s.
   */
  async chat(
    messages: ChatMessage[],
    opts: { timeoutMs?: number } = {},
  ): Promise<string | null> {
    if (this.groq.enabled) {
      const out = await this.groq.chat(messages, { timeoutMs: opts.timeoutMs });
      if (out?.trim()) return out;
      this.logger.warn("Groq returned nothing usable — falling back to OpenRouter");
    }
    if (!this.openrouter.enabled) return null;
    return this.openrouter.chat(messages, { timeoutMs: opts.timeoutMs });
  }
}
