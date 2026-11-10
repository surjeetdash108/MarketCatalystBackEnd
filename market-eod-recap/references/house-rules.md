# MarketCatalyst house rules (owner-stated, apply to every article)

These were set by the blog owner over many sessions. They override anything older in the legacy spec. If a rule changes, edit this file.

## 1. Titles
- **Very catchy**, specific and original. Number-led hooks and named catalysts work well:
  - "4 Things That Could Move Stocks This Week, From Marvell's Big Day to Delta's Fuel Bill"
  - "Nasdaq Closes at a Record as Oil Slides, Yields Climb and PTC Soars 33% on a $22.6 Billion Deal"
  - "Micron Is Stalling on Peak Fears, but Memory Prices Haven't Gotten the Memo"
- Never copy or lightly edit a source headline (Barron's, CNBC, Yahoo…). Write your own.
- Keep ≤110 characters (the schema headline limit people usually follow). Don't put "| MarketCatalyst" in titles.
- The user may supply exact wording for a headline or lead sentence; if so, use it.

## 2. Section labels (eyebrow/kick) and zones
| Section | `zone` | `kick` (eyebrow) | Related-card pill |
|---|---|---|---|
| EOD / weekly recaps | `recap` | `Recap` | Recap |
| Research Desk analysis | `research` | `Research Desk` | Analysis |
| News | `news` | `News` | News |
| Educational | `edu` | `Educational` | Educational |

The eyebrow is the section name only (older posts used "MarketCatalyst" or "BE" — don't).

## 3. Header block
- **No byline.** Never pass `author` (it renders as "Desk"); leave it empty.
- The `read` field holds the date line and read time, rendered on one line directly above the separator:
  - Draft: `Published Oct 5, 2026 · 10 min read`
  - After publishing (exact CMS time): `Published Oct 5, 2026 · 4:19 PM ET · 10 min read`
- Do **not** add a separate "Published…" paragraph in the body.
- Tight spacing around the separator via the style override in `assets/cms-snippets.html` (14 px above, 22 px below).
- Never invent a time. Get it from `list_blog_posts` after publishing. If the post goes live after midnight ET, the date changes too (and so does any "on Tuesday" wording in the copy).

## 4. SEO schema (every article)
One `Article` JSON-LD block at the top of the body — **not** FAQPage:
`headline` (= title), `description` (= dek), `image` (`https://marketcatalyst.ai/og-image.jpg`, or the hero image URL when there is one), `author` (Organization "MarketCatalyst"), `publisher` (Organization + `logo` `https://marketcatalyst.ai/logo-mark.webp`), `datePublished`, `dateModified`.
- Draft: date-only. After publish: full ISO with offset, e.g. `2026-10-05T16:19:00-04:00` (use `-05:00` after the November clock change).
- The schema is only one SEO factor. Don't tell the user it is "all that's needed"; mention indexing, internal links, page-level meta tags, and that the `/posts` index can be cached for a while.
- You can't see the live page's raw HTML from the sandbox, so say what you verified (saved page) and what you couldn't (live rendering, possible duplicate schema).

## 5. Related articles — "Readers also read"
- Heading is exactly **Readers also read**. Four compact cards in one row (2×2 on phones): section pill, title, read time, "Read →". Markup/CSS in `assets/cms-snippets.html`.
- Placed after the closing callout/takeaway and before the disclaimer.
- **Use verified URLs only.** Slugs are usually the title in lowercase with punctuation dropped and apostrophes becoming `-s-`, but older retitled posts differ, so never guess. Ask the user for URLs, or use the verified list below. Don't link an article to itself. Pick topically close items (AI/chips for AI stories, recaps for recaps).
- Verified as of Oct 6, 2026 (all under `https://marketcatalyst.ai/posts/`):

| Slug | Title | Pill | Read |
|---|---|---|---|
| `nasdaq-rallies-to-a-record-as-a-weak-jobs-report-eases-rate-hike-fears` | Nasdaq Rallies to a Record as a Weak Jobs Report Eases Rate-Hike Fears | Recap | 9 min |
| `week-ahead-fed-minutes-five-fed-speakers-and-the-first-big-earnings-of-q3-season` | Week Ahead: Fed Minutes, Five Fed Speakers and the First Big Earnings of Q3 Season | Recap | 7 min |
| `nvidia-deepens-its-coreweave-bet-as-the-neocloud-s-backlog-hits-104-billion` | Nvidia Deepens Its CoreWeave Bet as the Neocloud's Backlog Hits $104 Billion | Analysis | 6 min |
| `wall-street-piles-into-micron-after-a-blowout-quarter-here-s-who-raised-targets` | Wall Street Piles Into Micron as the AI Memory "Hypercycle" Fuels a Blowout Quarter | Analysis | 4 min |
| `cerebras-falls-below-its-ipo-price-as-an-openai-scare-collides-with-insider-selling` | Cerebras Falls Below Its IPO Price as an OpenAI Scare Collides With Insider Selling | Analysis | 5 min |
| `synopsys-pairs-an-openai-chip-design-deal-with-a-bold-2030-growth-plan` | Synopsys Pairs an OpenAI Chip-Design Deal With a Bold 2030 Growth Plan | Analysis | 4 min |
| `crowdstrike-hits-an-all-time-high-what-s-behind-the-ai-security-rally` | CrowdStrike Hits an All-Time High: What's Behind the AI Security Rally | Analysis | 5 min |
| `understanding-candlestick-charts-a-professional-framework-for-price-action-and-volume` | Understanding Candlestick Charts: A Professional Framework for Price Action and Volume | Educational | 13 min |
| `what-is-ohlc-in-trading` | How to Read and Interpret OHLC Data in Technical Analysis | Educational | 8 min |
| `support-vs-resistance-how-to-read-price-floors-and-ceilings` | Support vs. Resistance: How to Read Price Floors and Ceilings | Educational | 6 min |
| `trending-vs-range-bound-stocks` | Analyzing Chart Structure: Breakouts, Failures, and Liquidity Traps | Educational | 7 min |

New articles join this list once the user confirms their URL.

## 6. Colors and number formatting
- Up/positive numbers **green**, down/negative numbers **red**, everywhere (index tiles, tables, cards).
  - Tables: `class="pos"` for gains (site-supported); `class="dn"` for losses (defined by our own CSS — the site has no red table class).
  - Index tiles: green when up; if an index is down, make that tile red individually. On a down day most tiles are red.
  - Neutral readings that "rise" without being a gain/loss (VIX, Treasury yield) stay plain.
- Use a minus sign for losses (`-0.48%`), plus sign for gains (`+0.67%`).

## 7. Recap-specific layout choices
- **Sectors** = two side-by-side tinted cards (green "▲ Leading groups", red "▼ Lagging groups"), 3–4 items each, each item = ticker + % + one-line reason. Items in "Lagging" may be the weakest group even if slightly positive; say so in the text (e.g. "barely higher").
- **Driver story titles are bold**: `<h3><strong>1. Title</strong></h3>` (the site stylesheet doesn't style `h3`; the snippet CSS sizes it).
- **Four index tiles in one row** (Dow, S&P 500, Nasdaq, Russell 2000) using the `#idx-strip` CSS (the default grid wraps 3+1).
- **No** earnings-spotlight section, **no** FAQ section, **no** TOC, **no** breadth section unless real breadth data exists. Upcoming earnings go in the "What to watch next" table only.
- Dividers/boxes use only supported classes (`callout`, `warning`, tables) or our own scoped CSS.

## 8. Voice and honesty
- Crisp, analytical, paragraph-driven; explain *why* a move mattered. No hype, no trade directives.
- Plain language in replies to the user: what you did, what you couldn't verify, where you departed from their source, which assumptions you made.
- When the user's source says something you couldn't verify, leave it out and tell them (examples that were dropped: unsourced TAM figures, an unverifiable "first investor day since…" claim).
- Fix your own errors openly and promptly (e.g. a timestamp you wrote that didn't match the CMS).

## 9. Other standing preferences
- Blog index cards and article header show the `read` text; the date line lives there.
- Publishing is always **after the user approves a preview**. "Publish this" on something already live → check the CMS status and say it's already published; don't re-publish (duplicate risk).
- Images: crop and compress to a small WebP before uploading (see `cms-publishing.md`).
