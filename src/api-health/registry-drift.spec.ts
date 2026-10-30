import * as fs from "fs";
import * as path from "path";
import { JOB_MANIFEST, jobManifest, manifestDrift } from "../common/job-manifest";
import {
  API_CATALOG,
  API_DOCS,
  SCREENS,
  SCREEN_GROUPS,
  checkRequest,
  screensByApi,
  splitKey,
} from "./screen-api.registry";

/**
 * Keeps the two hand-written inventories — the job manifest and the screen/API
 * catalogue — honest by comparing them with the code they describe.
 *
 * Both are documentation that nothing otherwise enforces, and both had already
 * rotted before this existed: three registered jobs were missing from the
 * manifest, and a route added after the last audit was in no document. They are
 * read from SOURCE rather than from a booted app so this runs in CI with no
 * credentials and no network.
 */

const SRC = path.resolve(__dirname, "..");

function sourceFiles(dir: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full, accept));
    else if (accept(full)) out.push(full);
  }
  return out;
}

/** Drops comments so a decorator quoted in a docblock is not mistaken for one. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

const join = (...parts: string[]): string =>
  "/" + parts.map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");

// ── routes, read from the controllers' decorators ────────────────────────────

function controllerRoutes(): Map<string, string> {
  const routes = new Map<string, string>();
  const files = sourceFiles(SRC, (f) => f.endsWith(".controller.ts"));
  expect(files.length).toBeGreaterThan(40);

  for (const file of files) {
    const source = withoutComments(fs.readFileSync(file, "utf8"));
    const rel = path.relative(SRC, file).replace(/\\/g, "/");

    // The scanner understands string-literal decorators only. If a controller
    // starts using another form, fail loudly rather than quietly miss routes.
    const anyDecorator = (source.match(/@(Controller|Get|Post|Put|Patch|Delete|Sse|All|Head|Options)\(/g) ?? []).length;
    const re =
      /@Controller\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)|@(Get|Post|Put|Patch|Delete|Sse)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g;
    let understood = 0;
    let prefix = "";
    for (let m = re.exec(source); m; m = re.exec(source)) {
      understood += 1;
      if (m[0].startsWith("@Controller")) {
        prefix = m[1] ?? "";
        continue;
      }
      const method = m[2] === "Sse" ? "GET" : m[2].toUpperCase();
      routes.set(`${method} ${join(prefix, m[3] ?? "")}`, rel);
    }
    if (understood !== anyDecorator) {
      throw new Error(
        `${rel}: ${anyDecorator} route decorators but this scanner understood ${understood}. ` +
          `A controller used a form it cannot read (object form, array of paths, @All…) — teach the scanner.`,
      );
    }
  }
  return routes;
}

// ── jobs, read from SyncRegistry.register() calls ────────────────────────────

interface RegisteredJob {
  name: string;
  /** null when the collections are not a plain list of string literals. */
  collections: string[] | null;
}

/** The text of a call's argument list, from just after its "(" to the matching ")". */
function callArguments(source: string, start: number): string {
  let depth = 1;
  let quote = "";
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return source.slice(start, i);
  }
  throw new Error("unbalanced registry.register( call");
}

