# Article Structure & Content Rules

Follow this order exactly, using only components already defined in `assets/template.html`'s `<style>` block.

## Document head
- `<!DOCTYPE html>`, `<html lang="en">`
- `<meta charset="UTF-8">`, responsive viewport meta tag
- SEO `<title>` (~60–70 chars) with date/session theme + "MarketCatalyst"
- Accurate `<meta name="description">`
- Valid `FAQPage` JSON-LD with **exactly four** FAQs, matching the bottom FAQ section **word-for-word**
- The complete reference `<style>` block, unchanged

## A. Header & metadata
- Eyebrow: `MARKETS · MACRO`
- Headline: high-CTR but credible, capturing the session's dominant theme
- Subtitle/dek: one sentence, key drivers + cross-asset implication
- Tag: read time, 8–12 min read
- Byline: MarketCatalyst Desk / Markets & Macro Team / "Data verified at close"
- Meta: `Published [Month Day, Year] · Updated [time] EDT`

## B. Opening narrative
Two to three short paragraphs before the first `<h2>` — split for readability rather than forcing everything into two long, multi-clause paragraphs.
- Lead paragraph: the leading macro force (rates, inflation, Fed, labor, geopolitics, oil, dollar, flows). If the person supplied an exact opening sentence or "Stock market today: ..." style line, use it as the actual opening sentence.
- Following paragraph(s): supporting detail, then whether the tape was broad risk-on/off or internally divided (breadth, sectors, cross-asset).

