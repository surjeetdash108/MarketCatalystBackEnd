/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  CACHE_STATUS_COLLECTION,
  CacheStatusService,
  DEFAULT_FAILURE_BACKOFF_MS,
  DEFAULT_RECOVERY_MS,
  type EnsureOptions,
} from "./cache-status.service";
import type { FirebaseAdminService } from "./firebase-admin.provider";

class FakeSnap {
  constructor(private readonly d: any) {}
  get exists() {
    return this.d !== undefined;
  }
  data() {
    return this.d === undefined
      ? undefined
      : JSON.parse(JSON.stringify(this.d));
  }
}
class FakeRef {
  constructor(
    private readonly fs: FakeFirestore,
    readonly path: string,
  ) {}
  async get() {
    await new Promise((r) => setImmediate(r));
    if (this.fs.down) throw new Error("firestore unavailable");
    return new FakeSnap(this.fs.store.get(this.path));
  }
}
class FakeFirestore {
  store = new Map<string, any>();
  down = false;
  private queue: Promise<unknown> = Promise.resolve();
  collection(name: string) {
    return { doc: (id: string) => new FakeRef(this, `${name}/${id}`) };
  }
  async getAll(...refs: FakeRef[]) {
    if (this.down) throw new Error("firestore unavailable");
    return refs.map((r) => new FakeSnap(this.store.get(r.path)));
  }
  runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.down) throw new Error("firestore unavailable");
      const writes: Array<[string, any]> = [];
      const tx = {
        get: async (ref: FakeRef) => new FakeSnap(this.store.get(ref.path)),
        set: (ref: FakeRef, data: any) => {
          writes.push([ref.path, data]);
        },
      };
      const out = await fn(tx);
      for (const [p, d] of writes)
        this.store.set(p, JSON.parse(JSON.stringify(d)));
      return out;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  doc(key: string) {
    return this.store.get(`${CACHE_STATUS_COLLECTION}/${key}`);
  }
}

