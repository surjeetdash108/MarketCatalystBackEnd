import { GroqService } from "./groq.service";
import { fetchJson } from "../../common/http.util";

jest.mock("../../common/http.util", () => ({ fetchJson: jest.fn() }));

const mockFetch = fetchJson as jest.Mock;

const svc = (model: string) =>
  new GroqService({
    get: (key: string, fallback?: unknown) =>
      ({ GROQ_API_KEY: "test-key", GROQ_MODEL: model } as Record<string, unknown>)[key] ?? fallback,
  } as never);

const sentBody = () => JSON.parse((mockFetch.mock.calls.at(-1)![1] as { body: string }).body);

describe("GroqService.chat request body", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
  });

  it("sends reasoning_effort to gpt-oss models", async () => {
    await svc("openai/gpt-oss-120b").chat([], { reasoningEffort: "low" });
    expect(sentBody().reasoning_effort).toBe("low");
  });

  it("does not send reasoning_effort to models that reject it", async () => {
    await svc("llama-3.3-70b-versatile").chat([], { reasoningEffort: "low" });
    expect(sentBody()).not.toHaveProperty("reasoning_effort");
  });

  it("leaves reasoning_effort off when the caller does not ask for it", async () => {
    await svc("openai/gpt-oss-120b").chat([]);
    expect(sentBody()).not.toHaveProperty("reasoning_effort");
  });

  it("asks for a JSON object by default and for prose when jsonMode is false", async () => {
    await svc("openai/gpt-oss-120b").chat([]);
    expect(sentBody().response_format).toEqual({ type: "json_object" });

    await svc("openai/gpt-oss-120b").chat([], { jsonMode: false });
    expect(sentBody()).not.toHaveProperty("response_format");
  });

  it("uses the caller's token cap, defaulting to 4000", async () => {
    await svc("openai/gpt-oss-120b").chat([], { maxTokens: 1000 });
    expect(sentBody().max_tokens).toBe(1000);

    await svc("openai/gpt-oss-120b").chat([]);
    expect(sentBody().max_tokens).toBe(4000);
  });
});
