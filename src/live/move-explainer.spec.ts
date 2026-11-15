import { MoveExplainerService } from "./move-explainer.service";
import {
  articleKey,
  buildUserPrompt,
  coerceMoveCard,
  figuresAreSourced,
  namesTicker,
  parseJsonObject,
  selectMoveArticles,
  type MoveArticle,
} from "./move-explainer.util";

const DAY = 86_400_000;
const dayStr = (t: number) => new Date(t).toISOString().slice(0, 10);
const iso = (date: string, hour: number) =>
  `${date}T${String(hour).padStart(2, "0")}:00:00Z`;
const art = (
  publishedAt: string,
  headline: string,
  extra: Record<string, unknown> = {},
) => ({
  publishedAt,
  headline,
  summary: "",
  source: "Reuters",
  url: `https://example.com/${encodeURIComponent(headline).slice(0, 40)}-${publishedAt}`,
  ...extra,
});
const NV = { ticker: "NVDA", name: "NVIDIA Corporation" };

describe("namesTicker", () => {
  it("accepts the ticker or the company, rejects other companies' stories", () => {
    expect(namesTicker("NVDA falls 5%", "NVDA", "NVIDIA Corporation")).toBe(
      true,
    );
    expect(
      namesTicker("Nvidia CEO resigns", "NVDA", "NVIDIA Corporation"),
    ).toBe(true);
    expect(
      namesTicker(
        "AMD jumps as chip stocks rally",
        "NVDA",
        "NVIDIA Corporation",
      ),
    ).toBe(false);
  });
});

describe("selectMoveArticles", () => {
  const date = "2026-11-10";
  const opts = { date, prevDate: "2026-11-09", ...NV };

  it("keeps articles from the previous close to the evening after the move", () => {
    const got = selectMoveArticles(
      [
        art(
          iso("2026-11-09", 19),
          "Nvidia early story before the close window",
        ),
        art(iso("2026-11-09", 21), "Nvidia CEO Jensen Huang faces board probe"),
        art(iso("2026-11-10", 15), "Nvidia plunges 5.5% as CEO scandal widens"),
        art(iso("2026-11-11", 2), "Nvidia late-night follow-up on the scandal"),
        art(iso("2026-11-11", 5), "Nvidia story the next morning"),
      ],
      opts,
    );
    expect(got.map((a) => a.headline).sort()).toEqual(
      [
        "Nvidia CEO Jensen Huang faces board probe",
        "Nvidia late-night follow-up on the scandal",
        "Nvidia plunges 5.5% as CEO scandal widens",
      ].sort(),
    );
  });

  it("a Monday move sees the weekend through prevDate (the previous trading day)", () => {
    const sat = art(
      iso("2026-11-08", 14),
      "Nvidia CEO scandal: report names board investigation",
    );
    expect(
      selectMoveArticles([sat], {
        date: "2026-11-09",
        prevDate: "2026-11-06",
        ...NV,
      }),
    ).toHaveLength(1);
    expect(
      selectMoveArticles([sat], { date: "2026-11-09", ...NV }),
    ).toHaveLength(0);
  });

  it("drops law-firm ads, stake filings, syndicated filler and other companies' stories", () => {
    const got = selectMoveArticles(
      [
        art(
          iso(date, 14),
          "NVDA INVESTOR ALERT: Hagens Berman Updates NVIDIA Corporation Securities Class Action Investigation",
        ),
        art(
          iso(date, 14),
          "NVIDIA Corporation $NVDA Shares Acquired by First County Bank CT",
        ),
        art(iso(date, 14), "Nvidia plunges 5.5% as CEO scandal widens", {
          source: "defenseworld.net",
        }),
        art(iso(date, 14), "AMD jumps as chip stocks rally"),
        art(
          iso(date, 14),
          "Nvidia CEO scandal prompts independent board investigation",
        ),
      ],
      opts,
    );
    expect(got.map((a) => a.headline)).toEqual([
      "Nvidia CEO scandal prompts independent board investigation",
    ]);
  });

  it("collapses repeats and puts the story many outlets carried first", () => {
    const got = selectMoveArticles(
      [
        art(iso(date, 9), "Nvidia unveils new gaming chip lineup"),
        art(
          iso(date, 13),
          "Nvidia CEO Huang placed under board investigation",
          { source: "Reuters" },
        ),
        art(
          iso(date, 14),
          "Nvidia CEO Huang placed under board investigation",
          { source: "Reuters", url: "https://example.com/dup" },
        ),
        art(
          iso(date, 15),
          "Nvidia CEO Huang faces board investigation over conduct",
          { source: "Bloomberg" },
        ),
        art(iso(date, 16), "Board investigation of Nvidia CEO Huang widens", {
          source: "CNBC",
        }),
      ],
      opts,
    );
    expect(got).toHaveLength(4);
    expect(got[0].headline).toMatch(/investigation/);
    expect(got.at(-1)!.headline).toBe("Nvidia unveils new gaming chip lineup");
    expect(got.map((a) => a.n)).toEqual([1, 2, 3, 4]);
  });

  it("a headline saying the stock moved the way it did outranks unrelated pieces (Jul 27 'Why Nvidia Stock Fell Today')", () => {
    const d = "2026-07-27";
    const news = [
      art(
        iso(d, 12),
        "Which Is the Better Value Stock Right Now: Microsoft or Nvidia?",
      ),
      art(
        iso(d, 13),
        "Nvidia's Jensen Huang Confirmed Vera Rubin Chips Are Already in Production",
      ),
      art(iso(d, 21), "Why Nvidia Stock Fell Today"),
      art(iso(d, 14), "Could AMD Dethrone Nvidia?"),
    ];
    expect(
      selectMoveArticles(news, {
        date: d,
        prevDate: "2026-07-24",
        ...NV,
        movePct: -4.99,
      })[0].headline,
    ).toBe("Why Nvidia Stock Fell Today");
  });

  it("caps how many articles go to the model", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      art(
        iso(date, 10),
        `Nvidia headline number ${i} about distinct subject ${"abcdefghij"[i % 10]}${i}xyz`,
      ),
    );
    expect(selectMoveArticles(many, opts).length).toBeLessThanOrEqual(8);
    expect(selectMoveArticles(many, { ...opts, max: 5 })).toHaveLength(5);
  });

  it("a bad date gives nothing", () => {
    expect(
      selectMoveArticles([art(iso(date, 12), "Nvidia news")], {
        ...opts,
        date: "nope",
      }),
    ).toEqual([]);
  });
});

