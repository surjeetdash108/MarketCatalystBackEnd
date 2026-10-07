---
name: market-eod-recap
description: Generate a complete, publish-ready end-of-day U.S. stock market recap article for the MarketCatalyst blog (default output: a draft in the CMS "Recap" section via the BlogConnector tools, plus an HTML preview file for review; legacy output: a standalone HTML file from the fixed template). Use this skill whenever the user asks for a "market recap", "EOD recap", "end of day market report", "daily market wrap", "close report", types /market-eod-recap, or asks for today's (or a specified date's) market-close article for the blog — even if they don't mention the CMS, template or HTML. If the person attaches screenshots of index or ETF closing data, treat them as the authoritative source; otherwise research real, current, verified data before writing. Research first, don't ask up front — but if a figure that matters (above all a Movers-table stock's close and % change) can't be verified, stop and ask the user for it instead of guessing or writing "not available at publication". Always apply the MarketCatalyst house rules in references/house-rules.md (catchy original title, Article schema, date line, related-articles block, green/red coloring, no byline/FAQ/earnings-spotlight).
---

# Market EOD Recap Generator (MarketCatalyst)

Produces the end-of-day U.S. market recap as a **CMS draft in the Recap section** (default), then walks it through preview → approval → publish → timestamp fix. Content changes daily; the structure and house style stay fixed.

Read these before writing anything:

| File | What it covers |
|---|---|
| `references/house-rules.md` | The editorial and formatting rules the owner has set (titles, schema, header, related articles, colors, what to omit). **Non-negotiable.** |
| `references/structure.md` | Section-by-section spec for the CMS recap (what each section contains, tables, counts). |
| `references/cms-publishing.md` | How to use the BlogConnector tools, which CSS classes the site supports, tested workarounds, gotchas, publish flow. |
| `assets/cms-snippets.html` | Copy-paste HTML/CSS blocks (schema, header spacing, index tiles, sector cards, related articles, disclaimer). |
| `scripts/verify_recap.py` | Automated checks to run on the saved article before showing it to the user. |
| `references/structure-standalone-legacy.md` + `assets/template.html` | Only for when the user explicitly asks for a **standalone HTML file** (see "Legacy mode" below). |

## Workflow

1. **Load the tools and the style guide first.** The BlogConnector tools are deferred: call `tool_search` for them, then call `get_blog_style_guide` (template `simple`) so you know which classes the site stylesheet supports. Do this *before* writing HTML (skipping it caused unstyled sections earlier).

2. **Pin down the session and the clock.** Run `TZ=America/New_York date`. Default to the most recently completed regular session. Closing data is only valid after 4:00 PM ET; if the user's data is intraday, say so. Note that a post published after midnight ET carries the next calendar date (see `cms-publishing.md`, "Timestamp step").

3. **Screenshots are ground truth.** If the user attaches an index summary bar, an ETF table, crude oil, ether, or stock quotes, read the exact figures off the images and don't second-guess them against search. Typical set: S&P 500 / Dow / Nasdaq / Russell 2000 / 10-Yr / VIX / Gold / Bitcoin; a 16-ETF table; Crude Oil (front contract); Ether. Check prior-close arithmetic (Friday close + change = today's close) to catch misreads. An **unlabeled** quote screenshot can be identified by matching its change to a known prior close — but say in your reply which stock you assumed.

4. **Research what the screenshots don't cover** (usually 6–15 searches): the day's real drivers (data release results, Fed, yields, oil/geopolitics, deals, AI/semis news, company-specific catalysts), movers' catalysts, and the verified calendar for the next 24–72 hours. Rules:
   - Verify every important claim in at least one solid source; prefer exchange/company/government/major financial news. Some sites (e.g. CNBC) block fetches — use search snippets or alternative outlets.
   - Intraday and premarket numbers are not closes. Never mix them without labeling.
   - Derived numbers you compute yourself (e.g. "about 0.3% below the record close") are fine but must be hedged ("about") and are *your* arithmetic.
   - Never invent flows, ratings, estimates, levels or catalysts. If you can't explain a divergence (e.g. energy stocks up while crude fell), say it is a divergence to watch rather than inventing a reason.

