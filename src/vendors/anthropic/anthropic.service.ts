import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Anthropic Claude API Gateway.
 *
 * Sourced via ANTHROPIC_API_KEY.
 * Sends requests to https://api.anthropic.com/v1/messages.
 * If Anthropic is rate-limited, low on credits, or unavailable,
 * callers can gracefully fall back to LlmGatewayService.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-3-7-sonnet-20250219";
const FALLBACK_MODEL = "claude-3-5-sonnet-20241022";

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicMessagesResponse {
  id?: string;
  type?: string;
  role?: string;
  content?: AnthropicContentBlock[];
  error?: {
    type?: string;
    message?: string;
  };
}

@Injectable()
export class AnthropicService {
  private readonly logger = new Logger(AnthropicService.name);

  constructor(private readonly config: ConfigService) {}

  get apiKey(): string {
    return (this.config.get<string>("ANTHROPIC_API_KEY") ?? "").trim();
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  get modelName(): string {
    return (
      this.config.get<string>("ANTHROPIC_MODEL")?.trim() || DEFAULT_MODEL
    );
  }

  /**
   * Invokes Claude Messages API.
   * Returns text response or null on error.
   */
  async generateMessage(
    systemPrompt: string,
    userPrompt: string,
    opts: {
      model?: string;
      maxTokens?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<string | null> {
    if (!this.enabled) {
      this.logger.warn("Anthropic API key is not configured.");
      return null;
    }

    const model = opts.model || this.modelName;
    const maxTokens = opts.maxTokens ?? 4096;
    const timeoutMs = opts.timeoutMs ?? 120_000;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
        signal: controller.signal,
      });

      const data = (await res.json()) as AnthropicMessagesResponse;

      if (!res.ok || data.error) {
        const errorMsg = data.error?.message || `HTTP ${res.status} ${res.statusText}`;
        this.logger.warn(`Anthropic request failed (${model}): ${errorMsg}`);

        // If primary model was rejected, try fallback model if not tried already
        if (model === DEFAULT_MODEL && (res.status === 404 || res.status === 400)) {
          this.logger.log(`Retrying with fallback Anthropic model ${FALLBACK_MODEL}...`);
          return this.generateMessage(systemPrompt, userPrompt, {
            ...opts,
            model: FALLBACK_MODEL,
          });
        }
        return null;
      }

      const textBlocks = (data.content ?? [])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!);

      const result = textBlocks.join("\n").trim();
      return result || null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Anthropic call exception: ${message}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
