/* eslint-disable @typescript-eslint/no-explicit-any */
import { OnDemandService } from "./ondemand.service";

/**
 * Per-ticker news: answers from `news`, and refreshes from the vendors in the
 * background through cache_status (expires at the next New York midnight,
 * sooner when breaking news names the ticker). CacheStatusService itself is tested in cache-status.service.spec.
 */

const art = (
  id: string,
  publishedAt: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  ticker: "NVDA",
  headline: `h-${id}`,
  summary: null,
  source: "S",
  vendor: "fmp",
  url: `https://example.com/${id}`,
  category: null,
  sentiment: null,
  sentimentReasoning: null,
  keywords: [],
  imageUrl: null,
  publishedAt,
  ...over,
});
const stored = (id: string, publishedAt: string) => ({
  id: `NVDA_${id}`,
  data: { ticker: "NVDA", headline: `h-${id}`, publishedAt },
});

function setup(opts: {
  storedDocs?: Array<{ id: string; data: any }>;
  polygon?: () => Promise<any>;
  fmp?: (() => Promise<any>) | null;
}) {
  const docs = [...(opts.storedDocs ?? [])];
  const batchSet = jest.fn();
  const firestore = {
    collection: () => ({
      where: () => ({
        get: async () => ({
          docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
        }),
      }),
      doc: (id: string) => ({ id }),
    }),
    batch: () => {
      const pending: Array<{ id: string; data: any }> = [];
      return {
        set: (ref: any, data: any) => {
          batchSet(ref.id, data);
          pending.push({ id: ref.id, data });
        },
        commit: async () => {
          docs.push(...pending);
        },
      };
    },
  };
  const polygon = jest.fn(opts.polygon ?? (async () => ({ data: [] })));
  const fmp =
    opts.fmp === null
      ? null
      : { fetchNews: jest.fn(opts.fmp ?? (async () => ({ data: [] }))) };
  const cacheStatus = { ensureFresh: jest.fn() };
  const svc = new OnDemandService(
    { firestore } as never,
    null as never,
    null as never,
    { fetchNews: polygon } as never,
    fmp as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    cacheStatus as never,
  );
  return { svc, polygon, fmp, cacheStatus, batchSet, docs };
}