5. **Movers need real closes.** List 4–6 movers with specific catalysts. If any mover's closing price and % change can't be verified, **stop and ask the user for those figures** (a quote screenshot or numbers) — name the exact tickers and say what is already done. Don't publish "not available" cells and don't silently drop an important mover.

6. **Write in your own words.** Source articles the user pastes (Barron's, CNBC, Yahoo, etc.) are copyrighted: use them for facts only; paraphrase, keep any quote under ~15 words, and credit the outlet when a figure rests on a single outlet ("according to figures cited by Barron's"). Titles must be original, never copied or lightly edited from a source headline.

7. **Build the CMS body** following `references/structure.md`, using only supported classes plus the snippet CSS in `assets/cms-snippets.html`. Create it with `create_blog_post` as a **draft** (zone `recap`, kick `Recap`, template `simple`, **no `author`**). The `read` field carries the date line (see house rules).

8. **Verify and preview.** Pull the saved post with `list_blog_posts`, run `scripts/verify_recap.py` on its HTML, render it locally at 1100 px and 390 px wide (Playwright) and look at it. Fix problems with `update_blog_post` (always resend `bodyHtml` + `title` + `dek` + `template` + `zone` + `kick` + `read` together). Then write the preview HTML to `/mnt/user-data/outputs/` and call `present_files`.

9. **Report to the user** in plain language: draft id, what's in it, every place you departed from their source or couldn't verify, and the assumptions you made. Then wait for approval.

10. **Publish and fix the timestamp.** On approval: `publish_blog_post`, read the exact publish time from `list_blog_posts` (the `date` field, e.g. `Oct 5 · 16:19 ET`), then `update_blog_post` once more to put that time into the date line and the schema's `datePublished`. Re-verify. Never invent a publish time.

11. **Later tweaks** (colors, bolding, spacing, links) are done with `update_blog_post` on the published post; the status stays Published. Remind the user you can't open the live page from the sandbox and ask them to eyeball it.

## Quality gate (all must be true before you show the draft)

- Title is catchy, original, ≤110 characters; eyebrow is exactly `Recap`.
- One valid **Article** JSON-LD block (not FAQPage); headline equals the title; description, image, author org, publisher + logo, dates present.
- Date line directly above the separator; no byline; spacing override present.
- Four index tiles (green when up, red when down) + index table; ETF scoreboard of every ticker you could verify (omit unverifiable rows); temperature callout; cross-asset table; two side-by-side sector cards; exactly **10** driver stories with bold titles; movers table with real closes; 3 risks; calendar table; takeaway; four related-article cards with verified URLs; single disclaimer.
- No FAQ section, no earnings-spotlight section, no TOC, no "not available at publication" text anywhere.
- Gains green (`pos`), losses red (`dn`) in every table; neutral readings (VIX, yields) plain.
- Only supported classes (the verify script flags the rest); no horizontal overflow at 390 px.

## Legacy mode (standalone HTML file)

Use only if the user explicitly asks for a standalone HTML recap file. Follow `references/structure-standalone-legacy.md` and `assets/template.html` (CSS block verbatim, no new classes, TOC, JSON-LD in the head). Even then, apply the house-rule *content* overrides that don't touch the CSS: omit the FAQ section and the earnings-spotlight section, use Article JSON-LD instead of FAQPage JSON-LD, drop the byline block, and keep titles catchy and original. Save to `/mnt/user-data/outputs/market-recap-YYYY-MM-DD.html` and `present_files`.

## Notes for recurring use

- Treat each invocation independently: re-verify the session's data and re-derive the calendar from what is confirmed as of today. Don't assume yesterday's article is still right.
- If you or the user change a house rule, record it in `references/house-rules.md` so the next person inherits it.
