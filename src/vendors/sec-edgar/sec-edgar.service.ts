import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { XMLParser } from "fast-xml-parser";
import { fetchJson } from "../../common/http.util";

const SUBMISSIONS_BASE = "https://data.sec.gov/submissions";
const ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data";

/** Filing HTML -> plain text. Entities are decoded because the numeric ones
 *  (&#x201c;) otherwise land mid-sentence in stored guidance snippets. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&(?:quot|ldquo|rdquo);/gi, '"')
    .replace(/&(?:apos|lsquo|rsquo);/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d2) => String.fromCodePoint(Number(d2)))
    .replace(/\s+/g, " ")
    .trim();
}
const MIN_DELAY_MS = 150;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
});

// 13F information tables are frequently namespaced (<ns1:informationTable>,
// <ns1:infoTable>, <ns1:value>…). The default parser keeps those prefixes as
// literal keys, so `parsed.informationTable` is undefined and every field
// coerces to 0 — which is exactly why some funds (e.g. Bridgewater) wrote
// $0 / 0 positions. This parser strips namespace prefixes so both namespaced
// and un-namespaced filings resolve to the same keys. Kept SEPARATE from
// `xmlParser` so the Form 4 path (un-namespaced today) is not affected.
const xmlParserNS = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  removeNSPrefix: true,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SecFiling {
  form: string;
  filingDate: string;
  accessionNumber: string;
  primaryDocument: string;
  /** SEC acceptance timestamp, e.g. "2026-02-04T16:05:31.000Z"-ish local ET
   *  string "2026-02-04T16:05:31.000Z". Used to derive BMO/AMC session. */
  acceptanceDateTime?: string;
  /** 8-K item codes as a comma/space string, e.g. "2.02,9.01". */
  items?: string;
  /** Period-of-report (event date) for the filing when present. */
  reportDate?: string;
  /** Short human description of the primary document, when present. */
  primaryDocDescription?: string;
}

@Injectable()
export class SecEdgarService {
  private readonly logger = new Logger(SecEdgarService.name);
  private readonly userAgent: string;
  private lastRequestAt = 0;
  // ticker -> CIK, from SEC's company_tickers.json. Cached in memory (the file
  // is ~800KB and changes rarely) and refreshed daily; concurrent callers share
  // one in-flight fetch so a burst of on-demand misses doesn't refetch it.
  private tickerCikMap: Map<string, string> | null = null;
  private tickerCikMapAt = 0;
  private tickerCikMapInFlight: Promise<Map<string, string>> | null = null;

  constructor(private readonly config: ConfigService) {
    this.userAgent = this.config.get(
      "SEC_EDGAR_USER_AGENT",
      "Market Catalyst Backend (unset-contact@example.com)",
    );
  }

