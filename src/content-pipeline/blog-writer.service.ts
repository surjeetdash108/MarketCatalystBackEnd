import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Anthropic from "@anthropic-ai/sdk";
import {
  BLOG_ARTICLE_SCHEMA,
  WRITER_SYSTEM_PROMPT,
  checkArticle,
  writerUserPrompt,
  type BlogArticle,
  type WriteRequest,
} from "./blog-article";

/** Thrown when ANTHROPIC_API_KEY isn't set: the item waits instead of failing. */
export class WriterKeyMissingError extends Error {
  constructor() {
    super("AI key not set (ANTHROPIC_API_KEY). Add it, then press Retry.");
  }
}

/** Claude declined, ran out of room, or returned something unusable. Retryable a few times. */
export class WriterOutputError extends Error {}

export const DEFAULT_WRITER_MODEL = "claude-opus-5-5";

/**
 * Writes one blog article from an editor's notes with Claude, as structured
 * output (BLOG_ARTICLE_SCHEMA), so the article's text can be escaped into the
 * blog template. The model defaults to Claude Opus 5.5 and can be switched
 * with CONTENT_AI_MODEL. Server-side fallback is on: if the model declines on
 * policy grounds, the API retries the same request on a fallback model.
 */
@Injectable()
export class BlogWriterService {
  private readonly logger = new Logger(BlogWriterService.name);
  private client: Anthropic | null = null;

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string {
    return (this.config.get<string>("ANTHROPIC_API_KEY") ?? "").trim();
  }

  get enabled(): boolean {
    return this.apiKey.length > 0;
  }

  get model(): string {
    return (
      (this.config.get<string>("CONTENT_AI_MODEL") ?? "").trim() ||
      DEFAULT_WRITER_MODEL
    );
  }

  private sdk(): Anthropic {
    if (!this.enabled) throw new WriterKeyMissingError();
    this.client ??= new Anthropic({
      apiKey: this.apiKey,
      maxRetries: 2,
      timeout: 5 * 60_000,
    });
    return this.client;
  }

  async write(
    req: WriteRequest,
  ): Promise<{ article: BlogArticle; model: string }> {
    const client = this.sdk();
    const response = await client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        {
          type: "text",
          text: WRITER_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      output_config: {
        effort: "high",
        format: {
          type: "json_schema",
          schema: BLOG_ARTICLE_SCHEMA,
        },
      },
      messages: [{ role: "user", content: writerUserPrompt(req) }],
    });

    if (response.stop_reason === "refusal") {
      const why =
        response.stop_details?.explanation ??
        response.stop_details?.category ??
        "no reason given";
      throw new WriterOutputError(
        `The AI declined to write this article (${why}).`,
      );
    }
    if (response.stop_reason === "max_tokens")
      throw new WriterOutputError("The article ran past the length limit.");

    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    let parsed: BlogArticle;
    try {
      parsed = JSON.parse(text) as BlogArticle;
    } catch {
      throw new WriterOutputError(
        "The AI returned something that isn't an article.",
      );
    }
    let article: BlogArticle;
    try {
      article = checkArticle(parsed);
    } catch (err) {
      throw new WriterOutputError((err as Error).message);
    }
    this.logger.log(
      `article written by ${response.model}: "${article.title}" (in ${response.usage.input_tokens}, out ${response.usage.output_tokens} tokens)`,
    );
    return { article, model: response.model };
  }
}