describe("coerceMoveCard", () => {
  const articles: MoveArticle[] = [
    {
      n: 1,
      headline: "Nvidia plunges 5.5% as CEO scandal widens",
      summary:
        "Shares closed at $168.80 as a $250 billion financing report added to concern.",
      source: "Reuters",
      url: "u1",
      publishedAt: 1,
    },
    {
      n: 2,
      headline: "Nvidia board opens independent investigation of CEO",
      summary: "",
      source: "CNBC",
      url: "u2",
      publishedAt: 2,
    },
  ];
  const good = {
    explains: true,
    heading:
      "Nvidia falls as board opens independent investigation into its CEO",
    summary:
      "Nvidia's board opened an independent investigation of its chief executive, CNBC reported. Shares closed at $168.80, down 5.47% on the day.",
    used: [1, 2, 9, 1],
  };

  it("accepts a sourced card and keeps only valid, de-duplicated article numbers", () => {
    expect(coerceMoveCard(good, articles, -5.47)).toEqual({
      heading: good.heading,
      summary: good.summary,
      used: [1, 2],
    });
  });

  it("passes on the model saying the articles do not explain the move", () => {
    expect(coerceMoveCard({ explains: false }, articles)).toBe("none");
  });

  it("rejects malformed answers, wrong lengths and links", () => {
    expect(coerceMoveCard(null, articles)).toBeNull();
    expect(
      coerceMoveCard(
        { heading: good.heading, summary: good.summary },
        articles,
      ),
    ).toBeNull();
    expect(
      coerceMoveCard({ ...good, heading: "Short" }, articles, -5.47),
    ).toBeNull();
    expect(
      coerceMoveCard({ ...good, summary: "Too short." }, articles, -5.47),
    ).toBeNull();
    expect(
      coerceMoveCard(
        { ...good, summary: `${good.summary} See https://evil.example/x` },
        articles,
        -5.47,
      ),
    ).toBeNull();
  });

  it("rejects a figure that is in none of the articles (an invented number)", () => {
    expect(
      coerceMoveCard(
        {
          ...good,
          summary:
            "Nvidia's board opened an investigation, CNBC reported. The company lost $900 billion in value overnight.",
        },
        articles,
        -5.47,
      ),
    ).toBeNull();
    expect(
      coerceMoveCard(
        {
          ...good,
          heading:
            "Nvidia falls 12% as board opens independent investigation of CEO",
        },
        articles,
        -5.47,
      ),
    ).toBeNull();
  });

  it("allows the day's own move and plain small numbers, not invented ones", () => {
    expect(
      figuresAreSourced(
        {
          heading: "Nvidia drops 5.5% on CEO probe news",
          summary:
            "The stock fell 5.47% in the session, its worst day in 3 weeks.",
        },
        articles,
        -5.47,
      ),
    ).toBe(true);
    expect(
      figuresAreSourced(
        {
          heading: "Nvidia drops on CEO probe news",
          summary: "The stock fell 7.2% in the session.",
        },
        articles,
        -5.47,
      ),
    ).toBe(false);
  });

  it("strips markdown, HTML and a 'Stock Market Today' stamp from the heading", () => {
    const got = coerceMoveCard(
      {
        ...good,
        heading:
          "Stock Market Today, Nov. 10: **Nvidia falls** as <b>board</b> opens independent investigation",
      },
      articles,
      -5.47,
    );
    expect(got).not.toBe("none");
    expect((got as { heading: string }).heading).toBe(
      "Nvidia falls as board opens independent investigation",
    );
  });
});