class TestService extends CacheStatusService {
  t = 1_000_000;
  protected now(): number {
    return this.t;
  }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

const KEY = "news:breaking";
const TTL = 15 * 60_000;

function setup() {
  const fs = new FakeFirestore();
  const svc = new TestService({
    firestore: fs,
  } as unknown as FirebaseAdminService);
  const opts = (refresh: EnsureOptions["refresh"]): EnsureOptions => ({
    key: KEY,
    location: "news",
    ttlMs: TTL,
    refresh,
  });
  const fill = async (watermark: string | null = null) => {
    await svc.ensureFresh(opts(async () => ({ watermark })));
  };
  return { fs, svc, opts, fill };
}

describe("CacheStatusService.ensureFresh", () => {
  it("first ever call: AWAITS the refresh and stores a valid copy", async () => {
    const { fs, svc, opts } = setup();
    const refresh = jest.fn(async () => ({ watermark: "W1" }));

    const out = await svc.ensureFresh(opts(refresh));

    expect(out).toEqual({ kind: "first-fill", ok: true, error: undefined });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({
      previousWatermark: null,
      lastFetchedAt: null,
    });
    expect(fs.doc(KEY)).toMatchObject({
      name: KEY,
      location: "news",
      status: "valid",
      ttlMs: TTL,
      lastFetchedAt: svc.t,
      expiresAt: svc.t + TTL,
      watermark: "W1",
      fetchingSince: null,
      fetchOwner: null,
      lastError: null,
    });
  });

  it("inside the TTL: does nothing", async () => {
    const { svc, opts, fill } = setup();
    await fill();
    svc.t += TTL - 1;
    const refresh = jest.fn(async () => undefined);

    expect(await svc.ensureFresh(opts(refresh))).toEqual({ kind: "fresh" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("TTL passed: sets `fetching` BEFORE calling the provider, returns without waiting, then goes valid", async () => {
    const { fs, svc, opts, fill } = setup();
    await fill();
    svc.t += TTL + 1;
    const claimedAt = svc.t;
    const gate = deferred();
    let statusSeenByRefresh: string | undefined;
    const refresh = jest.fn(async () => {
      statusSeenByRefresh = fs.doc(KEY).status;
      await gate.promise;
      return { watermark: "W2" };
    });

    const out = await svc.ensureFresh(opts(refresh));

    expect(out).toEqual({ kind: "refresh-started" });
    expect(fs.doc(KEY).status).toBe("fetching");
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(statusSeenByRefresh).toBe("fetching");

    gate.resolve();
    await flush();
    expect(fs.doc(KEY)).toMatchObject({
      status: "valid",
      lastFetchedAt: claimedAt,
      expiresAt: claimedAt + TTL,
      watermark: "W2",
      fetchOwner: null,
    });
  });

  it("TTL passed while another request is fetching: does not fetch", async () => {
    const { svc, opts, fill } = setup();
    await fill();
    svc.t += TTL + 1;
    const gate = deferred();
    await svc.ensureFresh(opts(() => gate.promise));
    const second = jest.fn(async () => undefined);

    svc.t += 60_000;
    expect(await svc.ensureFresh(opts(second))).toEqual({
      kind: "already-fetching",
    });
    expect(second).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
  });

  it("20 simultaneous requests after expiry: exactly ONE refresh", async () => {
    const { svc, opts, fill } = setup();
    await fill();
    svc.t += TTL + 1;
    const gate = deferred();
    const refresh = jest.fn(() => gate.promise);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => svc.ensureFresh(opts(refresh))),
    );
    await flush();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.kind === "refresh-started")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "already-fetching")).toHaveLength(
      19,
    );
    gate.resolve();
    await flush();
  });

  it("10 simultaneous requests on an EMPTY cache: one waits and fills, the rest are not blocked", async () => {
    const { fs, svc, opts } = setup();
    const gate = deferred();
    const refresh = jest.fn(async () => {
      await gate.promise;
    });

    const all = Array.from({ length: 10 }, () =>
      svc.ensureFresh(opts(refresh)),
    );
    await flush();
    gate.resolve();
    const results = await Promise.all(all);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.kind === "first-fill")).toHaveLength(1);
    expect(
      results.filter((r) => r.kind === "first-fill-in-progress"),
    ).toHaveLength(9);
    expect(fs.doc(KEY).status).toBe("valid");
  });

  describe("recovery from a lost refresh", () => {
    it("stuck in `fetching` for under 15 min: left alone. Over 15 min: started again", async () => {
      const { svc, opts, fill } = setup();
      await fill();
      svc.t += TTL + 1;
      const lost = deferred();
      await svc.ensureFresh(opts(() => lost.promise));

      svc.t += DEFAULT_RECOVERY_MS - 1;
      const early = jest.fn(async () => undefined);
      expect(await svc.ensureFresh(opts(early))).toEqual({
        kind: "already-fetching",
      });
      expect(early).not.toHaveBeenCalled();

      svc.t += 1;
      const retry = jest.fn(async () => ({ watermark: "RETRY" }));
      expect(await svc.ensureFresh(opts(retry))).toEqual({
        kind: "refresh-started",
      });
      await flush();
      expect(retry).toHaveBeenCalledTimes(1);
      lost.resolve();
      await flush();
    });

    it("the lost refresh finishing late does not overwrite the retry's result", async () => {
      const { fs, svc, opts, fill } = setup();
      await fill();
      svc.t += TTL + 1;
      const lost = deferred<{ watermark: string }>();
      await svc.ensureFresh(opts(() => lost.promise));

      svc.t += DEFAULT_RECOVERY_MS;
      await svc.ensureFresh(opts(async () => ({ watermark: "RETRY" })));
      await flush();
      expect(fs.doc(KEY)).toMatchObject({
        status: "valid",
        watermark: "RETRY",
      });

      lost.resolve({ watermark: "LATE" });
      await flush();
      expect(fs.doc(KEY)).toMatchObject({
        status: "valid",
        watermark: "RETRY",
      });
    });
  });

  describe("failures", () => {
    it("a failed background refresh is recorded as `failed`, and never escapes as an unhandled rejection", async () => {
      const { fs, svc, opts, fill } = setup();
      await fill();
      svc.t += TTL + 1;
      const unhandled = jest.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const out = await svc.ensureFresh(
          opts(async () => {
            throw new Error("FMP 500");
          }),
        );
        await flush();

        expect(out).toEqual({ kind: "refresh-started" });
        expect(fs.doc(KEY)).toMatchObject({
          status: "failed",
          lastError: "FMP 500",
          fetchOwner: null,
        });
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });

    it("waits the backoff before retrying a failed refresh, then retries", async () => {
      const { svc, opts, fill } = setup();
      await fill();
      svc.t += TTL + 1;
      await svc.ensureFresh(
        opts(async () => {
          throw new Error("down");
        }),
      );
      await flush();

      const early = jest.fn(async () => undefined);
      svc.t += DEFAULT_FAILURE_BACKOFF_MS - 1;
      expect(await svc.ensureFresh(opts(early))).toEqual({
        kind: "failed-backoff",
      });
      expect(early).not.toHaveBeenCalled();

      svc.t += 1;
      const retry = jest.fn(async () => undefined);
      expect(await svc.ensureFresh(opts(retry))).toEqual({
        kind: "refresh-started",
      });
      await flush();
      expect(retry).toHaveBeenCalledTimes(1);
    });

    it("first fill that fails reports it and can be retried after the backoff", async () => {
      const { fs, svc, opts } = setup();
      const out = await svc.ensureFresh(
        opts(async () => {
          throw new Error("no data");
        }),
      );

      expect(out).toEqual({ kind: "first-fill", ok: false, error: "no data" });
      expect(fs.doc(KEY).status).toBe("failed");

      svc.t += DEFAULT_FAILURE_BACKOFF_MS;
      const retry = jest.fn(async () => undefined);
      expect((await svc.ensureFresh(opts(retry))).kind).toBe("first-fill");
      expect(fs.doc(KEY).status).toBe("valid");
    });

    it("Firestore down: returns `unavailable`, does not throw, does not call the provider", async () => {
      const { fs, svc, opts } = setup();
      fs.down = true;
      const refresh = jest.fn(async () => undefined);

      const out = await svc.ensureFresh(opts(refresh));

      expect(out.kind).toBe("unavailable");
      expect(refresh).not.toHaveBeenCalled();
    });
  });

  describe("awaitRefresh (scheduled jobs: wait, because the process may end first)", () => {
    it("expired: runs the refresh to completion BEFORE returning", async () => {
      const { fs, svc, opts, fill } = setup();
      await fill();
      svc.t += TTL + 1;
      const gate = deferred();
      const refresh = jest.fn(async () => {
        await gate.promise;
        return { watermark: "JOB" };
      });

      let done = false;
      const call = svc
        .ensureFresh({ ...opts(refresh), awaitRefresh: true })
        .then((o) => {
          done = true;
          return o;
        });
      await flush();
      expect(done).toBe(false);
      expect(fs.doc(KEY).status).toBe("fetching");

      gate.resolve();
      expect(await call).toEqual({
        kind: "refreshed",
        ok: true,
        error: undefined,
      });
      expect(fs.doc(KEY)).toMatchObject({ status: "valid", watermark: "JOB" });
    });

    it("a request that arrives meanwhile still does not wait", async () => {
      const { svc, opts, fill } = setup();
      await fill();
      svc.t += TTL + 1;
      const gate = deferred();
      const waiting = svc.ensureFresh({
        ...opts(() => gate.promise),
        awaitRefresh: true,
      });
      await flush();

      const other = await svc.ensureFresh({
        ...opts(async () => undefined),
        awaitRefresh: true,
      });

      expect(other).toEqual({ kind: "already-fetching" });
      gate.resolve();
      await waiting;
    });

    it("a failed refresh is reported, not thrown", async () => {
      const { svc, opts, fill } = setup();
      await fill();
      svc.t += TTL + 1;
      const out = await svc.ensureFresh({
        ...opts(async () => {
          throw new Error("vendor down");
        }),
        awaitRefresh: true,
      });
      expect(out).toEqual({
        kind: "refreshed",
        ok: false,
        error: "vendor down",
      });
    });

    it("inside the TTL: nothing to wait for", async () => {
      const { svc, opts, fill } = setup();
      await fill();
      const refresh = jest.fn(async () => undefined);
      expect(
        await svc.ensureFresh({ ...opts(refresh), awaitRefresh: true }),
      ).toEqual({ kind: "fresh" });
      expect(refresh).not.toHaveBeenCalled();
    });
  });

  describe("hasData (a cron already stored data, but this key has no status doc yet)", () => {
    it("does NOT make the first request wait: refresh runs in the background", async () => {
      const { fs, svc, opts } = setup();
      const gate = deferred();
      const refresh = jest.fn(() => gate.promise);

      const out = await svc.ensureFresh({ ...opts(refresh), hasData: true });

      expect(out).toEqual({ kind: "refresh-started" });
      expect(fs.doc(KEY).status).toBe("fetching");
      gate.resolve();
      await flush();
      expect(fs.doc(KEY).status).toBe("valid");
    });

    it("a hasData function is only asked when the key was never filled", async () => {
      const { svc, opts, fill } = setup();
      const probe = jest.fn(async () => true);

      await svc.ensureFresh({ ...opts(async () => undefined), hasData: probe });
      await flush();
      expect(probe).toHaveBeenCalledTimes(1);

      svc.t += TTL + 1;
      await svc.ensureFresh({ ...opts(async () => undefined), hasData: probe });
      await flush();
      expect(probe).toHaveBeenCalledTimes(1);
      void fill;
    });

    it("a hasData probe that throws counts as no data (first fill waits)", async () => {
      const { svc, opts } = setup();
      const out = await svc.ensureFresh({
        ...opts(async () => undefined),
        hasData: async () => {
          throw new Error("probe failed");
        },
      });
      expect(out.kind).toBe("first-fill");
    });
  });

  describe("expireIfOlderThan (breaking news says a ticker's detail news is out of date)", () => {
    const keyOf = (t: string) => `news:ticker:${t}`;
    const fillKey = async (svc: TestService, key: string) => {
      await svc.ensureFresh({
        key,
        location: "news",
        ttlMs: 24 * 3600_000,
        refresh: async () => undefined,
      });
    };

    it("expires only valid keys last fetched before the new data; leaves the rest", async () => {
      const { fs, svc } = setup();
      await fillKey(svc, keyOf("NVDA"));
      const fetchedAt = svc.t;
      svc.t += 60_000;
      await fillKey(svc, keyOf("AAPL"));
      const storyAt = fetchedAt + 30_000;

      const n = await svc.expireIfOlderThan([
        { key: keyOf("NVDA"), dataNewerThan: storyAt }, // older fetch -> expire
        { key: keyOf("AAPL"), dataNewerThan: storyAt }, // newer fetch -> keep
        { key: keyOf("MRNA"), dataNewerThan: storyAt }, // never fetched -> leave
      ]);

      expect(n).toEqual([keyOf("NVDA")]);
      expect(fs.doc(keyOf("NVDA")).expiresAt).toBe(svc.t);
      expect(fs.doc(keyOf("NVDA")).status).toBe("valid");
      expect(fs.doc(keyOf("AAPL")).expiresAt).toBeGreaterThan(svc.t);
      expect(fs.doc(keyOf("MRNA"))).toBeUndefined();
    });

    it("the next request for an expired key refreshes it in the background", async () => {
      const { svc } = setup();
      await fillKey(svc, keyOf("NVDA"));
      await svc.expireIfOlderThan([
        { key: keyOf("NVDA"), dataNewerThan: svc.t + 1 },
      ]);
      const refresh = jest.fn(async () => undefined);

      const out = await svc.ensureFresh({
        key: keyOf("NVDA"),
        location: "news",
        ttlMs: 24 * 3600_000,
        refresh,
      });
      await flush();

      expect(out).toEqual({ kind: "refresh-started" });
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("does not touch a key that is being fetched or has failed", async () => {
      const { fs, svc } = setup();
      await fillKey(svc, keyOf("NVDA"));
      svc.t += 24 * 3600_000 + 1;
      const gate = deferred();
      await svc.ensureFresh({
        key: keyOf("NVDA"),
        location: "news",
        ttlMs: 24 * 3600_000,
        refresh: () => gate.promise,
      });
      const before = JSON.stringify(fs.doc(keyOf("NVDA")));

      expect(
        await svc.expireIfOlderThan([
          { key: keyOf("NVDA"), dataNewerThan: svc.t + 1 },
        ]),
      ).toEqual([]);
      expect(JSON.stringify(fs.doc(keyOf("NVDA")))).toBe(before);
      gate.resolve();
      await flush();
    });

    it("never throws when Firestore is down", async () => {
      const { fs, svc } = setup();
      fs.down = true;
      await expect(
        svc.expireIfOlderThan([{ key: "x", dataNewerThan: 1 }]),
      ).resolves.toEqual([]);
    });
  });

  describe("fixed daily expiry (expiresAtFor)", () => {
    const DAY = 24 * 3600_000;
    const HOUR = 3600_000;
    const nextDayStart = (t: number) => (Math.floor(t / DAY) + 1) * DAY;

    it("a fetch at any time of day expires at the next day start, not 24 h later", async () => {
      const { fs, svc } = setup();
      svc.t = 10 * DAY + 17 * HOUR;
      await svc.ensureFresh({
        key: "news:ticker:NVDA",
        location: "news",
        ttlMs: DAY,
        expiresAtFor: nextDayStart,
        refresh: async () => undefined,
      });
      expect(fs.doc("news:ticker:NVDA").expiresAt).toBe(11 * DAY);
    });
  });

  describe("breaking news -> refresh now -> day timer unchanged (end to end)", () => {
    const DAY = 24 * 3600_000;
    const HOUR = 3600_000;
    const nextDayStart = (t: number) => (Math.floor(t / DAY) + 1) * DAY;
    const key = "news:ticker:NVDA";
    const opts = (refresh: EnsureOptions["refresh"]): EnsureOptions => ({
      key,
      location: "news",
      ttlMs: DAY,
      expiresAtFor: nextDayStart,
      refresh,
    });

    it("the stock is refreshed as soon as the story is seen, and still expires at the start of the next day", async () => {
      const { fs, svc } = setup();
      svc.t = 10 * DAY + 9 * HOUR;
      await svc.ensureFresh(opts(async () => undefined));
      const firstExpiry = fs.doc(key).expiresAt;
      expect(firstExpiry).toBe(11 * DAY);

      svc.t = 10 * DAY + 17 * HOUR;
      const storyAt = svc.t - 60_000;
      expect(
        await svc.expireIfOlderThan([{ key, dataNewerThan: storyAt }]),
      ).toEqual([key]);

      const refresh = jest.fn(async () => ({ watermark: "AFTER-STORY" }));
      const out = await svc.ensureFresh({
        ...opts(refresh),
        awaitRefresh: true,
      });

      expect(out.kind).toBe("refreshed");
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(fs.doc(key)).toMatchObject({
        status: "valid",
        lastFetchedAt: svc.t,
        expiresAt: firstExpiry, // still midnight: NOT pushed to 17:00 tomorrow
        watermark: "AFTER-STORY",
      });

      svc.t += HOUR;
      const userRefresh = jest.fn(async () => undefined);
      expect(await svc.ensureFresh(opts(userRefresh))).toEqual({
        kind: "fresh",
      });
      expect(userRefresh).not.toHaveBeenCalled();

      svc.t = 11 * DAY + 8 * HOUR;
      expect(await svc.ensureFresh(opts(userRefresh))).toEqual({
        kind: "refresh-started",
      });
      await flush();
      expect(userRefresh).toHaveBeenCalledTimes(1);
      expect(fs.doc(key).expiresAt).toBe(12 * DAY);
    });

    it("a story older than the last fetch changes nothing", async () => {
      const { fs, svc } = setup();
      const story = svc.t - 5_000;
      await svc.ensureFresh(opts(async () => undefined));
      const before = JSON.stringify(fs.doc(key));

      expect(
        await svc.expireIfOlderThan([{ key, dataNewerThan: story }]),
      ).toEqual([]);
      expect(JSON.stringify(fs.doc(key))).toBe(before);
    });

    it("two things asking at once fetch once: a user opening the page while the proactive refresh runs", async () => {
      const { svc } = setup();
      await svc.ensureFresh(opts(async () => undefined));
      svc.t += 3 * 3600_000;
      await svc.expireIfOlderThan([{ key, dataNewerThan: svc.t - 1000 }]);
      const gate = deferred();
      const proactive = jest.fn(() => gate.promise);
      const waiting = svc.ensureFresh({
        ...opts(proactive),
        awaitRefresh: true,
      });
      await flush();

      const userRefresh = jest.fn(async () => undefined);
      const user = await svc.ensureFresh(opts(userRefresh));

      expect(user).toEqual({ kind: "already-fetching" });
      expect(userRefresh).not.toHaveBeenCalled();
      gate.resolve();
      await waiting;
      expect(proactive).toHaveBeenCalledTimes(1);
    });
  });

  describe("watermark", () => {
    it("is handed to the next refresh, and kept when a refresh does not return one", async () => {
      const { fs, svc, opts, fill } = setup();
      await fill("W1");

      svc.t += TTL + 1;
      const seen = jest.fn(async (_ctx: unknown) => undefined);
      await svc.ensureFresh(opts(seen));
      await flush();

      expect(seen).toHaveBeenCalledWith(
        expect.objectContaining({ previousWatermark: "W1" }),
      );
      expect(fs.doc(KEY).watermark).toBe("W1");
    });
  });
});
