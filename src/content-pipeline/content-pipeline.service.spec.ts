// The real blog service pulls in ESM-only `marked`; the tests pass their own fake.
jest.mock("../blogs/blogs-admin.service", () => ({
  BlogsAdminService: class {},
}));

import { ContentPipelineService } from "./content-pipeline.service";
import {
  WriterKeyMissingError,
  WriterOutputError,
} from "./blog-writer.service";
import type { BlogArticle } from "./blog-article";

/** Just enough of Firestore for the service: collections of plain docs. */
function fakeFirestore() {
  const data = new Map<string, Map<string, Record<string, unknown>>>();
  let n = 0;
  const col = (name: string) => {
    if (!data.has(name)) data.set(name, new Map());
    const docs = data.get(name);
    const docRef = (id: string) => ({
      id,
      get: async () => ({ exists: docs.has(id), id, data: () => docs.get(id) }),
      set: async (v: Record<string, unknown>, opts?: { merge?: boolean }) => {
        docs.set(
          id,
          opts?.merge ? { ...(docs.get(id) ?? {}), ...v } : { ...v },
        );
      },
    });
    const snapOf = (entries: [string, Record<string, unknown>][]) => ({
      docs: entries.map(([id, v]) => ({ id, data: () => v })),
    });
    return {
      doc: (id?: string) => docRef(id ?? `id${++n}`),
      where: (field: string, _op: string, value: unknown) => ({
        get: async () =>
          snapOf([...docs].filter(([, v]) => v[field] === value)),
      }),
      orderBy: (field: string, dir: string) => ({
        limit: (k: number) => ({
          get: async () =>
            snapOf(
              [...docs]
                .sort(
                  ([, a], [, b]) =>
                    String(a[field]).localeCompare(String(b[field])) *
                    (dir === "desc" ? -1 : 1),
                )
                .slice(0, k),
            ),
        }),
      }),
    };
  };
  return {
    data,
    firestore: {
      collection: col,
      runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          get: (ref: { get: () => Promise<unknown> }) => ref.get(),
          set: (
            ref: { set: (v: unknown, o: unknown) => Promise<void> },
            v: unknown,
            o: unknown,
          ) => void ref.set(v, o),
        }),
    },
  };
}

const article: BlogArticle = {
  title: "Lucid's Robotaxi Milestone",
  dek: "Wall Street cut its forecast.",
  intro: "Intro.",
  stats: [{ num: "$1", label: "Seaport target", tone: "down" }],
  sections: [
    {
      heading: "Upside",
      paragraphs: ["Text."],
      tableHeaders: [],
      tableRows: [],
    },
  ],
  watch: "The launch.",
  readMinutes: 3,
};

function setup(opts: { enabled?: boolean; write?: jest.Mock } = {}) {
  const fs = fakeFirestore();
  const blogs = {
    create: jest.fn(async () => ({ id: "post1" })),
    update: jest.fn(async () => ({ id: "post1" })),
  };
  const pulse = {
    create: jest.fn(async () => ({
      id: "p1",
      createdAt: "2026-11-25T15:00:00.000Z",
    })),
  };
  const writer = {
    enabled: opts.enabled ?? true,
    model: "claude-opus-5-5",
    write:
      opts.write ??
      jest.fn(async () => ({ article, model: "claude-opus-5-5" })),
  };
  const queue = { wake: jest.fn(async () => true) };
  const svc = new ContentPipelineService(
    { firestore: fs.firestore } as never,
    blogs as never,
    pulse as never,
    writer as never,
    queue as never,
  );
  return { svc, fs, blogs, pulse, writer, queue };
}

const blogBody = {
  blog: { section: "News", notes: "Lucid notes", tickers: "LCID" },
};

describe("ContentPipelineService", () => {
  it("posts Pulse and Live Feed at once and queues the blog item", async () => {
    const { svc, fs, pulse, queue } = setup();
    const { items } = await svc.submit(
      {
        ...blogBody,
        pulse: { header: "NVDA up", body: "After hours.", ticker: "NVDA" },
        feed: { header: "Lucid", body: "Summary\n* Progress: driverless" },
      },
      "admin@marketcatalyst.ai",
    );
    expect(items.map((i) => [i.kind, i.status])).toEqual([
      ["pulse", "posted"],
      ["feed", "posted"],
      ["blog", "queued"],
    ]);
    expect(pulse.create).toHaveBeenCalledWith(
      { text: "**NVDA up**\n\nAfter hours.", ticker: "NVDA" },
      undefined,
      { unlimited: true },
    );
    const feedPost = [...fs.data.get("live_feed_posts").values()][0];
    expect(feedPost).toMatchObject({
      header: "Lucid",
      summary: "Summary",
      bullets: [{ label: "Progress:", text: "driverless" }],
    });
    expect(queue.wake).toHaveBeenCalledTimes(1);
  });

  it("writes a queued item into a draft and waits for review, then approval publishes it", async () => {
    const { svc, blogs } = setup();
    const { items } = await svc.submit(blogBody, "admin");
    const id = items[0].id;
    expect(await svc.processQueue()).toMatchObject({
      written: 1,
      failed: 0,
      waiting: 0,
    });
    expect(blogs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        zone: "news",
        kick: "News",
        status: "draft",
        title: article.title,
      }),
    );
    expect((await svc.get(id)).item.status).toBe("review");
    const approved = await svc.approve(id);
    expect(approved.status).toBe("posted");
    expect(blogs.update).toHaveBeenCalledWith(
      "post1",
      expect.objectContaining({ status: "published" }),
    );
  });

  it("send-back rewrites the same draft with the editor's note", async () => {
    const write = jest.fn(async () => ({ article, model: "m" }));
    const { svc, blogs } = setup({ write });
    const id = (await svc.submit(blogBody, "admin")).items[0].id;
    await svc.processQueue();
    await svc.sendBack(id, "Lead with the Seaport call");
    await svc.processQueue();
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reviewNote: "Lead with the Seaport call",
        previous: article,
      }),
    );
    expect(blogs.create).toHaveBeenCalledTimes(1);
    expect(blogs.update).toHaveBeenCalledWith(
      "post1",
      expect.objectContaining({ status: "draft" }),
    );
  });

  it("marks an item failed after three bad attempts", async () => {
    const write = jest.fn(async () => {
      throw new WriterOutputError("bad output");
    });
    const { svc } = setup({ write });
    const id = (await svc.submit(blogBody, "admin")).items[0].id;
    expect(await svc.processQueue()).toMatchObject({ failed: 1 });
    expect(write).toHaveBeenCalledTimes(3);
    const { item } = await svc.get(id);
    expect(item).toMatchObject({ status: "failed", error: "bad output" });
  });

  it("leaves items queued with a clear note while the AI key is missing", async () => {
    const write = jest.fn(async () => {
      throw new WriterKeyMissingError();
    });
    const { svc, queue } = setup({ enabled: false, write });
    const id = (await svc.submit(blogBody, "admin")).items[0].id;
    expect(queue.wake).not.toHaveBeenCalled();
    expect(await svc.processQueue()).toMatchObject({
      status: "no-ai-key",
      waiting: 1,
    });
    expect(write).not.toHaveBeenCalled();
    expect((await svc.get(id)).item).toMatchObject({
      status: "queued",
      note: expect.stringContaining("ANTHROPIC_API_KEY"),
    });
  });

  it("only approves an item that is waiting for review", async () => {
    const { svc } = setup();
    const id = (await svc.submit(blogBody, "admin")).items[0].id;
    await expect(svc.approve(id)).rejects.toThrow(/waiting for review/);
  });
});
