import { Logger } from "@nestjs/common";
import type { Firestore } from "firebase-admin/firestore";

/**
 * Ticker -> CIK, cached in Firestore.
 *
 * WHY THIS IS CACHED RATHER THAN FETCHED EACH RUN
 * `edgar-8k` and `sec-form4` both used to fetch company_tickers.json from
 * sec.gov on every single run and call res.json() on the result. SEC
 * intermittently serves datacenter IPs an HTML bot-block page instead of JSON,
 * which surfaced as the useless error `Unexpected token '<', "<!DOCTYPE "...`
 * and failed the WHOLE job before it processed a single ticker. It hit
 * sec-form4 on 2026-08-07 and edgar-8k on 2026-08-23; the same URL returns
 * clean JSON from a residential IP at the same moment, so it is the egress
 * address being blocked, not our User-Agent.
 *
 * The CIK map changes very slowly (new listings only), so caching it removes a
 * hard dependency on a flaky call, cuts two SEC requests per job run, and lets
 * a blocked fetch degrade to the stored copy instead of failing the run.
 */

const DOC_PATH = "reference/sec_cik_map";
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const SOURCE_URL = "https://www.sec.gov/files/company_tickers.json";

const logger = new Logger("SecCikMap");

interface CachedMap {
  updatedAt: string;
  count: number;
  map: Record<string, string>;
}

/** Fetches from SEC. Throws a DESCRIPTIVE error when the bot-block page comes
 *  back, so the logs say what happened instead of a JSON parse error. */
async function fetchFromSec(userAgent: string): Promise<Map<string, string>> {
  const res = await fetch(SOURCE_URL, { headers: { "User-Agent": userAgent } });
  const body = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (!res.ok || !ct.includes("json") || body.trimStart().startsWith("<")) {
    throw new Error(
      `SEC returned ${res.status} ${ct || "no content-type"} (likely the bot-block page): ${body.slice(0, 80).replace(/\s+/g, " ")}`,
    );
  }
  const data = JSON.parse(body) as Record<
    string,
    { ticker: string; cik_str: string | number }
  >;
  const map = new Map<string, string>();
  for (const e of Object.values(data)) {
    if (e?.ticker) map.set(String(e.ticker).toUpperCase(), String(e.cik_str));
  }
  if (map.size === 0) throw new Error("SEC ticker map parsed but was empty");
  return map;
}

/**
 * Cached map, refreshing from SEC at most weekly. A failed refresh falls back
 * to the stored copy at ANY age — a month-old CIK map is vastly better than a
 * dead job, since CIKs never change for an existing listing.
 */
export async function getTickerToCik(
  db: Firestore,
  userAgent: string,
): Promise<Map<string, string>> {
  const ref = db.doc(DOC_PATH);
  const snap = await ref.get().catch(() => null);
  const cached = snap?.exists ? (snap.data() as CachedMap) : null;
  const age = cached?.updatedAt
    ? Date.now() - Date.parse(cached.updatedAt)
    : Infinity;

  if (cached?.map && age < REFRESH_AFTER_MS) {
    return new Map(Object.entries(cached.map));
  }

  try {
    const fresh = await fetchFromSec(userAgent);
    await ref.set({
      updatedAt: new Date().toISOString(),
      count: fresh.size,
      map: Object.fromEntries(fresh),
    } satisfies CachedMap);
    logger.log(`refreshed SEC CIK map from sec.gov (${fresh.size} tickers)`);
    return fresh;
  } catch (err) {
    if (cached?.map) {
      logger.warn(
        `SEC CIK refresh failed, using cached map from ${cached.updatedAt}: ${(err as Error).message}`,
      );
      return new Map(Object.entries(cached.map));
    }
    throw new Error(
      `SEC CIK map unavailable and nothing cached at ${DOC_PATH}: ${(err as Error).message}`,
    );
  }
}