describe("parseJsonObject / buildUserPrompt / articleKey", () => {
  it("finds the JSON object inside a fenced or chatty reply", () => {
    expect(parseJsonObject('Sure!\n```json\n{"explains": false}\n```')).toEqual(
      { explains: false },
    );
    expect(parseJsonObject("no json here")).toBeNull();
    expect(parseJsonObject('{"a": "has } brace", "b": 1}')).toEqual({
      a: "has } brace",
      b: 1,
    });
  });

  it("numbers the articles and names the move", () => {
    const p = buildUserPrompt(
      {
        ticker: "NVDA",
        name: "NVIDIA Corporation",
        date: "2026-11-10",
        movePct: -5.47,
      },
      [
        {
          n: 1,
          headline: "Nvidia plunges",
          summary: "Details here.",
          source: "Reuters",
          url: "",
          publishedAt: Date.parse("2026-11-10T15:00:00Z"),
        },
      ],
    );
    expect(p).toContain("NVIDIA Corporation (NVDA)");
    expect(p).toContain("−5.47%");
    expect(p).toContain("Tuesday 2026-11-10");
    expect(p).toContain("[1] Reuters · 2026-11-10 15:00 UTC");
    expect(p).toContain("Nvidia plunges\nDetails here.");
  });

  it("changes when an article is added, not when order changes", () => {
    const a = {
      n: 1,
      headline: "A",
      summary: "",
      source: "",
      url: "ua",
      publishedAt: 1,
    };
    const b = {
      n: 2,
      headline: "B",
      summary: "",
      source: "",
      url: "ub",
      publishedAt: 2,
    };
    expect(articleKey([a, b])).toBe(
      articleKey([
        { ...b, n: 1 },
        { ...a, n: 2 },
      ]),
    );
    expect(articleKey([a])).not.toBe(articleKey([a, b]));
  });
});

