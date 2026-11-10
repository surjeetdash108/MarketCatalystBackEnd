# Publishing to the MarketCatalyst CMS (BlogConnector)

Everything here was learned by doing it; follow it to avoid the same detours.

## 1. Tools
The tools are deferred — load them with `tool_search` first (e.g. query "BlogConnector create blog post"). Names:
`get_blog_style_guide`, `create_blog_post`, `update_blog_post`, `publish_blog_post`, `list_blog_posts`, `upload_blog_image`, `list_blog_media` (avoid `delete_blog_post` unless the user explicitly asks).

| Call | Notes |
|---|---|
| `get_blog_style_guide(template="simple")` | **Call first.** Lists the CSS classes the site stylesheet supports. |
| `create_blog_post` | Creates a **Draft**. Params: `title`, `dek`, `kick`, `read`, `template` (`simple`), `zone`, `bodyHtml`, optional `heroImageUrl`. **Do not pass `author`** (would show "Desk"). |
| `update_blog_post` | Needs `id`. When you pass `bodyHtml` the whole page is recomposed, so also pass `title`, `dek`, `template`, `zone`, `kick`, `read` every time. Works on drafts and on published posts (status stays Published). |
| `publish_blog_post` | `id` only. Only after the user approved a preview. If the post is already Published, don't call it again. |
| `list_blog_posts` | Returns every post (large — it is saved to a file; parse the JSON in Python). Fields include `id, title, dek, kick, read, zone, author, template, status, date, html`. `date` looks like `Oct 5 · 16:19 ET` and is the real publish time. |

## 2. Supported vs unsupported CSS
Supported by the site stylesheet: `stat-strip`, `stat-box` (+ `.num`, `.label`), `callout`, `warning`, `table-scroll` > `post-doc-scroll` > `table` (use `td.metric` for bold first column, `td.pos` for green), `takeaway-list`, `disclaimer`, plus the bar-chart family. Headings `h2` are styled; `h3` is not.

**Not styled (renders as plain text):** `.bullbear-wrap/.bb-col`, `.timeline*`, `.risk-box`, `.faq-item`, `td.neg`, `.imgcap`, `.checklist`, `.tags-line`, default `h3`.
Replacements that were tested:
- timeline → a table (When / Event / Why it matters)
- risk-box → `.warning` boxes
- bullbear → our `.mc-bb` tinted cards (CSS in `assets/cms-snippets.html`)
- red numbers → our `td.dn` rule
- h3 → `<h3><strong>…</strong></h3>` + sizing rule

A `<style>` block inside `bodyHtml` is kept and works (verified in rendered previews). Rules for writing it:
- Prefix/ID your selectors (`.mc-ra`, `.mc-bb`, `#idx-strip`) to avoid collisions.
- The site's own selectors are specific (`.post-doc .article h2`, `.post-doc .stat-box .num`, and a ≤560 px rule forcing single-column grids with `!important`). Beat them with equal-or-higher specificity and `!important` where needed (e.g. `section.mc-ra h2.mc-ra-title`, `#idx-strip .num { color: … !important }`, `grid-template-columns: … !important`).
- Don't use `<script>` (never executes) — the only allowed script is the JSON-LD block.
- Do add your own `@media (max-width: 720px)` where a layout must collapse; verify at 390 px.

## 3. Local preview and checks
`list_blog_posts` returns the composed page without the wrapper class the live site uses, so a raw preview looks unstyled. Add it, then render:

```python
import json, re
from playwright.sync_api import sync_playwright
data = json.load(open(RESULT_FILE))          # the saved list_blog_posts output
post = [p for p in json.loads(data[0]['text']) if p['id'] == POST_ID][0]
html = post['html'].replace('<body>\n<div><main>', '<body>\n<div class="post-doc"><main>', 1)
open('/mnt/user-data/outputs/preview.html', 'w', encoding='utf-8').write(html)
with sync_playwright() as pw:
    b = pw.chromium.launch()
    for w in (1100, 390):
        pg = b.new_page(viewport={'width': w, 'height': 900})
        pg.goto('file:///mnt/user-data/outputs/preview.html')
        print(w, 'overflow:', pg.evaluate('document.documentElement.scrollWidth > window.innerWidth'))
    b.close()
```
Screenshot sections (`pg.query_selector('#idx-strip').screenshot(...)`, `pg.screenshot(clip=…, full_page=True)`) and actually look at them with the image viewer. Always `present_files` the preview.

Then run `python3 scripts/verify_recap.py <preview.html>`.

## 4. Draft → publish → timestamp flow
1. `create_blog_post` (Draft) → verify (script + render) → fix with `update_blog_post` → present preview and a plain-language summary.
2. User approves ("publish") → `publish_blog_post`.
3. **Timestamp step:** `list_blog_posts`, read `date` (e.g. `Oct 6 · 09:33 ET`). Convert to `3:43 PM ET` style. `update_blog_post` once more with `read = "Published <Mon D, YYYY> · <h:mm AM/PM> ET · N min read"` and schema `datePublished` = ISO with offset (`-04:00` EDT / `-05:00` EST), `dateModified` = date only. If it went live after midnight, fix date-dependent wording in the copy too.
4. Re-list and re-verify (status Published, header line, schema date, 4 cards, 1 disclaimer).
5. Tell the user you can't open the live page from the sandbox and ask them to check it once.

## 5. Images
- `upload_blog_image(dataUri, filename)` takes the image as a base64 data URI **typed into the call**, so keep it small: crop out UI chrome, resize to ~800 px wide, save WebP quality ~50 (target ≤ ~18 KB).
- Compare the returned `size` with your file's byte count; if they differ, re-upload (a one-byte mismatch happened once and was re-done).
- The returned URL ends in `.webp.webp` — that is normal. Use it as `heroImageUrl` and as the schema `image`. You can't fetch it back from the sandbox.

## 6. Other site facts
- `/posts` (blog index) can be cached; it showed 113 posts while the CMS had 119. New articles may not appear for a while.
- Article URLs are `https://marketcatalyst.ai/posts/<slug>` (see `house-rules.md` for slug rules and the verified list). The sandbox's `web_fetch` only works on URLs that already appeared in the conversation (e.g. ones the user pastes) and some news sites block it.
- Homepage metadata (title, description, canonical, OG/Twitter) is in place; per-article head tags could not be confirmed from the sandbox — don't claim them.
- The CMS holds eight old auto-generated recap drafts with generic titles and no schema. Leave them alone unless asked.
- Edits to a published article are visible without re-publishing; still re-verify afterwards.
