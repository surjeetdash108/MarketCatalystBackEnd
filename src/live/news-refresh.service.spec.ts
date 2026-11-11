/* eslint-disable @typescript-eslint/no-explicit-any */
import { NewsRefreshService } from "./news-refresh.service";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { activeUniverse } from "../common/ticker-universe";

jest.mock("../common/firestore-batch.util", () => ({
  chunkedBatchSet: jest.fn(async () => undefined),
  batchSetWithCreatedAt: jest.fn(async () => undefined),
}));
jest.mock("../common/ticker-universe", () => ({
  TICKER_UNIVERSE: ["AAA", "BBB"],
  activeUniverse: jest.fn(async () => ["AAA", "BBB"]),
}));

const article = (over: Record<string, unknown>) => ({
  id: "x",
  ticker: "AAA",
  headline: "A quiet note about the company",
  summary: null,
  source: "Example Wire",
  vendor: "polygon",
  url: "https://example.com/x",
  category: null,
  sentiment: null,
  sentimentReasoning: null,
  keywords: [],
  imageUrl: null,
  publishedAt: "2026-11-11T10:00:00Z",
  ...over,
});

const BREAKING = article({
  id: "a",
  url: "https://example.com/a",
  vendor: "fmp",
  headline: "AAA beats earnings estimates",
  publishedAt: "2026-11-11T12:00:00Z",
});
const QUIET = article({
  id: "b",
  url: "https://example.com/b",
  headline: "A quiet note about the company",
  publishedAt: "2026-11-11T09:00:00Z",
});
const FILLER = article({
  id: "c",
  ticker: "BBB",
  url: "https://example.com/c",
  sentiment: "positive",
  headline: "BBB Shares Acquired by Balefire LLC",
  publishedAt: "2026-11-11T11:00:00Z",
});
const UNTRACKED = article({
  id: "d",
  ticker: "ZZZ",
  url: "https://example.com/d",
  headline: "ZZZ beats earnings estimates",
});

function setup(polygon: any[], fmp: any[] | null = []) {
  const meta = { record: jest.fn(async () => undefined) };
  const notifications = {
    publish: jest.fn(async () => ({ written: 0, recipients: 0, skipped: 0 })),
    prune: jest.fn(async () => 0),
  };
  const cacheStatus = {
    ensureFresh: jest.fn(),
    expireIfOlderThan: jest.fn(async (items: Array<{ key: string }>) =>
      items.map((i) => i.key),
    ),
  };
  const ondemand = {
    refreshTickerNews: jest.fn(async (_t: string) => ({
      kind: "refreshed",
      ok: true,
    })),
  };
  const col = {
    where: () => ({
      count: () => ({ get: async () => ({ data: () => ({ count: 7 }) }) }),
    }),
    doc: (id: string) => ({ id }),
    limit: () => ({ get: async () => ({ empty: false }) }),
  };
  const firebase = { firestore: { collection: () => col } };
  const news = {
    sourceName: "polygon",
    fetchMarketNews: jest.fn(async () => ({
      data: polygon,
      source: "polygon",
      warnings: [],
    })),
  };
  const newsFmp =
    fmp === null
      ? null
      : {
          sourceName: "fmp",
          fetchMarketNews: jest.fn(async () => ({
            data: fmp,
            source: "fmp",
            warnings: [],
          })),
        };
  const svc = new NewsRefreshService(
    news as never,
    newsFmp as never,
    null as never,
    { lastUpdatedMap: jest.fn(), analyseTicker: jest.fn() } as never,
    firebase as never,
    meta as never,
    notifications as never,
    cacheStatus as never,
    ondemand as never,
  );
  return { svc, meta, notifications, cacheStatus, firebase, ondemand };
}

const writesTo = (collection: string) =>
  (chunkedBatchSet as jest.Mock).mock.calls.filter((c) => c[1] === collection);

beforeEach(() => {
  (chunkedBatchSet as jest.Mock).mockClear();
  (activeUniverse as jest.Mock).mockClear();
});