describe("MoveExplainerService", () => {
  const today = Date.now();
  const recent = dayStr(today - DAY);
  const settled = dayStr(today - 30 * DAY);

  const goodReply = (
    heading = "Nvidia falls as board opens independent investigation into its CEO",
  ) =>
    JSON.stringify({
      explains: true,
      heading,
      summary:
        "Nvidia's board opened an independent investigation of its chief executive, Reuters reported. The stock fell 5.47% in the session.",
      used: [1],
    });

  const setup = (
    opts: {
      news?: Record<string, unknown>[];
      reply?: string | null;
      stored?: Record<string, unknown>;
    } = {},
  ) => {
    const store = new Map<string, Record<string, unknown>>();
    if (opts.stored) store.set(opts.stored.__id as string, opts.stored);
    const firebase = {
      firestore: {
        collection: () => ({
          doc: (id: string) => ({
            get: async () => ({
              exists: store.has(id),
              data: () => store.get(id),
            }),
            set: async (d: Record<string, unknown>) => void store.set(id, d),
          }),
        }),
      },
    };
    const chat = jest
      .fn()
      .mockResolvedValue(opts.reply === undefined ? goodReply() : opts.reply);
    const llm = { enabled: true, primaryName: "groq:test", chat };
    const getNews = jest.fn().mockResolvedValue(opts.news ?? []);
    const service = new MoveExplainerService(
      firebase as never,
      llm as never,
      { getNews } as never,
    );
    return { service, store, chat, getNews, llm };
  };

  const newsFor = (date: string) => [
    art(iso(date, 15), "Nvidia plunges 5.5% as CEO scandal widens"),
    art(iso(date, 16), "Nvidia CEO faces board investigation, Reuters reports"),
  ];
  const input = (date: string) => ({
    ticker: "nvda",
    date,
    prevDate: dayStr(Date.parse(date) - DAY),
    name: "NVIDIA Corporation",
    movePct: -5.47,
  });

  it("writes the card from the day's articles, stores it, and answers repeat requests without the model", async () => {
    const { service, store, chat } = setup({ news: newsFor(settled) });
    const first = await service.getExplanation(input(settled));
    expect(first).toMatchObject({
      available: true,
      ticker: "NVDA",
      date: settled,
      model: "groq:test",
      articleCount: 2,
    });
    expect(first.heading).toBe(
      "Nvidia falls as board opens independent investigation into its CEO",
    );
    expect(first.sources).toEqual([
      { name: "Reuters", url: expect.any(String) },
    ]);
    expect(
      (first as unknown as Record<string, unknown>).articleKey,
    ).toBeUndefined();
    expect(store.get(`NVDA_${settled}`)).toMatchObject({
      available: true,
      articleKey: expect.any(String),
    });
    await service.getExplanation(input(settled));
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("hands the model only that day's articles and the move", async () => {
    const { service, chat } = setup({
      news: [
        ...newsFor(settled),
        art(
          iso(dayStr(today - 60 * DAY), 15),
          "Nvidia unrelated old story about a month ago",
        ),
      ],
    });
    await service.getExplanation(input(settled));
    const [messages, opts] = chat.mock.calls[0];
    expect(messages[1].content).toContain(
      "Nvidia plunges 5.5% as CEO scandal widens",
    );
    expect(messages[1].content).not.toContain("unrelated old story");
    expect(messages[1].content).toContain("−5.47%");
    expect(opts).toMatchObject({
      timeoutMs: 25_000,
      maxTokens: 450,
      reasoningEffort: "low",
    });
  });

  it("a settled day with a stored card never touches news or the model again", async () => {
    const { service, chat, getNews } = setup({
      stored: {
        __id: `NVDA_${settled}`,
        available: true,
        ticker: "NVDA",
        date: settled,
        heading: "Stored heading for the settled day",
        summary: "x",
        generatedAt: "2026-10-01T00:00:00Z",
        articleKey: "2:abc",
      },
    });
    const got = await service.getExplanation(input(settled));
    expect(got.heading).toBe("Stored heading for the settled day");
    expect(chat).not.toHaveBeenCalled();
    expect(getNews).not.toHaveBeenCalled();
  });

  it("no articles: no model call, and the empty answer is stored", async () => {
    const { service, chat, store } = setup({ news: [] });
    expect(await service.getExplanation(input(settled))).toMatchObject({
      available: false,
      reason: "no-articles",
    });
    expect(chat).not.toHaveBeenCalled();
    expect(store.get(`NVDA_${settled}`)).toMatchObject({
      reason: "no-articles",
    });
  });

  it("the model saying the articles do not explain the move is stored, not retried", async () => {
    const { service, chat, store } = setup({
      news: newsFor(settled),
      reply: '{"explains": false}',
    });
    expect(await service.getExplanation(input(settled))).toMatchObject({
      available: false,
      reason: "no-explanation",
    });
    expect(store.get(`NVDA_${settled}`)).toMatchObject({
      reason: "no-explanation",
    });
    const second = setup({
      news: newsFor(settled),
      reply: '{"explains": false}',
      stored: { ...store.get(`NVDA_${settled}`), __id: `NVDA_${settled}` },
    });
    await second.service.getExplanation(input(settled));
    expect(second.chat).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("an unusable answer (invented figure) is not stored, so the next request tries again", async () => {
    const bad = JSON.stringify({
      explains: true,
      heading:
        "Nvidia falls as board opens independent investigation into its CEO",
      summary:
        "Nvidia lost $900 billion in value after the board opened an investigation, Reuters reported.",
      used: [1],
    });
    const { service, store } = setup({ news: newsFor(settled), reply: bad });
    expect(await service.getExplanation(input(settled))).toMatchObject({
      available: false,
      reason: "llm-failed",
    });
    expect(store.size).toBe(0);
  });

  it("a model that returns nothing or throws is not stored either", async () => {
    const a = setup({ news: newsFor(settled), reply: null });
    expect(await a.service.getExplanation(input(settled))).toMatchObject({
      available: false,
      reason: "llm-failed",
    });
    const b = setup({ news: newsFor(settled) });
    b.chat.mockRejectedValue(new Error("boom"));
    expect(await b.service.getExplanation(input(settled))).toMatchObject({
      available: false,
      reason: "llm-failed",
    });
    expect(a.store.size + b.store.size).toBe(0);
  });

  it("without a model configured it says so and stores nothing", async () => {
    const { service, llm, store } = setup({ news: newsFor(settled) });
    llm.enabled = false;
    expect(await service.getExplanation(input(settled))).toMatchObject({
      available: false,
      reason: "llm-unavailable",
    });
    expect(store.size).toBe(0);
  });

  it("a recent day is rewritten only when new articles arrived and the stored card is old enough", async () => {
    const id = `NVDA_${recent}`;
    const news = newsFor(recent);
    const key = articleKey(
      selectMoveArticles(news, {
        date: recent,
        prevDate: dayStr(Date.parse(recent) - DAY),
        ticker: "NVDA",
        name: "NVIDIA Corporation",
      }),
    );
    const stored = (generatedAt: string, articleKeyValue: string) => ({
      __id: id,
      available: true,
      ticker: "NVDA",
      date: recent,
      heading: "Stored heading for the recent day",
      summary: "x",
      generatedAt,
      articleKey: articleKeyValue,
    });
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();

    const same = setup({ news, stored: stored(old, key) });
    expect((await same.service.getExplanation(input(recent))).heading).toBe(
      "Stored heading for the recent day",
    );
    expect(same.chat).not.toHaveBeenCalled();

    const changed = setup({ news, stored: stored(old, "1:old") });
    expect((await changed.service.getExplanation(input(recent))).heading).toBe(
      "Nvidia falls as board opens independent investigation into its CEO",
    );
    expect(changed.chat).toHaveBeenCalledTimes(1);

    const justWritten = setup({
      news,
      stored: stored(new Date().toISOString(), "1:old"),
    });
    expect(
      (await justWritten.service.getExplanation(input(recent))).heading,
    ).toBe("Stored heading for the recent day");
    expect(justWritten.chat).not.toHaveBeenCalled();
  });

  it("two requests for the same day at once share one model call", async () => {
    const { service, chat } = setup({ news: newsFor(settled) });
    const [a, b] = await Promise.all([
      service.getExplanation(input(settled)),
      service.getExplanation(input(settled)),
    ]);
    expect(a).toEqual(b);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("stops calling the model past the per-minute budget", async () => {
    const { service, chat } = setup({ news: newsFor(settled) });
    const days = Array.from({ length: 8 }, (_, i) =>
      dayStr(today - (30 + i) * DAY),
    );
    const news = days.flatMap(newsFor);
    (
      service as unknown as { ondemand: { getNews: jest.Mock } }
    ).ondemand.getNews.mockResolvedValue(news);
    const results = [];
    for (const d of days) results.push(await service.getExplanation(input(d)));
    expect(chat).toHaveBeenCalledTimes(6);
    expect(results.slice(6).map((r) => r.reason)).toEqual(["busy", "busy"]);
  });
});
