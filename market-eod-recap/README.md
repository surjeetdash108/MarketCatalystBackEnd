# market-eod-recap (v2, updated Oct 6, 2026)

Generates MarketCatalyst's end-of-day U.S. market recap as a **CMS draft in the Recap section**, with a rendered preview for review, then publishes it after approval. v2 captures the owner's house rules and everything learned while publishing recaps, news, research and educational articles.

## Using it
1. Put this folder where your Claude skills live (same folder name: `market-eod-recap`).
2. Make sure the **BlogConnector** connector (the CMS tools) is enabled. Python with Playwright is useful for local previews.
3. In a chat, type `/market-eod-recap` and attach what you have: screenshots of the index bar, the ETF table, crude oil, ether, and (when asked) quotes for the day's movers. Without screenshots the skill researches the data itself.
4. Review the preview file it hands you, ask for changes, and say "publish". It then publishes and writes the exact publish time into the date line and schema.

## What's in the folder
| File | Purpose |
|---|---|
| `SKILL.md` | The workflow and quality gate. Start here. |
| `references/house-rules.md` | Owner-set rules: catchy original titles, Article schema, date line, no byline/FAQ/earnings spotlight, green/red numbers, related articles, verified-URL list. |
| `references/structure.md` | Section-by-section spec of the recap. |
| `references/cms-publishing.md` | CMS tool usage, supported vs unsupported CSS, tested workarounds, publish/timestamp flow, image upload, gotchas. |
| `assets/cms-snippets.html` | Copy-paste schema, CSS and HTML blocks. |
| `scripts/verify_recap.py` | Automated checklist: `python3 scripts/verify_recap.py preview.html --mode recap --kick Recap`. |
| `assets/template.html`, `references/structure-standalone-legacy.md` | Original standalone-HTML template and spec (legacy mode only, if someone wants a standalone file). |

## What changed from v1
- **Default output is a CMS draft** (BlogConnector) instead of a standalone HTML file; the standalone template is kept as legacy mode.
- Article **JSON-LD** (not FAQPage); **no FAQ**, **no earnings-spotlight**, **no TOC**, **no byline**; eyebrow is `Recap`.
- **Date line** (`Published Oct 5, 2026 · 4:19 PM ET · 10 min read`) directly above the separator with tight spacing; exact time taken from the CMS after publishing, and the schema date updated to match.
- **Catchy, original titles** (never a source headline).
- **"Readers also read"**: four compact cards in one row, verified URLs only (a verified list is included).
- **Green gains / red losses** in index tiles and tables; the four index tiles sit in one row.
- **Sectors** = two tinted cards (green leading, red lagging); **story titles bold**.
- Workarounds for classes the site stylesheet doesn't style (timeline, risk boxes, side-by-side columns, red numbers, h3).
- Rules for working from pasted source articles (paraphrase, credit, verify), for movers' closes (ask the user), for timestamps (never invented), and for honest reporting of what couldn't be verified.
- `scripts/verify_recap.py` to catch the mistakes that actually happened (unstyled sections, uncolored negatives, wrong story count, missing schema fields, FAQ creeping back in).

## Known limits
- The sandbox can't open live marketcatalyst.ai pages' raw HTML, so live rendering and per-page meta tags can't be confirmed; ask the owner to eyeball the live page.
- The verified related-article list in `house-rules.md` goes stale — update it as new article URLs are confirmed.
- A few closes (movers) are only available after 4:00 PM ET and sometimes not in search results; the skill asks the user for them rather than guessing.
