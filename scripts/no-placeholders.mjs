#!/usr/bin/env node
/**
 * Release gate: fails (exit 1) when shipped source or copy contains a
 * placeholder — "PLACEHOLDER" or an @example.com address. Runs before every
 * build (package.json "prebuild") and in CI, so a page carrying draft markers
 * can never be built for production again.
 *
 * Why it exists: on 24 Nov 2026 the public Terms carried "[LEGAL REVIEW
 * PLACEHOLDER]" and support@example.com. A checker existed
 * (MarketCatalystBackEnd/scripts/check-placeholders.mjs) but nothing ran it —
 * no CI, and no deploy step called it.
 *
 *   node scripts/no-placeholders.mjs            # scan this repo's shipped dirs
 *   node scripts/no-placeholders.mjs --list     # print matches, exit 0
 *
 * Not scanned: tests, fixtures, docs, node_modules, build output, env templates.
 * A line is ignored when it only mentions the word as an input hint
 * (placeholder="…" / placeholder:) or is this detector itself.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const DIRS = (process.env.PLACEHOLDER_SCAN_DIRS ?? "app,components,lib,content,src,public/admin")
  .split(",").map((d) => d.trim()).filter((d) => d && existsSync(join(ROOT, d)));
const SKIP_DIR = /(^|\/)(node_modules|dist|\.next|out|test|tests|fixtures|__snapshots__|docs)(\/|$)/;
const SKIP_FILE = /(\.spec\.|\.test\.|\.e2e-spec\.|no-placeholders\.mjs$|check-placeholders\.mjs$|\.(png|jpg|jpeg|gif|ico|svg|woff2?|map|pdf|webp)$)/;
const MARKER = /PLACEHOLDER|[A-Za-z0-9._%+-]+@example\.com/;
/** Input hints and code that detects placeholders are not placeholders. */
const BENIGN = /\bplaceholder\s*[=:]|::placeholder|placeholder-shown|includes\("PLACEHOLDER"\)|\/PLACEHOLDER\/|PLACEHOLDERS\.md|setPlaceholder|placeholderText|_PLACEHOLDER\b|PLACEHOLDER_/i;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(ROOT, p);
    if (SKIP_DIR.test(rel)) continue;
    const st = statSync(p);
    if (st.isDirectory()) yield* files(p);
    else if (!SKIP_FILE.test(rel) && st.size < 5_000_000) yield p;
  }
}

const hits = [];
for (const d of DIRS) {
  for (const f of files(join(ROOT, d))) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!MARKER.test(line)) return;
      // Strip benign uses, then look again: a line may hold both.
      // An input's example value (placeholder="you@example.com") is a hint, not copy.
      const rest = line
        .replace(/placeholder\s*=\s*(["'])[^"']*\1/gi, "")
        .replace(new RegExp(BENIGN.source, "gi"), "");
      if (MARKER.test(rest)) hits.push(`${relative(ROOT, f)}:${i + 1}  ${line.trim().slice(0, 160)}`);
    });
  }
}

if (hits.length) {
  console.error(`✖ ${hits.length} placeholder(s) in shipped code/copy:\n  ` + hits.join("\n  "));
  if (!process.argv.includes("--list")) process.exit(1);
} else {
  console.log(`✔ no placeholders (${DIRS.join(", ")})`);
}
