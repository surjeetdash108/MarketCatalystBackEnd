import { summarizePosts } from "./blog-list";
import type { BlogAdminView } from "../blogs/blogs-admin.service";

const post = (i: number, status: "Published" | "Draft" = "Published") =>
  ({ id: `p${i}`, slug: `market-recap-${i}`, title: `Market recap ${i}`, status, zone: "recap", author: "MC", date: "", publishedAt: null, createdAt: null, format: "html", heroImageUrl: null, editorsChoice: false, html: "x".repeat(200_000), css: ["y".repeat(50_000)], links: [] }) as unknown as BlogAdminView;

describe("list_blog_posts stays small (Cloud Run 32 MB response limit)", () => {
  const all = Array.from({ length: 400 }, (_, i) => post(i, i % 3 === 0 ? "Draft" : "Published"));

  it("returns a page of summaries without bodies", () => {
    const r = summarizePosts(all);
    expect(r.total).toBe(400);
    expect(r.posts).toHaveLength(25);
    expect(r.posts[0]).not.toHaveProperty("html");
    expect(r.posts[0]).not.toHaveProperty("css");
    expect(JSON.stringify(r).length).toBeLessThan(20_000);
  });

  it("pages, caps at 100, filters by status and title", () => {
    expect(summarizePosts(all, { limit: 1000 }).posts).toHaveLength(100);
    expect(summarizePosts(all, { offset: 395 }).posts.map((p) => p.id)).toEqual(["p395", "p396", "p397", "p398", "p399"]);
    expect(summarizePosts(all, { status: "Draft" }).total).toBe(134);
    expect(summarizePosts(all, { query: "RECAP 39" }).total).toBe(11);
  });

  it("gives each post the slug and url it is served at, so links are never rebuilt from titles (B-01)", () => {
    const r = summarizePosts(all, { limit: 1 });
    expect(r.posts[0]).toMatchObject({ slug: "market-recap-0", url: "https://marketcatalyst.ai/posts/market-recap-0" });
  });
});
