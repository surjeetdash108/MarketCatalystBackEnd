# CMS recap structure (default mode)

Order is fixed. Use only site-supported classes (`stat-strip`, `stat-box`, `num`, `label`, `callout`, `warning`, `table-scroll` + `post-doc-scroll` wrapper, `metric`, `pos`, `takeaway-list`, `disclaimer`) plus the scoped CSS from `assets/cms-snippets.html` (`dn`, `#idx-strip`, `.mc-bb`, `.mc-ra`, h3 sizing, header spacing). See `house-rules.md` for naming, colors and header rules.

```
<script type="application/ld+json"> Article </script>
Opening (2–3 short paragraphs)
H2 numbers            tiles + index table
H2 etf-scoreboard     table + one analytical paragraph
H2 sentiment          temperature callout + paragraph
H2 cross-asset        1–2 paragraphs + table
H2 sectors            1 paragraph + two tinted cards
H2 drivers            exactly 10 bold-titled stories
H2 movers             paragraph + table (4–6 stocks)
H2 risks              3 warning boxes
H2 calendar           table + "Worth remembering" warning
H2 takeaway           callout + 3 bullets
<style> block (header spacing, #idx-strip, .mc-bb, h3, dn, .mc-ra)
Readers also read     4 cards
Disclaimer
```

No TOC, no FAQ, no earnings-spotlight, no byline.

## Opening
Two to three short paragraphs before the first `<h2>`.
1. Lead: index headline (Nasdaq/S&P/Dow/Russell closes and % changes; say "record" only if verified) and the dominant force.
2. The two or three forces that framed the session (data release, oil, yields, Fed) and how they interacted.
3. Participation: breadth/equal-weight vs cap-weight, small caps — if the data supports it.

## numbers — `<h2 id="numbers">`
- `<div class="stat-strip" id="idx-strip">` with exactly four `.stat-box`: Dow, S&P 500, Nasdaq, Russell 2000. `.num` = daily % (colored by direction), `.label` = `Name (close, ±pts)`.
- Table columns: Index / Close / Point Change / % Change / Session Read. Rows: DJIA, S&P 500, Nasdaq Composite, Russell 2000, CBOE Volatility ($VIX). `pos` on gains, `dn` on losses, plain on VIX.
- Session Read ≤ ~10 words. A "record" or "below its record" claim needs a verified reference level; hedge derived percentages with "about".
- PHLX Semiconductor ($SOX) only if you have a verified index print — otherwise omit.

## ETF scoreboard — `<h2 id="etf-scoreboard">`
Attempt all of these every session; show only what you verified (omit a row rather than write a placeholder). Columns: Category / ETF (ticker + name) / Close / % Change / Note (≤ ~12 words, a real catalyst or context).
- Broad Market: SPY, QQQ, QQEW, DIA, IWM
- Sectors: XLK, XLE, XLF, SMH, SOXX, CIBR (add others the user's screenshot includes, e.g. HACK)
- Rates & Credit: TLT, HYG
- Commodities & Alternatives: GLD, IBIT, VNQ
- Dollar & Volatility: UUP, VIX (same VIX level as the index table)
- International: EFA, EEM
Follow with one paragraph on the pairs that matter: **QQQ vs QQEW** (breadth/concentration — say which way it went and by how many basis points), **SMH vs SOXX** (composition differences, not a signal), and any ETF-vs-spot mismatch (e.g. GLD vs spot gold, IBIT vs bitcoin — say snapshot timing may differ). Screenshot figures are taken as-is.

## sentiment — `<h2 id="sentiment">`
`<div class="callout"><b>Temperature check:</b> call it roughly N out of 100, <b>Phase</b>. VIX closed at X (±Y, ±Z%) …</div>` + one paragraph on hedging vs the index move. Phases: Defensive (<35), Fear/Neutral-defensive (35–45), Neutral (45–55), Constructive (55–70), Bullish expansion (70–85), Extreme greed (85+). Judgment call; justify with VIX level/change and index action.

## cross-asset — `<h2 id="cross-asset">`
1–2 paragraphs (yields and what drove them, oil, gold, crypto). Table columns: Asset / Close or Yield / Daily Change / % Change / Main Catalyst. Rows: 10-Year yield, crude oil (state the contract, e.g. WTI Nov), gold, bitcoin, ether (and 2-year, DXY only when verified). Catalyst ≤ ~15 words; if none is known write "no single catalyst identified".

## sectors — `<h2 id="sectors">`
One sentence on leadership style, then the two-card block (`.mc-bb`), 3–4 items each, each item "Group (TICKER ±x.xx%), reason". Mention divergences you can't explain as divergences.

## drivers — `<h2 id="drivers">`
Exactly **10** stories: `<h3><strong>N. Title</strong></h3>` + one `<p>` of 3–5 sentences. Typical mix: index/record headline; the day's data release (give the number and consensus); yields; oil/geopolitics; Fed/minutes/speakers; the biggest deal or M&A; AI/semis names; a stalled leader (why); a company-specific fade; breadth/sector rotation. Only real developments. Close with what happens next where relevant.

## movers — `<h2 id="movers">`
Framing sentence, then table: Stock / Close / Change / What happened. 4–6 stocks, **real closes** (ask the user if unverified), catalyst in 2–3 sentences, `pos`/`dn` on Change. Order by size of move. Mention notable context (e.g. a takeover target closing below the offer; a stock still below its IPO price).

## risks — `<h2 id="risks">`
Three `<div class="warning"><strong>Risk #N: Title.</strong> 2–3 specific sentences.</div>` blocks (yields/Fed, oil/geopolitics, concentration or a named event).

## calendar — `<h2 id="calendar">`
Table: When / Event / Why it matters. Confirmed events for the next 24–72 hours only (Fed speakers, minutes, auctions, data, big earnings and their timing). Then `<div class="warning"><strong>Worth remembering:</strong> …</div>` — balanced, no trade directives.

## takeaway — `<h2 id="takeaway">`
`<div class="callout"><b>Key tactical takeaway:</b> specific level/yield/VIX/spread to monitor</div>` and a `takeaway-list` of exactly three bullets, each starting with a bold lead-in.

## Optional (only with real data)
Breadth section (A/D, up/down volume, new highs/lows); 2-year yield; DXY; $SOX. Never write rows or sections that are all placeholders.

## Data quality
- Same session for every figure; closes only (no intraday/premarket without a label; no after-hours as "the close").
- Screenshots over search. Check arithmetic against prior closes.
- Never invent ETF flows, options flows, analyst ratings, estimates, support/resistance levels or catalysts.
- No URLs, source lists, Markdown or editorial notes inside the article body (credit an outlet in prose when needed).
- After-hours/next-day wording must match when the post actually goes live.

## Final checklist
See the "Quality gate" in `SKILL.md` and run `scripts/verify_recap.py`.