  private async throttledFetch(url: string): Promise<any> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < MIN_DELAY_MS) await sleep(MIN_DELAY_MS - elapsed);
    this.lastRequestAt = Date.now();
    return fetchJson(url, { headers: { "User-Agent": this.userAgent } });
  }

  private async throttledFetchText(url: string): Promise<string> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < MIN_DELAY_MS) await sleep(MIN_DELAY_MS - elapsed);
    this.lastRequestAt = Date.now();
    const res = await fetch(url, { headers: { "User-Agent": this.userAgent } });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.text();
  }

  private pad10(cik: string): string {
    return cik.replace(/\D/g, "").padStart(10, "0");
  }

  async getSubmissions(
    cik: string,
  ): Promise<{ name: string; recentFilings: SecFiling[] }> {
    const data = await this.throttledFetch(
      `${SUBMISSIONS_BASE}/CIK${this.pad10(cik)}.json`,
    );
    const r = data.filings.recent;
    const recentFilings = r.form.map((form: string, i: number) => ({
      form,
      filingDate: r.filingDate[i],
      accessionNumber: r.accessionNumber[i],
      primaryDocument: r.primaryDocument[i],
      // These arrays are always present on the submissions payload; guard anyway
      // so a shape change degrades to undefined rather than throwing.
      acceptanceDateTime: r.acceptanceDateTime?.[i],
      items: r.items?.[i],
      reportDate: r.reportDate?.[i],
      primaryDocDescription: r.primaryDocDescription?.[i],
    }));
    return { name: data.name, recentFilings };
  }

  /** ticker -> zero-padded-free CIK string, from SEC's company_tickers.json. */
  private async getTickerCikMap(): Promise<Map<string, string>> {
    const DAY_MS = 24 * 60 * 60 * 1000;
    if (this.tickerCikMap && Date.now() - this.tickerCikMapAt < DAY_MS) {
      return this.tickerCikMap;
    }
    if (this.tickerCikMapInFlight) return this.tickerCikMapInFlight;
    this.tickerCikMapInFlight = (async () => {
      const data = (await this.throttledFetch(
        "https://www.sec.gov/files/company_tickers.json",
      )) as Record<string, { ticker?: string; cik_str?: number | string }>;
      const map = new Map<string, string>();
      for (const row of Object.values(data)) {
        if (row?.ticker && row.cik_str != null) {
          map.set(String(row.ticker).toUpperCase(), String(row.cik_str));
        }
      }
      this.tickerCikMap = map;
      this.tickerCikMapAt = Date.now();
      return map;
    })();
    try {
      return await this.tickerCikMapInFlight;
    } finally {
      this.tickerCikMapInFlight = null;
    }
  }

  /**
   * SEC-registered SIC code for a ticker (authoritative, free), or null.
   *
   * Fallback for tickers Polygon returns WITHOUT a `sic_code` — typically
   * foreign private issuers / ADRs (e.g. GAUZ, a 20-F filer). SEC SIC codes are
   * the same standard `classifyFromSic` already consumes, so this fills
   * sector/industry in the SAME TradingView taxonomy the app standardises on —
   * no second vocabulary introduced. Fail-safe: any error resolves to null so
   * the caller keeps whatever profile it already has.
   */
  async getSicByTicker(ticker: string): Promise<string | null> {
    try {
      const cik = (await this.getTickerCikMap()).get(ticker.toUpperCase());
      if (!cik) return null;
      const data = await this.throttledFetch(
        `${SUBMISSIONS_BASE}/CIK${this.pad10(cik)}.json`,
      );
      const sic = data?.sic == null ? "" : String(data.sic).trim();
      return sic && sic !== "0" ? sic : null;
    } catch (err) {
      this.logger.warn(
        `getSicByTicker(${ticker}) failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Plain text of a filing's earnings press release (exhibit 99.x), or null.
   *
   * The exhibit is located by its TYPE in the filing index page, NOT by
   * filename. Guessing from the filename (`ex-99*`) was measured against 50
   * live filings and found only 26 of them — Walmart, Cisco and Lilly all name
   * the file things like `earningsreleasefy27q2.htm`. Reading the type column
   * finds all 50.
   */
  async getEarningsPressRelease(
    cik: string,
    accessionNumber: string,
  ): Promise<string | null> {
    const accNoDash = accessionNumber.replace(/-/g, "");
    const base = `${ARCHIVES_BASE}/${this.pad10(cik)}/${accNoDash}`;
    const indexHtml = await this.throttledFetchText(
      `${base}/${accessionNumber}-index.htm`,
    );
    let href: string | null = null;
    for (const row of indexHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
      if (!/EX-99/i.test(row)) continue;
      const m = row.match(/href="([^"]+\.(?:htm|html|txt))"/i);
      if (m) {
        href = m[1];
        break;
      }
    }
    if (!href) return null;
    const url = href.startsWith("http") ? href : `https://www.sec.gov${href}`;
    return stripHtml(await this.throttledFetchText(url));
  }

  private async getFilingFileNames(
    cik: string,
    accessionNumber: string,
  ): Promise<string[]> {
    const accNoDash = accessionNumber.replace(/-/g, "");
    const idx = await this.throttledFetch(
      `${ARCHIVES_BASE}/${this.pad10(cik)}/${accNoDash}/index.json`,
    );
    return idx.directory.item.map((i: any) => i.name);
  }

  async get13FInformationTable(
    cik: string,
    accessionNumber: string,
  ): Promise<unknown[]> {
    const accNoDash = accessionNumber.replace(/-/g, "");
    const files = await this.getFilingFileNames(cik, accessionNumber);
    const infoTableFile = files.find(
      (f) =>
        f.endsWith(".xml") && f !== "primary_doc.xml" && !f.includes("index"),
    );
    if (!infoTableFile) {
      throw new Error(
        `No information table XML found in filing ${accessionNumber} for CIK ${cik}`,
      );
    }
    const xml = await this.throttledFetchText(
      `${ARCHIVES_BASE}/${this.pad10(cik)}/${accNoDash}/${infoTableFile}`,
    );
    const parsed = xmlParserNS.parse(xml);
    const rows = parsed.informationTable?.infoTable ?? [];
    return Array.isArray(rows) ? rows : [rows];
  }

  async getForm4Transactions(
    cik: string,
    accessionNumber: string,
  ): Promise<
    | {
        issuer: null;
        owner: null;
        transactions: never[];
      }
    | {
        issuer: {
          cik: string | undefined;
          name: string | undefined;
          ticker: string | undefined;
        };
        owner: {
          cik: string | undefined;
          name: string | undefined;
          isOfficer: boolean;
          officerTitle: string | null;
        };
        transactions: any[];
      }
  > {
    const accNoDash = accessionNumber.replace(/-/g, "");
    const files = await this.getFilingFileNames(cik, accessionNumber);
    const form4File = files.find(
      (f) => f.endsWith(".xml") && !f.includes("index"),
    );
    if (!form4File) {
      throw new Error(
        `No Form 4 XML found in filing ${accessionNumber} for CIK ${cik}`,
      );
    }
    const xml = await this.throttledFetchText(
      `${ARCHIVES_BASE}/${this.pad10(cik)}/${accNoDash}/${form4File}`,
    );
    const parsed = xmlParser.parse(xml);
    const doc = parsed.ownershipDocument;
    if (!doc) return { issuer: null, owner: null, transactions: [] };
    const rows = doc.nonDerivativeTable?.nonDerivativeTransaction ?? [];
    const transactions = Array.isArray(rows) ? rows : [rows];
    return {
      issuer: {
        cik: doc.issuer?.issuerCik,
        name: doc.issuer?.issuerName,
        ticker: doc.issuer?.issuerTradingSymbol,
      },
      owner: {
        cik: doc.reportingOwner?.reportingOwnerId?.rptOwnerCik,
        name: doc.reportingOwner?.reportingOwnerId?.rptOwnerName,
        isOfficer:
          doc.reportingOwner?.reportingOwnerRelationship?.isOfficer ===
            "true" ||
          doc.reportingOwner?.reportingOwnerRelationship?.isOfficer === true,
        officerTitle:
          doc.reportingOwner?.reportingOwnerRelationship?.officerTitle ?? null,
      },
      transactions,
    };
  }
}
