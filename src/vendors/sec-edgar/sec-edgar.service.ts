import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { XMLParser } from "fast-xml-parser";
import { fetchJson } from "../../common/http.util";

const SUBMISSIONS_BASE = "https://data.sec.gov/submissions";
const ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data";
const MIN_DELAY_MS = 150;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
});

// The getcurrent "latest filings" atom embeds each filing's summary as
// HTML-ENTITY-ENCODED markup (&lt;b&gt;Filed:&lt;/b&gt; …). Across 100 entries
// that blows fast-xml-parser's default entity-expansion guard (1000). We don't
// need those entities expanded — the summary fields are pulled out by regex —
// so this parser leaves entities untouched (processEntities: false).
const atomParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  processEntities: false,
});

/** Decode the handful of XML entities that can appear in a company name. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

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

/** One filing from the EDGAR "latest filings" (getcurrent) market-wide feed. */
export interface LatestFiling {
  companyName: string;
  cik: string;
  form: string;
  accessionNumber: string;
  filingDate: string;
  /** ET acceptance timestamp string, e.g. "2026-08-13T10:00:14-04:00". */
  acceptanceDateTime: string | null;
  /** 8-K item codes as a comma string, e.g. "2.02,9.01" (empty when none). */
  items: string;
  /** EDGAR filing-index HTML page. */
  indexUrl: string;
}

const CIK_TICKER_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class SecEdgarService {
  private readonly logger = new Logger(SecEdgarService.name);
  private readonly userAgent: string;
  private lastRequestAt = 0;
  private cikTickerCache: { at: number; map: Map<string, string> } | null = null;
  private cikTickerInflight: Promise<Map<string, string>> | null = null;

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

  /**
   * EDGAR quarterly full-index `master.idx` — the pipe-delimited
   * `CIK|Company|Form|Date Filed|Filename` listing of EVERY filing in a quarter.
   * Used by the IPO pipeline to reach S-1/424B registrants that aren't in our
   * traded-ticker universe (so the per-CIK submissions API can't find them).
   * Shares this service's global SEC throttle + User-Agent. Returns null when a
   * quarter's index isn't available (e.g. a not-yet-started quarter) rather than
   * throwing, so a caller spanning two quarters degrades to the one that exists.
   */
  async fetchFullIndexMasterIdx(
    year: number,
    qtr: number,
  ): Promise<string | null> {
    const url = `https://www.sec.gov/Archives/edgar/full-index/${year}/QTR${qtr}/master.idx`;
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < MIN_DELAY_MS) await sleep(MIN_DELAY_MS - elapsed);
    this.lastRequestAt = Date.now();
    const res = await fetch(url, { headers: { "User-Agent": this.userAgent } });
    if (!res.ok) {
      this.logger.warn(`master.idx ${year} QTR${qtr} -> ${res.status}`);
      return null;
    }
    return res.text();
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
    const parsed = xmlParser.parse(xml);
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

  /**
   * CIK → primary ticker map, from SEC's `company_tickers.json` (~10k traded
   * companies). Reference data that changes rarely, so it's lazily fetched once
   * and reused for 24h (in-memory, shared across callers). The getcurrent feed
   * carries CIK but not ticker, so 8-K/filings-wire consumers resolve tickers
   * through this; a filer with no ticker here (untraded shell/SPAC) is dropped.
   */
  async getCikToTicker(): Promise<Map<string, string>> {
    const now = Date.now();
    if (this.cikTickerCache && now - this.cikTickerCache.at < CIK_TICKER_TTL_MS) {
      return this.cikTickerCache.map;
    }
    if (this.cikTickerInflight) return this.cikTickerInflight;

    this.cikTickerInflight = (async () => {
      const data = await this.throttledFetch(
        "https://www.sec.gov/files/company_tickers.json",
      );
      const map = new Map<string, string>();
      for (const entry of Object.values(data) as any[]) {
        // Numeric CIK, no zero-pad (matches the getcurrent feed's CIK). First
        // ticker for a CIK wins (share classes share a CIK).
        const cik = String(entry.cik_str);
        if (!map.has(cik)) map.set(cik, String(entry.ticker).toUpperCase());
      }
      this.cikTickerCache = { at: Date.now(), map };
      return map;
    })().finally(() => (this.cikTickerInflight = null));

    return this.cikTickerInflight;
  }

  /**
   * EDGAR "latest filings" (getcurrent) — the market-wide real-time stream of a
   * given form type across ALL filers, newest first. This is the live analog of
   * crawling every company's submissions: one call yields the most recent N
   * filings market-wide. Shares this service's global SEC throttle + User-Agent.
   */
  async fetchLatestFilings(
    formType: string,
    count = 100,
  ): Promise<LatestFiling[]> {
    const url =
      `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent` +
      `&type=${encodeURIComponent(formType)}&company=&dateb=&owner=include` +
      `&count=${count}&output=atom`;
    const xml = await this.throttledFetchText(url);
    const parsed = atomParser.parse(xml);
    const rawEntries = parsed?.feed?.entry ?? [];
    const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];

    const out: LatestFiling[] = [];
    for (const e of entries) {
      const title = String(e?.title ?? "");
      // "8-K - Company Name (0001668010) (Filer)"
      const m = title.match(/^(\S+)\s*-\s*(.+?)\s*\((\d+)\)/);
      if (!m) continue;
      const form = m[1].trim();
      const companyName = decodeEntities(m[2].trim());
      // The atom zero-pads CIK to 10 digits ("0001668010"); company_tickers.json
      // keys are unpadded ("1668010"). Normalize so cik→ticker lookups hit (and
      // getForm4Transactions re-pads as needed).
      const cik = m[3].replace(/^0+/, "") || m[3];

      // Summary carries Filed date, AccNo and any "Item X.YZ" codes wrapped in
      // entity-encoded (and sometimes raw) HTML tags — strip both forms so the
      // label→value regexes below aren't split by "<b>Filed:</b> DATE" junk.
      const summary = String(e?.summary?.["#text"] ?? e?.summary ?? "")
        .replace(/&lt;[^&]*?&gt;/g, " ")
        .replace(/<[^>]+>/g, " ");
      const filed = summary.match(/Filed:\s*(\d{4}-\d{2}-\d{2})/)?.[1];
      const accFromSummary = summary.match(/AccNo:\s*([\d-]+)/)?.[1];
      const items = [...summary.matchAll(/Item\s+(\d+\.\d+)/g)]
        .map((x) => x[1])
        .join(",");

      const accFromId = String(e?.id ?? "").match(
        /accession-number=([\d-]+)/,
      )?.[1];
      const accessionNumber = accFromSummary ?? accFromId ?? "";

      const href =
        (Array.isArray(e?.link) ? e.link[0]?.["@_href"] : e?.link?.["@_href"]) ??
        "";
      const indexUrl = href.startsWith("http")
        ? href
        : `https://www.sec.gov${href}`;

      const updated = e?.updated ? String(e.updated) : null;

      out.push({
        companyName,
        cik,
        form,
        accessionNumber,
        filingDate: filed ?? (updated ? updated.slice(0, 10) : ""),
        acceptanceDateTime: updated,
        items,
        indexUrl,
      });
    }
    return out;
  }
}
