import { blogSlug } from "./blog-slug";
import { resolvePostLinks, type SlugIndex } from "./post-links";

// Shapes from the Broken Link Map: a title longer than the slug limit.
const LONG_TITLE =
  "Nasdaq Sinks 4% as the AI Sell-Off Returns, Pushing Anthropic Below Its $83 IPO Price";
const FULL =
  "nasdaq-sinks-4-as-the-ai-sell-off-returns-pushing-anthropic-below-its-83-ipo-price";
const LIVE = blogSlug(LONG_TITLE);

const index: SlugIndex = new Map([
  [LIVE, { published: true }],
  ["short-and-live", { published: true }],
  ["a-draft-post", { published: false }],
]);

describe("resolvePostLinks (B-01)", () => {
  it("the live slug is the title cut between words", () => {
    expect(LIVE).not.toBe(FULL);
    expect(FULL.startsWith(LIVE)).toBe(true);
  });

  it("keeps links that already point at a live post", () => {
    const html = `<a href="https://marketcatalyst.ai/posts/short-and-live">x</a>`;
    expect(resolvePostLinks(html, index, blogSlug)).toEqual({
      html,
      rewritten: [],
      dead: [],
    });
  });

  it("rewrites a full-length slug to the slug the post is served at", () => {
    const r = resolvePostLinks(
      `<a class="card" href="https://marketcatalyst.ai/posts/${FULL}">Read</a>`,
      index,
      blogSlug,
    );
    expect(r.html).toBe(
      `<a class="card" href="https://marketcatalyst.ai/posts/${LIVE}">Read</a>`,
    );
    expect(r.rewritten).toEqual([{ from: FULL, to: LIVE }]);
    expect(r.dead).toEqual([]);
  });

  it("handles relative and www links and keeps a fragment", () => {
    const r = resolvePostLinks(
      `<a href='/posts/${FULL}#scorecard'>a</a> <a href="https://www.marketcatalyst.ai/posts/${FULL}/">b</a>`,
      index,
      blogSlug,
    );
    expect(r.html).toContain(`href='/posts/${LIVE}#scorecard'`);
    expect(r.html).toContain(
      `href="https://www.marketcatalyst.ai/posts/${LIVE}/"`,
    );
  });

  it("reports links to drafts, removed or unknown posts", () => {
    const html = `<a href="/posts/a-draft-post">d</a><a href="https://marketcatalyst.ai/posts/never-existed">n</a>`;
    expect(resolvePostLinks(html, index, blogSlug).dead).toEqual([
      "/posts/a-draft-post",
      "https://marketcatalyst.ai/posts/never-existed",
    ]);
  });

  it("ignores the listing and other sites", () => {
    const html = `<a href="https://marketcatalyst.ai/posts">all</a><a href="https://example.org/posts/x">x</a>`;
    expect(resolvePostLinks(html, index, blogSlug).dead).toEqual([]);
  });
});