function registeredJobs(): RegisteredJob[] {
  const jobs: RegisteredJob[] = [];
  for (const file of sourceFiles(SRC, (f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"))) {
    const source = withoutComments(fs.readFileSync(file, "utf8"));
    if (!source.includes("registry.register(")) continue;
    const consts: Record<string, string> = {};
    for (const m of source.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*"([a-z0-9-]+)"/g)) consts[m[1]] = m[2];
    for (const m of source.matchAll(/registry\.register\(\s*([A-Z0-9_]+)\s*,/g)) {
      const name = consts[m[1]];
      if (!name) throw new Error(`${file}: cannot resolve job name constant ${m[1]}`);
      const call = callArguments(source, m.index! + "registry.register(".length);
      const list = call.match(/collections:\s*\[([^\]]*)\]/)?.[1] ?? "";
      const literals = [...list.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      const onlyLiterals = list.replace(/"[^"]*"/g, "").replace(/[\s,]/g, "") === "";
      jobs.push({ name, collections: onlyLiterals && literals.length ? literals : null });
    }
  }
  return jobs;
}

describe("job manifest vs registered jobs", () => {
  const jobs = registeredJobs();

  it("finds the registrations it is meant to compare against", () => {
    expect(jobs.length).toBeGreaterThanOrEqual(50);
  });

  it("lists every registered job and nothing that is not registered", () => {
    expect(manifestDrift(jobs.map((j) => j.name))).toEqual({
      missingFromManifest: [],
      missingFromRegistry: [],
    });
  });
});

// ── catalogue vs controllers ─────────────────────────────────────────────────

describe("screen/API catalogue vs controllers", () => {
  const routes = controllerRoutes();

  it("documents no route that does not exist", () => {
    const phantom = Object.keys(API_CATALOG).filter((k) => !routes.has(k));
    expect(phantom).toEqual([]);
  });

  it("documents every route the controllers define", () => {
    // Adding a route? Add it to API_CATALOG (screen-api.registry.ts) — and to
    // the screens that call it — so the admin API Docs tab stays complete.
    const undocumented = [...routes.keys()].filter((k) => !(k in API_CATALOG));
    expect(undocumented).toEqual([]);
  });
});

// ── catalogue internals ──────────────────────────────────────────────────────

describe("screen/API catalogue", () => {
  const manifestNames = new Set(JOB_MANIFEST.map((j) => j.name));

  it("uses well-formed keys", () => {
    for (const key of Object.keys(API_CATALOG)) {
      const { method, path: p } = splitKey(key);
      expect(["GET", "POST", "PATCH", "PUT", "DELETE"]).toContain(method);
      expect(p.startsWith("/")).toBe(true);
      expect(p).not.toMatch(/\s|\/$/);
    }
  });

  it("gives every API a real sentence of description", () => {
    for (const doc of API_DOCS) expect({ key: doc.key, ok: doc.summary.length >= 12 }).toEqual({ key: doc.key, ok: true });
  });

  it("has unique screen ids, known groups, and no API listed twice on a screen", () => {
    const ids = SCREENS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const screen of SCREENS) {
      expect(SCREEN_GROUPS).toContain(screen.group);
      expect(new Set(screen.apis).size).toBe(screen.apis.length);
      expect(screen.label.length).toBeGreaterThan(2);
      expect(screen.summary.length).toBeGreaterThan(10);
    }
  });

  it("refers only to jobs the manifest knows", () => {
    for (const doc of API_DOCS) {
      for (const job of [...(doc.producers ?? []), ...(doc.alsoWrittenBy ?? [])]) {
        expect({ api: doc.key, job, known: manifestNames.has(job) }).toEqual({ api: doc.key, job, known: true });
      }
    }
  });

  it("only names a job a producer if that job declares writing the data", () => {
    const declared = new Map(registeredJobs().map((j) => [j.name, j.collections] as const));

    // Jobs whose registration lists no plain collections (computed in code).
    const notChecked = [...declared.entries()].filter(([, c]) => c === null).map(([n]) => n).sort();
    expect(notChecked).toEqual(["auto-purge", "volume-leaders"]);

    // Jobs that write a collection their registration does not mention. The
    // registration is metadata for the ops monitor, not enforced, so it can
    // lag the code; each entry here is a fact read off the job source.
    const writesBeyondDeclaration: Record<string, string[]> = {
      // earnings-actuals stores an AI "announcement" analysis per result through
      // TickerAiAnalysisService.recordAnnouncement (TICKER_AI_COLLECTION =
      // "ticker_ai_analysis"), but registers only earnings_events.
      "earnings-actuals": ["ticker_ai_analysis"],
      // analyst-firm-stats batch-writes per-ticker outcomes to analyst_calls
      // (analyst-firm-stats.job.ts) but registers only analyst_firm_stats.
      "analyst-firm-stats": ["analyst_calls"],
    };

    // A store entry like "fund_holdings/{cik}/filings/{accession}/positions"
    // belongs to the job that writes its top-level collection.
    const topLevel = (name: string): string => name.split("/")[0];

    const mismatches: string[] = [];
    for (const doc of API_DOCS) {
      for (const job of doc.producers ?? []) {
        const cols = declared.get(job);
        if (!cols) continue; // computed in code — see notChecked
        const writes = [...cols, ...(writesBeyondDeclaration[job] ?? [])].map(topLevel);
        const store = (doc.store ?? []).map(topLevel);
        if (!store.some((s) => writes.includes(s))) {
          mismatches.push(
            `${doc.key}: producer "${job}" writes [${writes.join(", ")}] but the API serves [${store.join(", ")}]`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("gives the producer list to every API that reads a job-filled shared collection", () => {
    // An API served straight from a shared list must say which job fills it, or
    // its status cannot follow that job.
    const expectsProducer = [
      "GET /market-data/movers",
      "GET /market-data/sectors",
      "GET /market-data/recaps",
      "GET /market-data/market-sentiment",
      "GET /market-data/macro-events",
      "GET /market-data/ipos",
      "GET /market-data/analyst-actions",
      "GET /market-data/insider-transactions",
    ] as const;
    for (const key of expectsProducer) {
      const n = (API_CATALOG[key] as { producers?: readonly string[] }).producers?.length ?? 0;
      expect({ key, hasProducers: n > 0 }).toEqual({ key, hasProducers: true });
    }
  });

  it("is consistent about what each screen shares with the others", () => {
    const users = screensByApi();
    // Every catalogued API is either used by a screen or openly unused.
    const unused = API_DOCS.filter((d) => !users.get(d.key)).map((d) => d.key);
    expect(unused.length).toBeGreaterThan(0); // diagnostics, legacy and ops routes exist
    // …and the UI-facing core is not among them.
    for (const core of ["GET /market-data/companies", "GET /live/snapshot", "GET /api/portfolio"]) {
      expect(users.get(core)?.length ?? 0).toBeGreaterThan(3);
    }
  });
});

describe("checkRequest", () => {
  const doc = (over: Record<string, unknown>) =>
    ({ method: "GET", path: "/x", ...over }) as Parameters<typeof checkRequest>[0];

  it("calls a parameterless GET as is", () => {
    expect(checkRequest(doc({}))).toEqual({ url: "/x" });
  });

  it("appends a sample query when one is defined", () => {
    expect(checkRequest(doc({ params: "ticker", check: { query: "?ticker=AAPL" } }))).toEqual({ url: "/x?ticker=AAPL" });
  });

  it("will not guess at parameters it has no sample for", () => {
    expect(checkRequest(doc({ params: "ticker" }))).toEqual({ skip: "needs parameters, and no sample is defined" });
    expect(checkRequest(doc({ path: "/x/:id" }))).toEqual({ skip: "needs a path parameter" });
  });

  it("never checks a write, a stream, or something marked skip", () => {
    expect(checkRequest(doc({ method: "POST" }))).toEqual({ skip: "changes data" });
    expect(checkRequest(doc({ method: "DELETE" }))).toEqual({ skip: "changes data" });
    expect(checkRequest(doc({ sse: true }))).toEqual({ skip: "a Server-Sent Events stream" });
    expect(checkRequest(doc({ check: { skip: "costs money" } }))).toEqual({ skip: "costs money" });
  });

  it("only ever proposes GETs that are safe to repeat", () => {
    for (const d of API_DOCS) {
      const plan = checkRequest(d);
      if ("url" in plan) {
        expect({ key: d.key, method: d.method }).toEqual({ key: d.key, method: "GET" });
        // Anything that can start an LLM generation must have opted out.
        expect({ key: d.key, llm: (d.vendors ?? []).includes("Groq") }).toEqual({ key: d.key, llm: false });
      }
    }
    expect(jobManifest("news")).toBeDefined();
  });
});