describe("NewsRefreshService.refresh", () => {
  it("writes every tracked article to `news`, and only important non-filler ones to `news_breaking`", async () => {
    const { svc } = setup([QUIET, FILLER, UNTRACKED], [BREAKING]);

    const res = await svc.refresh();

    const newsDocs = writesTo("news")[0][2]
      .map((d: any) => d.id)
      .sort();
    expect(newsDocs).toEqual(["AAA_a", "AAA_b", "BBB_c"]);
    const breakingDocs = writesTo("news_breaking")[0][2];
    expect(breakingDocs.map((d: any) => d.id)).toEqual(["AAA_a"]);
    expect(breakingDocs[0].data).toMatchObject({
      ticker: "AAA",
      filler: false,
      direction: expect.any(String),
      importanceReasons: expect.arrayContaining(["keyword:earnings-surprise"]),
    });
    expect(res).toMatchObject({
      count: 3,
      breakingCount: 1,
      tickersCovered: 2,
    });
  });

  it("the filler article is stored in `news` flagged filler, so nothing is lost", async () => {
    const { svc } = setup([FILLER], []);
    await svc.refresh();
    const stored = writesTo("news")[0][2].find((d: any) => d.id === "BBB_c");
    expect(stored.data.filler).toBe(true);
    expect(writesTo("news_breaking")).toHaveLength(0);
  });

  it("writes nothing to `news_breaking` when no story qualifies", async () => {
    const { svc } = setup([QUIET], []);
    const res = await svc.refresh();
    expect(writesTo("news_breaking")).toHaveLength(0);
    expect(res.breakingCount).toBe(0);
  });

  it("expires the detail-news cache of each breaking ticker, using the story's publish time", async () => {
    const { svc, cacheStatus } = setup([QUIET], [BREAKING]);

    await svc.refresh();

    expect(cacheStatus.expireIfOlderThan).toHaveBeenCalledWith([
      {
        key: "news:ticker:AAA",
        dataNewerThan: Date.parse("2026-11-11T12:00:00Z"),
      },
    ]);
  });

  it("uses the NEWEST breaking story per ticker", async () => {
    const older = article({
      id: "e",
      url: "https://example.com/e",
      headline: "AAA upgraded by analyst",
      publishedAt: "2026-11-11T08:00:00Z",
    });
    const { svc, cacheStatus } = setup([older], [BREAKING]);

    await svc.refresh();

    expect((cacheStatus.expireIfOlderThan.mock.calls[0] as any)[0]).toEqual([
      {
        key: "news:ticker:AAA",
        dataNewerThan: Date.parse("2026-11-11T12:00:00Z"),
      },
    ]);
  });

  describe("breaking news refreshes ticker pages right away", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        article({
          id: `m${i}`,
          ticker: `T${String(i).padStart(2, "0")}`,
          url: `https://example.com/m${i}`,
          headline: `T${String(i).padStart(2, "0")} beats earnings estimates`,
          publishedAt: new Date(
            Date.UTC(2026, 10, 11, 12, 0) - i * 60_000,
          ).toISOString(),
        }),
      );

    it("fetches the ticker's news now and does not just mark it", async () => {
      const { svc, ondemand } = setup([QUIET], [BREAKING]);

      const res = await svc.refresh();

      expect(ondemand.refreshTickerNews).toHaveBeenCalledTimes(1);
      expect(ondemand.refreshTickerNews).toHaveBeenCalledWith("AAA");
      expect(res.count).toBe(2);
    });

    it("leaves a ticker alone when its saved news is already newer than the story", async () => {
      const { svc, cacheStatus, ondemand } = setup([QUIET], [BREAKING]);
      cacheStatus.expireIfOlderThan.mockResolvedValue([]);

      await svc.refresh();

      expect(ondemand.refreshTickerNews).not.toHaveBeenCalled();
    });

    it("refreshes at most 10 tickers per run, newest story first", async () => {
      (activeUniverse as jest.Mock).mockResolvedValueOnce(
        many(15).map((a) => a.ticker),
      );
      const { svc, ondemand } = setup(many(15), []);

      await svc.refresh();

      const called = ondemand.refreshTickerNews.mock.calls.map((c) => c[0]);
      expect(called).toHaveLength(10);
      expect(called.slice().sort()).toEqual(
        Array.from({ length: 10 }, (_, i) => `T${String(i).padStart(2, "0")}`),
      );
    });

    it("runs at most 3 at once", async () => {
      (activeUniverse as jest.Mock).mockResolvedValueOnce(
        many(8).map((a) => a.ticker),
      );
      const { svc, ondemand } = setup(many(8), []);
      let running = 0;
      let peak = 0;
      ondemand.refreshTickerNews.mockImplementation(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setImmediate(r));
        running--;
        return { kind: "refreshed", ok: true };
      });

      await svc.refresh();

      expect(ondemand.refreshTickerNews).toHaveBeenCalledTimes(8);
      expect(peak).toBeLessThanOrEqual(3);
    });

    it("one ticker failing does not stop the others or fail the news refresh", async () => {
      (activeUniverse as jest.Mock).mockResolvedValueOnce(
        many(3).map((a) => a.ticker),
      );
      const { svc, ondemand, meta } = setup(many(3), []);
      ondemand.refreshTickerNews.mockImplementation(async (t: string) => {
        if (t === "T01") throw new Error("vendor down");
        return { kind: "refreshed", ok: true };
      });

      const res = await svc.refresh();

      expect(ondemand.refreshTickerNews).toHaveBeenCalledTimes(3);
      expect(res.count).toBe(3);
      expect(meta.record).toHaveBeenCalledWith(
        "news",
        expect.objectContaining({ ok: true }),
      );
    });

    it("a problem looking up what is out of date does not fail the news refresh", async () => {
      const { svc, cacheStatus, meta } = setup([QUIET], [BREAKING]);
      cacheStatus.expireIfOlderThan.mockRejectedValue(
        new Error("firestore blip"),
      );

      await expect(svc.refresh()).resolves.toMatchObject({ count: 2 });
      expect(meta.record).toHaveBeenCalledWith(
        "news",
        expect.objectContaining({ ok: true }),
      );
    });

    it("does nothing when no story is breaking", async () => {
      const { svc, cacheStatus, ondemand } = setup([QUIET], []);
      await svc.refresh();
      expect(cacheStatus.expireIfOlderThan).toHaveBeenCalledWith([]);
      expect(ondemand.refreshTickerNews).not.toHaveBeenCalled();
    });
  });

  it("reports the newest publishedAt written as the watermark", async () => {
    const { svc } = setup([QUIET, FILLER], [BREAKING]);
    const res = await svc.refresh();
    expect(res.newestPublishedAt).toBe("2026-11-11T12:00:00Z");
  });

  it("keeps notifications and the sync_meta record exactly as before", async () => {
    const { svc, notifications, meta } = setup([QUIET], [BREAKING]);
    await svc.refresh();
    expect(notifications.publish).toHaveBeenCalledTimes(1);
    expect(notifications.prune).toHaveBeenCalledTimes(1);
    expect(meta.record).toHaveBeenCalledWith(
      "news",
      expect.objectContaining({ ok: true, count: 2 }),
    );
  });

  it("every source empty: writes nothing and says so", async () => {
    const { svc, meta, cacheStatus } = setup([], []);

    const res = await svc.refresh();

    expect(res).toEqual({ count: 0, skipped: true });
    expect(chunkedBatchSet).not.toHaveBeenCalled();
    expect(cacheStatus.expireIfOlderThan).not.toHaveBeenCalled();
    expect(meta.record).toHaveBeenCalledWith(
      "news",
      expect.objectContaining({ ok: false }),
    );
  });

  it("a thrown error is recorded and re-thrown", async () => {
    const { svc, meta } = setup([QUIET], []);
    (chunkedBatchSet as jest.Mock).mockRejectedValueOnce(
      new Error("write failed"),
    );

    await expect(svc.refresh()).rejects.toThrow("write failed");
    expect(meta.record).toHaveBeenCalledWith("news", {
      ok: false,
      error: "write failed",
    });
  });
});

