#!/usr/bin/env python3
"""
Verify a MarketCatalyst article (saved CMS page or preview HTML) against the house rules.

Usage:
    python3 verify_recap.py PATH_TO_HTML [--mode recap|article] [--kick Recap]

--mode recap   (default) also checks the recap-only structure (10 stories, required sections, ...)
--mode article checks only the rules every article shares (schema, header, colors, related cards, disclaimer)

Exit code 1 if any FAIL. WARN items are judgment calls to eyeball.
"""
import argparse, json, re, sys

SUPPORTED = {  # classes the site stylesheet supports
    'stat-strip', 'stat-box', 'num', 'label', 'callout', 'warning', 'table-scroll', 'post-doc-scroll',
    'metric', 'pos', 'takeaway-list', 'disclaimer', 'ai-note', 'bar-chart', 'bar-chart-title', 'bar-row',
    'year', 'bar-track', 'bar-fill', 'negative', 'val',
}
OURS = {'dn', 'bull', 'bear'}  # defined by scoped CSS in assets/cms-snippets.html
OURS_PREFIXES = ('mc-',)

RECAP_SECTIONS = ['numbers', 'etf-scoreboard', 'sentiment', 'cross-asset', 'sectors', 'drivers',
                  'movers', 'risks', 'calendar', 'takeaway']

