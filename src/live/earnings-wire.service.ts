import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";

/**
 * Earnings results as News-feed rows (Live Feed → News).
 *
 * The news wire (news-wire.service.ts) only carries what FMP publishes as an
 * article, so a company declaring its earnings reached the feed only when an
 * outlet wrote it up or its 8-K happened to be in the latest-100 filings. This
 * turns the stored results themselves — `earnings_events` rows that already
 * hold an actual (written by the earnings-actuals job as results land, and by
 * the nightly earnings job) — into rows shaped like the `news` collection, so
 * the UI merges them straight into the stream. Deterministic: exact figures
 * from the data, no model call.
 *
 * Read-only and cached for a minute, so feed polling never grows Firestore
 * traffic with the number of viewers.
 */

const CACHE_MS = 60_000;
/** ET calendar days of results kept (today + yesterday — the feed is a tape). */
const DAYS = 2;
const DAY = 86_400_000;
/** Cap on rows returned — a peak reporting day is a few hundred names. */
const MAX_ROWS = 200;

export interface EarningsWireDoc {
  id: string;
  ticker: string;
  headline: string;
  summary: string;
  source: string;
  vendor: string;
  /** Not a web link: a stable key so the UI dedupes, and the UI shows no
   *  "Read article" link for a non-http(s) url. */
  url: string;
  category: null;
  tag: "earnings";
  filler: false;
  sentiment: "positive" | "negative" | "neutral" | null;
  sentimentReasoning: null;
  keywords: string[];
  imageUrl: null;
  publishedAt: string;
  updatedAt: string;
}

type Row = {
  ticker?: string;
  companyName?: string | null;
  date?: string;
  fiscalPeriod?: string | number | null;
  fiscalYear?: string | number | null;
  epsEstimate?: number | null;
  epsActual?: number | null;
  revenueEstimate?: number | null;
  revenueActual?: number | null;
  actualsUpdatedAt?: string | null;
  updatedAt?: string | null;
};

const etDay = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const eps = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

function money(n: number): string {
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : a.toFixed(0);
  return `${n < 0 ? "-" : ""}$${s}`;
}

const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

/** Surprise vs consensus, in percent; null when there is no usable estimate. */
const surprise = (actual: number | null | undefined, estimate: number | null | undefined) =>
  isNum(actual) && isNum(estimate) && estimate !== 0 ? ((actual - estimate) / Math.abs(estimate)) * 100 : null;

/** Same bands the Announcement tab's verdict uses (earnings-actuals.job). */
const verdictOf = (s: number | null): "beat" | "miss" | "in-line" | null =>
  s == null ? null : s > 1 ? "beat" : s < -1 ? "miss" : "in-line";

/** One stored result → one feed row; null when it holds no reported figure. */
export function toWireDoc(r: Row): EarningsWireDoc | null {
  const ticker = String(r.ticker ?? "").trim().toUpperCase();
  const date = String(r.date ?? "");
  const hasEps = isNum(r.epsActual);
  const hasRev = isNum(r.revenueActual);
  if (!ticker || !date || (!hasEps && !hasRev)) return null;

  const name = (r.companyName ?? "").trim() || ticker;
  const period = [r.fiscalPeriod, r.fiscalYear != null ? `FY${r.fiscalYear}` : null]
    .filter((x) => x != null && String(x).trim() !== "")
    .join(" ");

  const epsS = surprise(r.epsActual, r.epsEstimate);
  const revS = surprise(r.revenueActual, r.revenueEstimate);
  const verdict = verdictOf(epsS ?? revS);

  const epsPart = hasEps
    ? `EPS ${eps(r.epsActual as number)}${isNum(r.epsEstimate) ? ` vs ${eps(r.epsEstimate)} est.` : ""}`
    : null;
  const revPart = hasRev
    ? `revenue ${money(r.revenueActual as number)}${isNum(r.revenueEstimate) ? ` vs ${money(r.revenueEstimate)} est.` : ""}`
    : null;

  const headline =
    `${ticker}: ${name} reports ${period ? `${period} ` : ""}results` +
    (verdict ? ` — ${verdict === "in-line" ? "in line" : verdict}` : "") +
    (epsPart ? ` (${epsPart})` : "");

  const detail: string[] = [];
  if (epsPart) detail.push(`${epsPart}${epsS != null ? ` (${pct(epsS)} surprise)` : ""}`);
  if (revPart) detail.push(`${revPart}${revS != null ? ` (${pct(revS)} surprise)` : ""}`);
  const summary = `${name} reported ${detail.join("; ")}.`;

  const when = r.actualsUpdatedAt || r.updatedAt || `${date}T21:00:00.000Z`;
  const t = Date.parse(when);
  const publishedAt = Number.isFinite(t) ? new Date(t).toISOString() : `${date}T21:00:00.000Z`;

  return {
    id: `earnings_${ticker}_${date}`,
    ticker,
    headline,
    summary,
    source: "Earnings results",
    vendor: "fmp",
    url: `earnings://${ticker}/${date}`,
    category: null,
    tag: "earnings",
    filler: false,
    sentiment: verdict === "beat" ? "positive" : verdict === "miss" ? "negative" : verdict === "in-line" ? "neutral" : null,
    sentimentReasoning: null,
    keywords: [],
    imageUrl: null,
    publishedAt,
    updatedAt: publishedAt,
  };
}

@Injectable()
export class EarningsWireService {
  private readonly logger = new Logger(EarningsWireService.name);
  private cache: { at: number; items: EarningsWireDoc[] } | null = null;
  private inflight: Promise<EarningsWireDoc[]> | null = null;

  constructor(private readonly firebase: FirebaseAdminService) {}

  /** Newest first. Served from memory for CACHE_MS; concurrent readers share one read. */
  async latest(): Promise<EarningsWireDoc[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.items;
    if (!this.inflight) {
      this.inflight = this.load()
        .then((items) => {
          this.cache = { at: Date.now(), items };
          return items;
        })
        .catch((err) => {
          // Keep serving the last good copy; an empty tape beats a failed feed.
          this.logger.warn(`earnings wire read failed: ${(err as Error)?.message ?? err}`);
          return this.cache?.items ?? [];
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private async load(): Promise<EarningsWireDoc[]> {
    const now = Date.now();
    const days = Array.from({ length: DAYS }, (_, i) => etDay(now - i * DAY));
    const snap = await this.firebase.firestore
      .collection("earnings_events")
      .where("date", "in", days)
      .get();
    return snap.docs
      .map((d) => toWireDoc(d.data() as Row))
      .filter((d): d is EarningsWireDoc => d != null)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, MAX_ROWS);
  }
}