describe("NewsRefreshService.ensureFresh", () => {
  const options = (cacheStatus: any) =>
    cacheStatus.ensureFresh.mock.calls[0][0];

  it("does not wait by default (user requests), and waits when a job asks", async () => {
    const a = setup([], []);
    await a.svc.ensureFresh();
    expect(options(a.cacheStatus).awaitRefresh).toBe(false);

    const b = setup([], []);
    await b.svc.ensureFresh(true);
    expect(options(b.cacheStatus).awaitRefresh).toBe(true);
  });

  it("registers the refresh under news:breaking with a 15 minute TTL", async () => {
    const { svc, cacheStatus } = setup([], []);
    await svc.ensureFresh();
    expect(options(cacheStatus)).toMatchObject({
      key: "news:breaking",
      location: "news",
      ttlMs: 15 * 60_000,
    });
  });

  it("the refresh stores the watermark", async () => {
    const { svc, cacheStatus } = setup([QUIET], [BREAKING]);
    await svc.ensureFresh();
    await expect(options(cacheStatus).refresh({})).resolves.toEqual({
      watermark: "2026-11-11T12:00:00Z",
    });
  });

  it("every source empty counts as a FAILED refresh, so it is retried rather than trusted for 15 minutes", async () => {
    const { svc, cacheStatus } = setup([], []);
    await svc.ensureFresh();
    await expect(options(cacheStatus).refresh({})).rejects.toThrow(
      "0 articles",
    );
  });

  it("data already stored by the cron means the first request does not wait", async () => {
    const { svc, cacheStatus } = setup([], []);
    await svc.ensureFresh();
    await expect(options(cacheStatus).hasData()).resolves.toBe(true);
  });
});
