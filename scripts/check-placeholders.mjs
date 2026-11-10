#!/usr/bin/env node
/**
 * Lists every remaining placeholder across MarketCatalystBackEnd, MarketCatalystUI
 * and MarketCatalystWebsite: any value containing "PLACEHOLDER" or an
 * example.com address in shipped source, copy or env templates.
 *
 *   node scripts/check-placeholders.mjs               # list (exit 0)
 *   node scripts/check-placeholders.mjs --production  # exit 1 if anything would ship as a placeholder
 *   node scripts/check-placeholders.mjs --production --cloud-run [--project=<id>]
 *        # also accept settings already present on the Cloud Run services
 *        # (secret references by NAME only — secret values are never read)
 *   node scripts/check-placeholders.mjs --production --service-config=<file.json>
 *        # same, from a JSON file: { "<service>": { "<ENV>": {"secret":"<name>"} | {"value":"…"} } }
 *   node scripts/check-placeholders.mjs --json
 *
 * In --production mode:
 *   - a placeholder in code or copy fails, EXCEPT a config default read through
 *     config.get("NAME", …) / process.env.NAME — then the env var NAME must be set
 *     to a real (non-placeholder) value in the current environment instead;
 *   - env templates (.env.example) are documentation and never fail;
 *   - required production settings must be present and non-placeholder: either
 *     in the local env, or (with --cloud-run / --service-config) on EVERY Cloud
 *     Run service that needs them — a Secret Manager reference counts as set.
 * Tests, fixtures and docs are not scanned.
 */
import { execFileSync } from "node:child_process";
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

/** Settings production cannot run billing without, and the services that read them. */
export const LIVE = "market-catalyst-live";
export const WORKER = "market-catalyst-backend";
export const REQUIRED_PRODUCTION_ENV = [
  { name: "STRIPE_SECRET_KEY", secret: true, services: [LIVE, WORKER] },
  { name: "STRIPE_WEBHOOK_SECRET", secret: true, services: [LIVE] },
  { name: "STRIPE_PORTAL_CONFIGURATION", secret: false, services: [LIVE] },
  { name: "EMAIL_PROVIDER", secret: false, services: [LIVE, WORKER] },
  { name: "EMAIL_PROVIDER_API_KEY", secret: true, services: [LIVE, WORKER] },
  { name: "EMAIL_FROM_ADDRESS", secret: false, services: [LIVE, WORKER] },
  { name: "EMAIL_REPLY_TO", secret: false, services: [LIVE, WORKER] },
  { name: "STREAM_TICKET_SECRET", secret: true, services: [LIVE] },
];
/** Backend config defaults (config.get) are read by both services. */
const BACKEND_SERVICES = [LIVE, WORKER];

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

const bad = (v) => !v || MARKER.test(v);

/** Where a setting is satisfied on one service: "secret" (by reference), "value", or null. */
function onService(services, service, name) {
  const e = services?.[service]?.[name];
  if (!e) return null;
  if (e.secret) return "secret";
  return bad(e.value) ? null : "value";
}

/**
 * services: optional { "<service>": { "<ENV>": {secret} | {value} } } — what is
 * configured on each Cloud Run service. A setting is satisfied by a real local
 * env value, or by being present on every service that needs it.
 */
export function productionProblems(hits, env = process.env, services = null) {
  const problems = [];
  const missingOn = (name, needed) =>
    services ? needed.filter((svc) => !onService(services, svc, name)) : needed;
  for (const h of hits) {
    if (h.kind === "code-or-copy") problems.push(`${h.file}:${h.line} placeholder in shipped code/copy: ${h.text}`);
    if (h.kind !== "env-default" || !bad(env[h.envVar])) continue;
    const backendCode = h.file.startsWith("MarketCatalystBackEnd/src/");
    if (services && backendCode && missingOn(h.envVar, BACKEND_SERVICES).length === 0) continue;
    problems.push(`${h.file}:${h.line} default is a placeholder and ${h.envVar} is not set to a real value`);
  }
  for (const r of REQUIRED_PRODUCTION_ENV) {
    if (!bad(env[r.name])) continue;
    const missing = missingOn(r.name, r.services);
    if (missing.length === 0) continue;
    problems.push(
      services
        ? `env ${r.name} is not set on ${missing.join(", ")}${r.secret ? " (expected a Secret Manager reference)" : ""}`
        : `env ${r.name} is missing or a placeholder`,
    );
  }
  return [...new Set(problems)];
}

/** Reads the Cloud Run service config via gcloud: secret NAMES and plain values only. */
export function cloudRunServices(project, region = "us-central1") {
  const out = {};
  for (const svc of [LIVE, WORKER]) {
    const json = execFileSync("gcloud", ["run", "services", "describe", svc, `--region=${region}`, `--project=${project}`, "--format=json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const env = JSON.parse(json).spec.template.spec.containers[0].env ?? [];
    out[svc] = Object.fromEntries(env.map((e) => [e.name, e.valueFrom?.secretKeyRef ? { secret: e.valueFrom.secretKeyRef.name } : { value: e.value ?? "" }]));
  }
  return out;
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
    const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
    let services = null;
    if (arg("service-config")) services = JSON.parse(readFileSync(arg("service-config"), "utf8"));
    else if (process.argv.includes("--cloud-run")) services = cloudRunServices(arg("project") ?? "market-catalyst-502415");
    if (services) {
      for (const r of REQUIRED_PRODUCTION_ENV)
        for (const svc of r.services) {
          const how = onService(services, svc, r.name);
          if (how) console.log(`  ✓ ${r.name} on ${svc}: ${how === "secret" ? `Secret Manager (${services[svc][r.name].secret})` : "set"}`);
        }
    }
    const problems = productionProblems(hits, process.env, services);
    if (problems.length) {
      console.error(`\n--production: ${problems.length} problem(s) — not ready to ship:`);
      for (const p of problems) console.error(`  ✗ ${p}`);
      process.exit(1);
    }
    console.log("\n--production: no placeholders would ship.");
  }
}
