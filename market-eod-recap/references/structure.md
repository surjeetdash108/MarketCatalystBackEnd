# Official EOD Recap Structure (Gold Standard Template)

Reference live post: `https://marketcatalyst.ai/posts/nasdaq-rallies-to-a-record-as-a-weak-jobs-report-eases-rate-hike-fears`
The CSS stylesheet and HTML layout from this post define the exact template for automated post-market recap posts (0% deviation).

## Document Hierarchy

```html
<div class="toc"> ... </div>
<hr class="rule">
Opening narrative (2 short paragraphs)
<h2 id="numbers">The numbers, by the close</h2>
  .stat-strip (4 .stat-box / .stat-box.neg)
  .post-doc-scroll > table (DJIA, S&P 500, Nasdaq, Russell 2000, CBOE VIX)
<h2 id="etf-scoreboard">ETF scoreboard</h2>
  intro paragraph
  .post-doc-scroll > table (16 Popular ETFs + extras)
<h2 id="sentiment">Market temperature and volatility</h2>
  .callout (Temperature score + phase)
  1-2 analytical paragraphs
<h2 id="cross-asset">Rates, dollar, gold, and crypto</h2>
  1-2 analytical paragraphs
  .post-doc-scroll > table (10Y Yield, Gold, Bitcoin, Ether)
<h2 id="sectors">Sectors: leaders and laggards</h2>
  1 analytical paragraph
  .bullbear-wrap (.bb-col.bull and .bb-col.bear)
<h2 id="drivers">The day's market-moving stories</h2>
  Exactly 10 stories: <h3>N. Title</h3> + <p>
<h2 id="movers">Movers below the headlines</h2>
  intro sentence
  .post-doc-scroll > table (4-6 single-stock movers)
  closing sentence
<h2 id="risks">Key market &amp; macro risks to watch</h2>
  Exactly 4 .risk-box elements (.risk-title + <p>)
<h2 id="calendar">What to watch next</h2>
  .timeline (.timeline-item / .timeline-item.flag / .timeline-item.good)
  .warning ("Worth remembering:")
<h2 id="takeaway">The takeaway</h2>
  .callout ("Key tactical takeaway:")
  .takeaway-list (3 bullets with bold lead-ins)
.disclaimer
```

## Styling & Classes
- Scoped inside `.mc-recap-root`
- Green: `class="pos"`, Red: `class="neg"`
- Negative stat-boxes: `class="stat-box neg"`
- Table cells: first column `class="metric"`
- All tables wrapped in `<div class="post-doc-scroll">`