describe("OnDemandService.getNews", () => {
  it("serves stored articles newest first and asks cache_status with a one-day TTL", async () => {
    const { svc, cacheStatus, polygon } = setup({
      storedDocs: [
        stored("old", "2026-11-10T10:00:00Z"),
        stored("new", "2026-11-11T10:00:00Z"),
      ],
    });
    cacheStatus.ensureFresh.mockResolvedValue({ kind: "refresh-started" });

    const out = await svc.getNews("NVDA");

    expect(out.map((a) => a.id)).toEqual(["NVDA_new", "NVDA_old"]);
    expect(cacheStatus.ensureFresh).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "news:ticker:NVDA",
        location: "news",
        ttlMs: 24 * 3600_000,
        hasData: true, // articles the bulk refresh stored count: no waiting
      }),
    );
    expect(polygon).not.toHaveBeenCalled(); // getNews itself never calls a vendor
  });

  it("stored articles are returned without waiting for the refresh", async () => {
    const { svc, cacheStatus, polygon } = setup({
      storedDocs: [stored("a", "2026-11-11T10:00:00Z")],
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Like the real service: starts the refresh but does not await it.
    cacheStatus.ensureFresh.mockImplementation(async (o: any) => {
      void gate.then(() => o.refresh({}));
      return { kind: "refresh-started" };
    });

    const out = await svc.getNews("NVDA");

    expect(out).toHaveLength(1);
    expect(polygon).not.toHaveBeenCalled(); // vendor fetch still pending behind the gate
    release();
  });

  it("nothing stored: waits for the first fetch, caps at 5, and returns the new articles", async () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      art(`n${i}`, `2026-11-11T0${i}:00:00Z`),
    );
    const { svc, cacheStatus, batchSet } = setup({
      polygon: async () => ({ data: seven }),
      fmp: async () => ({ data: [] }),
    });
    cacheStatus.ensureFresh.mockImplementation(async (o: any) => {
      await o.refresh({});
      return { kind: "first-fill", ok: true };
    });

    const out = await svc.getNews("NVDA");

    expect(cacheStatus.ensureFresh).toHaveBeenCalledWith(
      expect.objectContaining({ hasData: false }),
    );
    expect(batchSet).toHaveBeenCalledTimes(5); // NEWS_ARTICLE_CAP
    expect(out).toHaveLength(5);
    expect(out[0].publishedAt >= out[4].publishedAt).toBe(true); // newest first
  });

  it("merges FMP first and drops the duplicate URL from Polygon", async () => {
    const { svc, cacheStatus, docs } = setup({
      polygon: async () => ({
        data: [
          art("p1", "2026-11-11T10:00:00Z", {
            url: "https://x/same",
            vendor: "polygon",
          }),
        ],
      }),
      fmp: async () => ({
        data: [
          art("f1", "2026-11-11T10:00:00Z", {
            url: "https://x/same",
            vendor: "fmp",
          }),
        ],
      }),
    });
    cacheStatus.ensureFresh.mockImplementation(async (o: any) => {
      await o.refresh({});
      return { kind: "first-fill", ok: true };
    });

    await svc.getNews("NVDA");

    expect(docs).toHaveLength(1);
    expect(docs[0].data.vendor).toBe("fmp");
  });

  describe("the refresh function it gives cache_status", () => {
    const grab = async (setupOpts: Parameters<typeof setup>[0]) => {
      const s = setup(setupOpts);
      s.cacheStatus.ensureFresh.mockResolvedValue({ kind: "already-fetching" });
      await s.svc.getNews("NVDA");
      return {
        ...s,
        refresh: (s.cacheStatus.ensureFresh.mock.calls[0][0] as any).refresh,
      };
    };

    it("fails (so cache_status records `failed` and retries) when EVERY vendor fails", async () => {
      const { refresh } = await grab({
        polygon: async () => {
          throw new Error("polygon down");
        },
        fmp: async () => {
          throw new Error("fmp down");
        },
      });
      await expect(refresh({})).rejects.toThrow("every news vendor failed");
    });

    it("succeeds when one vendor fails and the other answers", async () => {
      const { refresh, docs } = await grab({
        polygon: async () => {
          throw new Error("polygon down");
        },
        fmp: async () => ({ data: [art("f1", "2026-11-11T10:00:00Z")] }),
      });
      await expect(refresh({})).resolves.toBeUndefined();
      expect(docs).toHaveLength(1);
    });

    it("succeeds when the vendors answer with no articles (a quiet ticker is a normal result)", async () => {
      const { refresh, batchSet } = await grab({});
      await expect(refresh({})).resolves.toBeUndefined();
      expect(batchSet).not.toHaveBeenCalled();
    });

    it("with no FMP adapter, the single vendor failing is a failure", async () => {
      const { refresh } = await grab({
        fmp: null,
        polygon: async () => {
          throw new Error("polygon down");
        },
      });
      await expect(refresh({})).rejects.toThrow("every news vendor failed");
    });
  });

  describe("refreshTickerNews (proactive, when breaking news names the ticker)", () => {
    it("fetches now and waits, through the same cache record as a user read", async () => {
      const { svc, cacheStatus } = setup({});
      cacheStatus.ensureFresh.mockResolvedValue({
        kind: "refreshed",
        ok: true,
      });

      const out = await svc.refreshTickerNews("NVDA");

      expect(out).toEqual({ kind: "refreshed", ok: true });
      expect(cacheStatus.ensureFresh).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "news:ticker:NVDA",
          ttlMs: 24 * 3600_000,
          awaitRefresh: true,
          hasData: true,
        }),
      );
    });

    it("expires at the next New York midnight whatever time it is fetched", async () => {
      const { svc, cacheStatus } = setup({});
      cacheStatus.ensureFresh.mockResolvedValue({ kind: "fresh" });
      await svc.refreshTickerNews("NVDA");
      const { expiresAtFor } = cacheStatus.ensureFresh.mock.calls[0][0];

      // 17:00 EST and 09:00 EST on 11 Nov both expire at 00:00 EST on 12 Nov.
      const midnight = Date.parse("2026-11-12T05:00:00Z");
      expect(expiresAtFor(Date.parse("2026-11-11T22:00:00Z"))).toBe(midnight);
      expect(expiresAtFor(Date.parse("2026-11-11T14:00:00Z"))).toBe(midnight);
    });

    it("the user read and the proactive refresh share one definition of the cache", async () => {
      const a = setup({ storedDocs: [stored("a", "2026-11-11T10:00:00Z")] });
      a.cacheStatus.ensureFresh.mockResolvedValue({ kind: "fresh" });
      await a.svc.getNews("NVDA");
      const user = a.cacheStatus.ensureFresh.mock.calls[0][0];

      const b = setup({});
      b.cacheStatus.ensureFresh.mockResolvedValue({ kind: "fresh" });
      await b.svc.refreshTickerNews("NVDA");
      const proactive = b.cacheStatus.ensureFresh.mock.calls[0][0];

      expect(proactive).toMatchObject({
        key: user.key,
        ttlMs: user.ttlMs,
        location: user.location,
        expiresAtFor: user.expiresAtFor,
      });
      expect(user.awaitRefresh).toBe(false); // a user is never made to wait
      expect(proactive.awaitRefresh).toBe(true);
    });

    it("fetches the vendors and stores the articles when it runs the refresh", async () => {
      const { svc, cacheStatus, docs } = setup({
        polygon: async () => ({ data: [] }),
        fmp: async () => ({ data: [art("f1", "2026-11-11T10:00:00Z")] }),
      });
      cacheStatus.ensureFresh.mockImplementation(async (o: any) => {
        await o.refresh({});
        return { kind: "refreshed", ok: true };
      });

      await svc.refreshTickerNews("NVDA");

      expect(docs).toHaveLength(1);
      expect(docs[0].id).toBe("NVDA_f1");
    });
  });

  it("does not remember an empty answer", async () => {
    const { svc, cacheStatus } = setup({});
    cacheStatus.ensureFresh.mockResolvedValue({
      kind: "first-fill-in-progress",
    });

    expect(await svc.getNews("NVDA")).toEqual([]);
    expect(await svc.getNews("NVDA")).toEqual([]);
    expect(cacheStatus.ensureFresh).toHaveBeenCalledTimes(2); // not short-circuited by memory
  });

  it("a short memory copy stops repeat reads within 5 minutes", async () => {
    const { svc, cacheStatus } = setup({
      storedDocs: [stored("a", "2026-11-11T10:00:00Z")],
    });
    cacheStatus.ensureFresh.mockResolvedValue({ kind: "fresh" });

    await svc.getNews("NVDA");
    await svc.getNews("NVDA");

    expect(cacheStatus.ensureFresh).toHaveBeenCalledTimes(1);
  });
});
