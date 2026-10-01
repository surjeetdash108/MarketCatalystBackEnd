import { LlmGatewayService } from "./llm-gateway.service";

const svc = (groq: unknown, openrouter: unknown) =>
  new LlmGatewayService(groq as never, openrouter as never);
const provider = (enabled: boolean, reply: string | null, spy?: string[]) => ({
  enabled,
  modelName: "m",
  chat: async () => { spy?.push("called"); return reply; },
});

describe("LlmGatewayService", () => {
  it("uses Groq when it answers, and never calls OpenRouter", async () => {
    const orCalls: string[] = [];
    const g = svc(provider(true, '{"summary":"ok"}'), provider(true, "x", orCalls));
    expect(await g.chat([])).toBe('{"summary":"ok"}');
    expect(orCalls).toEqual([]);
  });

  it("falls back when Groq returns EMPTY, not just on error", async () => {
    // A 200 with blank content is as useless as a throw — that is the case
    // this fallback exists for.
    const g = svc(provider(true, ""), provider(true, "fallback"));
    expect(await g.chat([])).toBe("fallback");
  });

  it("falls back when Groq returns null", async () => {
    const g = svc(provider(true, null), provider(true, "fallback"));
    expect(await g.chat([])).toBe("fallback");
  });

  it("skips straight to OpenRouter when Groq is unconfigured", async () => {
    const g = svc(provider(false, null), provider(true, "fallback"));
    expect(await g.chat([])).toBe("fallback");
  });

  it("returns null when neither provider can serve", async () => {
    const g = svc(provider(false, null), provider(false, null));
    expect(await g.chat([])).toBeNull();
    expect(g.enabled).toBe(false);
  });

  it("is enabled when either provider is", async () => {
    expect(svc(provider(true, "x"), provider(false, null)).enabled).toBe(true);
    expect(svc(provider(false, null), provider(true, "x")).enabled).toBe(true);
  });

  it("reports Groq as primary when configured", () => {
    expect(svc(provider(true, "x"), provider(true, "y")).primaryName).toMatch(/^groq:/);
    expect(svc(provider(false, null), provider(true, "y")).primaryName).toMatch(/^openrouter:/);
  });
});
