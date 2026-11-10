import { SETTLE_MS, WebSubPingJob } from "./websub-ping.job";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const SETTLED = NOW - SETTLE_MS;
const CURSOR = NOW - 60 * 60_000;

function makeJob(opts: { cursor: number; docs?: Array<{ status: string }> }) {
  const where = jest.fn();
  const query: any = {
    where: where.mockImplementation(() => query),
    select: jest.fn(() => query),
    get: jest.fn(async () => ({
      size: (opts.docs ?? []).length,
      docs: (opts.docs ?? []).map((d) => ({ get: (k: string) => (d as any)[k] })),
    })),
  };
  const collection = jest.fn(() => query);
  const firebase = { firestore: { collection } } as any;
  const meta = {
    getCursor: jest.fn(async () => opts.cursor),
    setCursor: jest.fn(async () => undefined),
    record: jest.fn(async () => undefined),
  } as any;
  const registry = { register: jest.fn() } as any;
  return { job: new WebSubPingJob(firebase, meta, registry), where, query, collection, meta, registry };
}

describe("WebSubPingJob", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
    fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    delete process.env.WEBSUB_HUB_URL;
    delete process.env.WEBSUB_FEED_URL;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("registers itself under the manifest name", () => {
    const { job, registry } = makeJob({ cursor: CURSOR });
    job.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(
      "websub-ping",
      expect.any(Function),
      expect.objectContaining({ cronExpression: "*/10 * * * *" }),
    );
  });

  it("only sets a baseline on its first run — nothing is announced", async () => {
    const { job, meta, collection } = makeJob({ cursor: 0 });
    await expect(job.run()).resolves.toEqual({ pinged: false, reason: "baseline" });
    expect(meta.setCursor).toHaveBeenCalledWith("websub-ping", SETTLED);
    expect(collection).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks for posts published after the watermark and at least SETTLE_MS ago", async () => {
    const { job, where, collection } = makeJob({ cursor: CURSOR, docs: [] });
    await job.run();
    expect(collection).toHaveBeenCalledWith("posts");
    const bounds = where.mock.calls.map(([field, op, ts]) => [field, op, ts.toMillis()]);
    expect(bounds).toEqual([
      ["publishedAt", ">", CURSOR],
      ["publishedAt", "<=", SETTLED],
    ]);
  });

  it("pings the hub once for any number of new posts, then moves the watermark", async () => {
    const { job, meta } = makeJob({ cursor: CURSOR, docs: [{ status: "published" }, { status: "published" }] });
    await expect(job.run()).resolves.toEqual({ pinged: true, fresh: 2 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://pubsubhubbub.appspot.com/");
    expect(init.method).toBe("POST");
    expect(init.body.toString()).toBe(
      "hub.mode=publish&hub.url=https%3A%2F%2Fmarketcatalyst.ai%2Ffeed.xml",
    );
    expect(meta.setCursor).toHaveBeenCalledWith("websub-ping", SETTLED);
    expect(meta.record).toHaveBeenCalledWith("websub-ping", { ok: true, count: 2, docsRead: 2 });
  });

  it("does not ping for posts that are no longer published", async () => {
    const { job, meta } = makeJob({ cursor: CURSOR, docs: [{ status: "draft" }] });
    await expect(job.run()).resolves.toEqual({ pinged: false, fresh: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(meta.setCursor).toHaveBeenCalledWith("websub-ping", SETTLED);
  });

  it("does not ping, but still advances, when nothing new went live", async () => {
    const { job, meta } = makeJob({ cursor: CURSOR, docs: [] });
    await expect(job.run()).resolves.toEqual({ pinged: false, fresh: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(meta.setCursor).toHaveBeenCalledWith("websub-ping", SETTLED);
  });

  it("never moves the watermark backwards", async () => {
    const ahead = NOW + 5 * 60_000;
    const { job, meta } = makeJob({ cursor: ahead, docs: [] });
    await job.run();
    expect(meta.setCursor).toHaveBeenCalledWith("websub-ping", ahead);
  });

  it("keeps the watermark and records an error when the hub refuses, so the next run retries", async () => {
    fetchSpy.mockResolvedValue(new Response("nope", { status: 500 }));
    const { job, meta } = makeJob({ cursor: CURSOR, docs: [{ status: "published" }] });
    await expect(job.run()).rejects.toThrow(/answered 500/);
    expect(meta.setCursor).not.toHaveBeenCalled();
    expect(meta.record).toHaveBeenCalledWith("websub-ping", { ok: false, error: expect.stringContaining("500") });
  });

  it("honours WEBSUB_HUB_URL and WEBSUB_FEED_URL", async () => {
    process.env.WEBSUB_HUB_URL = "https://hub.example/";
    process.env.WEBSUB_FEED_URL = "https://staging.example/feed.xml";
    const { job } = makeJob({ cursor: CURSOR, docs: [{ status: "published" }] });
    await job.run();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://hub.example/");
    expect(init.body.get("hub.url")).toBe("https://staging.example/feed.xml");
  });
});