results = []
def check(level, ok, msg):
    results.append((level if not ok else 'PASS', msg))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--mode', default='recap', choices=['recap', 'article'])
    ap.add_argument('--kick', default=None, help='expected eyebrow text, e.g. Recap')
    a = ap.parse_args()

    html = open(a.path, encoding='utf-8', errors='replace').read()
    m = re.search(r'<div class="article">(.*?)</div>\s*</div>\s*</div>\s*</main>', html, re.S)
    body = m.group(1) if m else html
    head = html[:html.find('<div class="article">')] if m else ''

    # ---- schema
    blocks = re.findall(r'<script type="application/ld\+json">\s*(.*?)\s*</script>', body, re.S)
    check('FAIL', len(blocks) == 1, f'exactly one JSON-LD block (found {len(blocks)})')
    j = {}
    if blocks:
        try:
            j = json.loads(blocks[0])
            check('FAIL', True, 'JSON-LD parses')
        except Exception as e:
            check('FAIL', False, f'JSON-LD parses ({e})')
    check('FAIL', j.get('@type') == 'Article', 'schema @type is Article (not FAQPage)')
    title_m = re.search(r'<h1>(.*?)</h1>', html, re.S)
    title = re.sub(r'&amp;', '&', title_m.group(1).strip()) if title_m else None
    if title and j.get('headline'):
        hl = j['headline'].replace('\\"', '"')
        check('WARN', hl.replace('&amp;', '&') == title.replace('&#x27;', "'").replace('&quot;', '"').replace('&#39;', "'"),
              'schema headline equals the page title')
    check('FAIL', 0 < len(j.get('headline', '')) <= 110, f"headline length <=110 ({len(j.get('headline', ''))})")
    check('FAIL', bool(j.get('description')), 'schema description present')
    check('FAIL', bool(re.search(r'\.(jpg|jpeg|png|webp)$', j.get('image', ''))), 'schema image is a real image file')
    check('FAIL', j.get('author', {}).get('name') == 'MarketCatalyst', 'schema author is MarketCatalyst')
    check('FAIL', bool(j.get('publisher', {}).get('logo', {}).get('url')), 'schema publisher logo present')
    check('FAIL', bool(re.match(r'^\d{4}-\d{2}-\d{2}', j.get('datePublished', ''))), 'datePublished present (ISO)')
    check('FAIL', bool(re.match(r'^\d{4}-\d{2}-\d{2}', j.get('dateModified', ''))), 'dateModified present (ISO)')
    check('WARN', 'T' in j.get('datePublished', ''), 'datePublished has a time (expected after publishing)')

    # ---- header
    meta = re.search(r'<div class="meta"><span>(.*?)</span>', html)
    meta_txt = meta.group(1) if meta else ''
    check('FAIL', bool(re.match(r'Published [A-Z][a-z]{2} \d{1,2}, \d{4}', meta_txt)) and 'min read' in meta_txt,
          f'date line + read time present in header ("{meta_txt}")')
    check('WARN', ' ET' in meta_txt, 'date line has an ET time (expected after publishing)')
    check('FAIL', 'class="byline"' not in html, 'no byline block')
    check('FAIL', not re.search(r'Published [A-Z][a-z]{2} \d', re.sub(r'<div class="meta">.*?</div>', '', body, flags=re.S)[:600]),
          'no duplicate "Published" line in the body')
    if a.kick:
        eb = re.search(r'<div class="eyebrow">(.*?)</div>', html)
        check('FAIL', bool(eb) and eb.group(1).strip() == a.kick, f'eyebrow is "{a.kick}"')
    check('FAIL', '.post-doc .meta' in body and 'hr.rule' in body, 'header spacing override present')

    # ---- forbidden content
    check('FAIL', not re.search(r'not available at publication|\{\{|TBD|XXX', body, re.I), 'no placeholders')
    check('FAIL', not re.search(r'faq', body, re.I), 'no FAQ section / FAQ schema')
    check('FAIL', 'id="earnings"' not in body, 'no earnings-spotlight section')

    # ---- classes
    used = set(c for cl in re.findall(r'class="([^"]+)"', body) for c in cl.split())
    bad = sorted(c for c in used if c not in SUPPORTED and c not in OURS and not c.startswith(OURS_PREFIXES))
    check('FAIL', not bad, f'only supported classes used (unsupported: {bad})')

    # ---- colors in tables
    plain_neg, plain_pos = [], []
    for cell_attr, text in re.findall(r'<td([^>]*)>(.*?)</td>', body, re.S):
        t = re.sub(r'<[^>]+>', '', text).strip()
        if re.match(r'^[-\u2212]\$?\d[\d.,]*%?$', t) and 'dn' not in cell_attr:
            plain_neg.append(t)
        if re.match(r'^\+\$?\d[\d.,]*%?$', t) and 'pos' not in cell_attr:
            plain_pos.append(t)
    check('FAIL', not plain_neg, f'negative table numbers are red/dn (not colored: {plain_neg})')
    check('WARN', not plain_pos, f'positive table numbers are green/pos (plain: {plain_pos}; VIX/yield rows may be intentional)')

    # ---- related articles + disclaimer
    cards = re.findall(r'class="mc-ra-card" href="([^"]+)"', body)
    check('FAIL', len(cards) == 4, f'four related-article cards (found {len(cards)})')
    check('FAIL', all(c.startswith('https://marketcatalyst.ai/posts/') for c in cards), 'related links are marketcatalyst.ai/posts URLs')
    check('FAIL', len(set(cards)) == len(cards), 'no duplicate related links')
    check('FAIL', 'Readers also read' in body, 'related heading is "Readers also read"')
    check('FAIL', body.count('class="disclaimer"') == 1, 'exactly one disclaimer')
    check('FAIL', 'href="https://marketcatalyst.ai/"' in body, 'disclaimer links MarketCatalyst')

    # ---- recap-only structure
    if a.mode == 'recap':
        ids = re.findall(r'<h2 id="([^"]+)"', body)
        missing = [s for s in RECAP_SECTIONS if s not in ids]
        check('FAIL', not missing, f'required recap sections present (missing: {missing})')
        check('FAIL', [s for s in ids if s in RECAP_SECTIONS] == [s for s in RECAP_SECTIONS if s in ids], 'recap sections are in order')
        stories = re.findall(r'<h3><strong>(\d+)\.', body)
        check('FAIL', len(stories) == 10 and stories == [str(i) for i in range(1, 11)], f'exactly 10 numbered bold stories (found {len(stories)})')
        check('FAIL', not re.search(r'<h3>\d+\.', body), 'story titles are bold')
        strip = re.search(r'id="idx-strip">(.*?)</div>\s*<div class="table-scroll">', body, re.S)
        check('FAIL', bool(strip) and strip.group(1).count('class="stat-box"') == 4, 'four index tiles in #idx-strip')
        check('FAIL', '#idx-strip' in body, '#idx-strip CSS present')
        check('FAIL', 'class="mc-bb"' in body and 'mc-bb-col bull' in body and 'mc-bb-col bear' in body, 'sectors use the two tinted cards')
        check('FAIL', len(re.findall(r'<div class="warning"><strong>Risk #', body)) >= 3, 'three risk boxes')
        check('FAIL', 'Worth remembering:' in body, '"Worth remembering" box present')
        check('FAIL', 'Key tactical takeaway:' in body, '"Key tactical takeaway" callout present')
        check('FAIL', 'Temperature check:' in body, 'temperature callout present')
        mv = re.search(r'<h2 id="movers">(.*?)<h2 id="risks">', body, re.S)
        rows = len(re.findall(r'<tr><td class="metric">', mv.group(1))) if mv else 0
        check('WARN', 4 <= rows <= 6, f'4-6 movers (found {rows})')
        etf = re.search(r'<h2 id="etf-scoreboard">(.*?)<h2 id="sentiment">', body, re.S)
        etf_rows = len(re.findall(r'<tr><td class="metric">', etf.group(1))) if etf else 0
        check('WARN', etf_rows >= 12, f'ETF scoreboard has most tickers (rows: {etf_rows})')
        check('WARN', 'grid-template-columns: repeat(4' in body, 'four-column strip CSS present')

    # ---- report
    width = max(len(m) for _, m in results)
    fails = warns = 0
    for lvl, msg in results:
        print(f'{lvl:5} {msg}')
        fails += lvl == 'FAIL'
        warns += lvl == 'WARN'
    print(f'\n{len(results)} checks | {fails} FAIL | {warns} WARN')
    sys.exit(1 if fails else 0)

if __name__ == '__main__':
    main()