## C. The numbers, by the close — `<h2 id="numbers">`
- `.stat-strip` with exactly four `.stat-box`: Dow, S&P 500, Nasdaq, Russell 2000. Show daily % prominently, close + point move beneath, `.stat-box.neg` on losers.
- Table: DJIA, S&P 500, Nasdaq Composite, Russell 2000, CBOE VIX ($VIX). Columns: Index / Close / Point Change / % Change / Session Read.
- PHLX Semiconductor ($SOX) is **optional**: include it only if you have a verified index-level print. Don't add a row that just says "not available" — if you can't verify it, leave it out of the table entirely (the ETF scoreboard's SMH/SOXX rows already cover semiconductor performance).

## C2. ETF Scoreboard — `<h2 id="etf-scoreboard">`
A required table covering the following 17 ETFs, grouped into six categories. Always include all 17 tickers, every session — this is not optional or trimmable. Use one table with columns: **Category / ETF (ticker + name) / Close / % Change / Note**. Group rows by category in the order below so the table reads top-to-bottom by category (Broad Market first, International last).

- **Broad Market**: SPY (S&P 500), QQQ (Nasdaq 100), QQQEW (Nasdaq 100 Equal Weight), DIA (Dow 30), IWM (Small Caps)
- **Sectors**: XLK (Technology), XLE (Energy), XLF (Financials), SMH (Semiconductors), SOXX (Semiconductors), CIBR (Cybersecurity)
- **Rates & Credit**: TLT (Long-Term Treasuries), HYG (High Yield Corp Bonds)
- **Commodities & Alternatives**: GLD (Gold), IBIT (Bitcoin ETF), VNQ (Real Estate/REITs)
- **Dollar & Volatility**: UUP (US Dollar Index), VIX (Volatility Index — the index itself, not an ETF, but tracked here for convenience alongside the other risk gauges)
- **International**: EFA (Developed Markets ex-US), EEM (Emerging Markets)

Notes:
- The **Note** column should be a short (under ~12 words) catalyst or context line — e.g. "tracking crude's move toward $100" for XLE, or "growth-stock softness as yields rose" for XLK. Don't leave it blank; if no specific catalyst is verifiable, write a brief description of what's driving the category generally (e.g. "moving with the broader small-cap/rate-sensitive trade").
- If the person supplied a screenshot of this data, read the exact price/change/%-change straight off the image — don't second-guess it against a web search. Screenshots typically show columns like Symbol/Trend/Price/Change/%Change/Prev Close; map those directly to Close/% Change.
- QQQ vs. QQEW is a deliberate pair: a wide gap between them (equal-weight lagging cap-weighted, or vice versa) is a breadth/concentration signal worth a sentence in the surrounding prose — call it out if the data supports it.
- SMH and SOXX are both semiconductor ETFs (deliberately duplicated per the user's ETF list) — if their moves diverge meaningfully, note why (index composition differences) rather than treating them as redundant.
- Since VIX already appears in the numbers table (section C) and this scoreboard, keep the figure consistent between the two — don't report two different VIX levels in the same article.
- **If a specific ETF's data can't be verified after real effort, omit that row entirely rather than showing a "not available at publication" placeholder.** A table with 14 confirmed rows reads better than one with 17 rows where 3 are dead ends. This applies to individual tickers (e.g. UUP, XLK on a given day) as well as to a whole category if every ticker in it is unverifiable — still attempt all 17 tickers each session, but only display what you actually confirmed.

## D. Market temperature and volatility — `<h2 id="sentiment">`
- `.callout`: 0–100 temperature score, named phase (Defensive/Fear/Neutral/Constructive/Bullish Expansion/Extreme Greed), VIX level + daily change, concise interpretation of implied vol / hedging / dealer positioning.
- One analytical paragraph on options-market behavior vs. index action.

## E. Breadth and participation — `<h2 id="breadth">` (optional)
This section is **optional, not required**. NYSE/Nasdaq advance-decline ratios, up/down volume, and new-high/new-low counts are rarely available from routine research or screenshots. Default to leaving this section out entirely (both the `<h2>` and its TOC entry) rather than including a table full of "not available at publication" rows. Only include it if you have genuine, verified breadth data for the session — in that case, use an intro paragraph plus a table: NYSE A/D ratio, Nasdaq A/D ratio, NYSE up/down volume, Nasdaq up/down volume, new 52-week highs/lows, % S&P 500 above 50-day/200-day MA (if available). Columns: Metric / Reading / What it says about participation.

## F. Rates, dollar, gold, and crypto — `<h2 id="cross-asset">`
- 1–2 paragraphs connecting Treasury yields, real yields, dollar, Fed pricing, liquidity.
- Table rows: 10Y yield, Gold (XAU/USD), Bitcoin (BTC/USD), Ether (ETH/USD). Columns: Asset / Close or Yield / Daily Change / % Change / Main Catalyst.
- The 2-Year Treasury yield and Dollar Index (DXY) are **optional rows**: include them only when you have a verified figure. If not, leave the row out rather than adding a "not available" placeholder — the UUP row in the ETF scoreboard already gives dollar-direction context when DXY itself isn't available.
- Explain the actual catalysts for gold, bitcoin, ether (table + text) — never invent flows or catalysts. If ether's figure isn't available, leave its row out too rather than a placeholder, unless the person has supplied it (e.g. via screenshot).

## G. Sectors: leaders and laggards — `<h2 id="sectors">`
- Paragraph on leadership style (cyclical/defensive/growth/commodity/rate-sensitive).
- `.bullbear-wrap`: `.bb-col.bull` "▲ Leading groups" (3–5 bullets: sector ETF + % gain + catalyst); `.bb-col.bear` "▼ Lagging groups" (3–5 bullets: weakest ETFs + % loss + catalyst).

## H. The day's market-moving stories — `<h2 id="drivers">`
Exactly **10** numbered drivers: `<h3>1. Title</h3>` + `<p>` of 3–5 sentences. Cover genuinely important developments only (data, Fed, fiscal/trade, oil/geopolitics, AI/semis, flows, China/Europe/Japan, major corporate news). Do not force irrelevant themes just to hit 10 — but the count must still be exactly 10.

## I. Movers below the headlines — `<h2 id="movers">`
- Framing paragraph, then table of 4–6 stocks. Columns: Stock / Close / Change / What happened.
- Company + ticker, accurate close + % move, exact catalyst in 2–3 sentences. `class="pos"` / `class="neg"`.
- Never attribute to "market sentiment" if a specific catalyst exists.
- If you can't verify a mover's exact closing price after real research, don't publish the row with "not available at publication" in the Close column and don't drop the stock either if it's a genuinely important mover. Instead, ask the person for that stock's closing price (a quote screenshot or the number itself works) before finalizing the article.

## J. Earnings spotlight — `<h2 id="earnings">`
- Intro, then table(s):
  - Reported today: Company / EPS-rev vs consensus / Guidance takeaway / Stock reaction / Why investors reacted
  - Next 24–48 hours: Company / Reporting date-time / Wall St focus / Key expectation or risk
- If none reported/scheduled, state that plainly — never fabricate.
- When the person shares a detailed earnings print or call summary (segment breakdowns, RPO, margins, cash flow, guidance ranges), don't compress it into one dense paragraph. Use a small table (Metric / Result / Context, or Segment / Revenue / YoY Growth) for the parallel data points, then one or two short prose sentences for the "why it matters" takeaway. See section 5 in SKILL.md for the general readability rule this follows.
- If a company was previously written up as an upcoming/preview report and results come in later, move it into the "Reported" table with full detail and remove it from the preview table — don't leave both a stale preview and a new results entry in the same article.

## K. Key market & macro risks to watch — `<h2 id="risks">`
3–4 `.risk-box` blocks, each:
```html
<div class="risk-box">
  <div class="risk-title">Risk #N: [specific title]</div>
  <p>[2–3 specific, actionable sentences]</p>
</div>
```

## L. What to watch next — `<h2 id="calendar">`
- `.timeline` with 3–5 confirmed events over the next 24–72 hours. Each: day+date, exact event, why it matters. `class="flag"` for high-risk events (CPI, payrolls, Fed, auctions, major earnings, geopolitical deadlines); `class="good"` only for clearly constructive catalysts.
- After the timeline, one `.warning` box beginning **exactly**: `<strong>Worth remembering:</strong>` [balanced perspective, no trade directives].

## M. The takeaway — `<h2 id="takeaway">`
- `.callout`: `<strong>Key tactical takeaway:</strong>` [specific level/yield/VIX/breadth/sector pivot to monitor]
- `.takeaway-list` with exactly **three** bullets, each starting with a bold short lead-in.

## N. Frequently asked questions — `<h2 id="faq">`
Exactly **four** `.faq-item` blocks matching the JSON-LD word-for-word. Search-oriented questions (why stocks rose/fell, what moved VIX, which sectors led/lagged, what investors watch tomorrow).

## O. Disclosure footer (match template exactly, verbatim text)
```html
<div class="disclaimer">
  <p>This platform, including MarketCatalyst LLC, is not a registered
  investment advisor and doesn't manage client assets. Content here is
  for informational and educational purposes only — not investment
  advice, and not a stock-picking or trade-alert service. Trading
  stocks and options carries risk, including possible loss of principal.
  Consider your own goals, time horizon, and risk tolerance, and
  consult a qualified financial advisor before making any investment
  decisions.</p>
</div>
```
A single paragraph — this is the standing default for this blog. (An earlier version of this template also carried a second "may have been generated with AI" `<p class="ai-note">` line; that's been dropped. Only add it back if the person explicitly asks for it.)

## Table of contents
`.toc` with one linked item per `<h2>` that has an `id`. Every anchor must match a real `h2 id` exactly — add/remove TOC entries to match whichever optional sections (breadth, 2Y yield, DXY, $SOX, etc.) you actually included this session. The always-required sections are: numbers, ETF scoreboard, sentiment, cross-asset, sectors, drivers, movers, earnings, risks, calendar, takeaway, FAQ.

## Data quality rules
- Use the latest completed regular U.S. session, or the user-specified date — state the date clearly.
- If the person supplied screenshots of closing data, treat them as ground truth over anything found by search.
- Use official/exchange/company/government/high-quality financial-news sources for whatever isn't covered by screenshots.
- All closes, % moves, VIX, yields, crypto, commodities, earnings, and event dates must correspond to the **same** session — never mix intraday and closing values without labeling, and never describe after-hours movement as the regular-session close.
- If markets are closed on the requested date, identify the most recent completed session and say so naturally in the opening.
- **Default to omitting a row, line, or entire optional section when its data can't be verified, rather than writing "not available at publication."** This applies to large, many-ticker tables (the ETF scoreboard, breadth) where a few missing rows don't hurt the article.
- **Never write "not available at publication" as a substitute for asking.** If a specific figure that matters to the article — a mover's closing price, an earnings number, a named stat — can't be verified after real effort, stop and ask the person for it rather than publishing a placeholder or guessing. This is especially true for the Movers table (section I): every stock listed there needs a real close and % change: if either is missing after your own research, ask the person for it before finalizing the article, don't leave the cell as "not available at publication." A clean, complete-feeling article beats one visibly full of dead-end rows, but a placeholder the person has to catch and correct is worse than a quick question.
- Never invent ETF flows, options flows, analyst ratings, earnings estimates, support/resistance levels, or catalysts.
- No citations, source lists, URLs, Markdown, or editorial notes in the final HTML output itself.

## Final quality checklist (verify before writing the file)
- [ ] Begins with `<!DOCTYPE html>`, ends with `</html>`
- [ ] Full reference CSS + DOM structure retained unchanged
- [ ] No Tailwind / external fonts / JS / images / iframe / SVG / new CSS rules
- [ ] Only template components/classes used
- [ ] Four stat tiles: Dow, S&P 500, Nasdaq, Russell 2000
- [ ] All always-required sections present: numbers, ETF scoreboard, sentiment, cross-asset, sectors, 10 driver stories, movers, earnings, risks, calendar, takeaway, FAQ
- [ ] No "not available at publication" placeholders anywhere in the article — every ETF-scoreboard/breadth row is either fully verified or omitted, and every Movers-table stock has a real close and % change (asked the person for it if research couldn't confirm it)
- [ ] Exactly 10 numbered market-moving stories
- [ ] Exactly four FAQ items, matching JSON-LD word-for-word
- [ ] Every `<h2 id="...">` has a matching TOC link, and every optional section actually included has one too
- [ ] Disclaimer is the single-paragraph version (no ai-note line) unless the person asked for it back
- [ ] Any dense multi-metric data (detailed earnings, data releases) is broken into a table + short prose, not one long paragraph
- [ ] Writing is accurate, coherent, grounded only in verified session data
- [ ] Output is only the complete standalone HTML document (no preamble/explanation in the saved file)
