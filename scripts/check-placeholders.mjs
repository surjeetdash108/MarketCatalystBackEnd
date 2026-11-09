#!/usr/bin/env node
/**
 * Lists every remaining placeholder across MarketCatalystBackEnd, MarketCatalystUI
 * and MarketCatalystWebsite: any value containing "PLACEHOLDER" or an
 * example.com address in shipped source, copy or env templates.
 *
 *   node scripts/check-placeholders.mjs               # list (exit 0)
 *   node scripts/check-placeholders.mjs --production  # exit 1 if anything would ship as a placeholder
 *   node scripts/check-placeholders.mjs --json
 *
 * In --production mode:
 *   - a placeholder in code or copy fails, EXCEPT a config default read through
 *     config.get("NAME", …) / process.env.NAME — then the env var NAME must be set
 *     to a real (non-placeholder) value in the current environment instead;
 *   - env templates (.env.example) are documentation and never fail;
 *   - required production secrets must be present and non-placeholder.
 * Tests, fixtures and docs are not scanned.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const REPOS = {
  MarketCatalystBackEnd: ["src", "scripts", "deploy", ".env.example"],
  MarketCatalystUI: ["app", "public/admin", "firestore.rules", ".env.example"],
  MarketCatalystWebsite: ["app", "components", "lib", "content", ".env.example"],
};
const SKIP_DIR = /(^|\/)(node_modules|dist|\.next|out|test|tests|fixtures|__snapshots__)(\/|$)/;
const SKIP_FILE = /(\.spec\.|\.test\.|\.e2e-spec\.|check-placeholders\.mjs$|home\.html$|\.(css|png|jpg|jpeg|gif|ico|svg|woff2?|map)$)/;
/** Lines that mention placeholders without being one: doc pointers, the detectors, HTML input hints. */
const NOT_A_PLACEHOLDER = /PLACEHOLDERS\.md|\/PLACEHOLDER\/|includes\("PLACEHOLDER"\)|\bplaceholder="/;
const MARKER = /PLACEHOLDER|[A-Za-z0-9._%+-]+@example\.com/;
const ENV_DEFAULT = /(?:config\.get(?:<[^>]*>)?\(\s*["']([A-Z0-9_]+)["']|process\.env\.([A-Z0-9_]+))/;

/** Secrets/config production cannot run billing without. */
export const REQUIRED_PRODUCTION_ENV = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PORTAL_CONFIGURATION",
  "STRIPE_RETENTION_COUPON_ID",
  "EMAIL_PROVIDER_API_KEY",
  "EMAIL_FROM_ADDRESS",
  "EMAIL_REPLY_TO",
  "STREAM_TICKET_SECRET",
];

function walk(abs) {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return [abs];
  return readdirSync(abs).flatMap((f) => {
    const p = join(abs, f);
    if (SKIP_DIR.test(relative(ROOT, p))) return [];
    return walk(p);
  });
}

export function scan() {
  const hits = [];
  for (const [repo, paths] of Object.entries(REPOS)) {
    for (const p of paths) {
      for (const file of walk(join(ROOT, repo, p))) {
        if (SKIP_FILE.test(file)) continue;
        const rel = relative(ROOT, file);
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (!MARKER.test(line) || NOT_A_PLACEHOLDER.test(line)) return;
          const env = line.match(ENV_DEFAULT);
          hits.push({
            file: rel,
            line: i + 1,
            text: line.trim().slice(0, 160),
            kind: rel.endsWith(".env.example") ? "env-template" : env ? "env-default" : "code-or-copy",
            envVar: env ? env[1] ?? env[2] : rel.endsWith(".env.example") ? line.split("=")[0].trim() : null,
          });
        });
      }
    }
  }
  return hits;
}

export function productionProblems(hits, env = process.env) {
  const problems = [];
  const bad = (v) => !v || MARKER.test(v);
  for (const h of hits) {
    if (h.kind === "code-or-copy") problems.push(`${h.file}:${h.line} placeholder in shipped code/copy: ${h.text}`);
    if (h.kind === "env-default" && bad(env[h.envVar])) problems.push(`${h.file}:${h.line} default is a placeholder and ${h.envVar} is not set to a real value`);
  }
  for (const k of REQUIRED_PRODUCTION_ENV) if (bad(env[k])) problems.push(`env ${k} is missing or a placeholder`);
  return [...new Set(problems)];
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const hits = scan();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(hits, null, 2));
  } else {
    const byKind = (k) => hits.filter((h) => h.kind === k);
    console.log(`Placeholders found: ${hits.length} (code/copy ${byKind("code-or-copy").length}, env-backed defaults ${byKind("env-default").length}, env templates ${byKind("env-template").length})`);
    for (const h of hits) console.log(`  [${h.kind}] ${h.file}:${h.line}  ${h.text}`);
  }
  if (process.argv.includes("--production")) {
    const problems = productionProblems(hits);
    if (problems.length) {
      console.error(`\n--production: ${problems.length} problem(s) — not ready to ship:`);
      for (const p of problems) console.error(`  ✗ ${p}`);
      process.exit(1);
    }
    console.log("\n--production: no placeholders would ship.");
  }
}
