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
/**
 * Filing HTML made safe to render.
 *
 * The document is displayed inside a sandboxed iframe with scripting disabled,
 * which is what actually contains it — this is the second layer, so a change to
 * how the page embeds it cannot silently turn a filing into an injection
 * vector. Active content is removed outright; the typography, tables and inline
 * styles that make a prospectus readable are left exactly as filed.
 *
 * Relative asset paths are rewritten to absolute EDGAR URLs, otherwise every
 * chart and signature image in the filing resolves against our own origin and
 * 404s.
 */
function sanitizeFilingHtml(html: string, baseUrl: string): string {
  const cleaned = html
    // Active content: scripts, embedded plugins, nested frames, and forms that
    // could post a reader's input somewhere.
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<(object|embed|applet)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(form|input|button|textarea|select)\b[^>]*>/gi, "")
    // <base> would re-point every relative URL after we have rewritten them.
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, "")
    // Inline event handlers, quoted or bare.
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "");

  // Resolve relative src/href against the filing's own directory on EDGAR.
  return cleaned.replace(
    /\s(src|href)\s*=\s*"(?!https?:|data:|#|mailto:)([^"]*)"/gi,
    (_m, attr: string, url: string) => {
      try {
        return ` ${attr}="${new URL(url, baseUrl).href}"`;
      } catch {
        return ` ${attr}="${url}"`;
      }
    },
  );
}

/** One filing rendered as a page in the app rather than as EDGAR's raw text. */
export interface FilingDocument {
  cik: string;
  accessionNumber: string;
  companyName: string | null;
  form: string | null;
  filingDate: string | null;
  /** File name of the document rendered, e.g. "ecominas_s1a.htm". */
  primaryDocument: string | null;
  html: string;
  /** True when the document exceeded the size cap and was cut short. */
  truncated: boolean;
  /** EDGAR's own filing-index page, for the "view original" link. */
  edgarUrl: string;
}

/**
 * Cap on a single filing document. An S-1 with exhibits runs to megabytes, and
 * the whole thing has to cross the wire and parse in the reader's browser.
 */
const MAX_FILING_BYTES = 5_000_000;

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

/**
 * One reporting person on a Schedule 13D/13G cover page.
 *
 * 13D/G are the >5% BENEFICIAL-OWNERSHIP schedules. Unlike 13F — which is filed
 * by the holder and keyed on CUSIP, so it cannot be looked up by ticker — these
 * are indexed by EDGAR under the SUBJECT issuer, which makes them the one
 * ownership dataset SEC publishes per-company.
 */
export interface Schedule13Holder {
  /** Reporting person, i.e. the institution holding the stake. */
  filerName: string;
  /** "SCHEDULE 13G", "SCHEDULE 13G/A", "SCHEDULE 13D", "SCHEDULE 13D/A". */
  form: string;
  filingDate: string;
  /** Date of the event that required the filing, when the cover page gives one. */
  eventDate: string | null;
  accessionNumber: string;
  /** Aggregate amount beneficially owned. */
  shares: number | null;
  percentOfClass: number | null;
  soleVoting: number | null;
  sharedVoting: number | null;
  soleDispositive: number | null;
  sharedDispositive: number | null;
  /** SEC person-type code — IA (investment adviser), BK (bank), CO, IN, … */
  personType: string | null;
  filingUrl: string;
}

/** A 13D/G filing EDGAR lists for the issuer that we could not parse. */
export interface Schedule13LegacyFiling {
  form: string;
  filingDate: string;
  accessionNumber: string;
  url: string;
}

export interface Schedule13Ownership {
  /** CUSIP as stated on the cover pages — the key 13F positions are filed under. */
  cusip: string | null;
  /** e.g. "Common Stock", "Class A Ordinary Shares". */
  securitiesClass: string | null;
  /** Newest filing per reporting person, largest stake first. */
  holders: Schedule13Holder[];
  /** Pre-2025 filings (HTML/TXT cover pages, no structured XML to read). */
  legacyFilings: Schedule13LegacyFiling[];
  /** How many 13D/G filings EDGAR lists for this issuer in the recent window. */
  totalFilings: number;
}

/** SEC filing numbers arrive as strings, sometimes "1099168953.00" or with
 *  commas. Returns null rather than NaN/0 so "not disclosed" stays distinct
 *  from a real zero (an exited holder legitimately reports 0). */
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** CIKs appear zero-padded in some documents and bare in others. */
function sameCik(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");
  const na = norm(a);
  return na !== "" && na === norm(b);
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
  /**
   * Ticker -> CIK from SEC's own company_tickers.json, or null if SEC does not
   * list the symbol (foreign issuers without a US registration, ETFs, etc.).
   */
  async getCikByTicker(ticker: string): Promise<string | null> {
    try {
      return (await this.getTickerCikMap()).get(ticker.toUpperCase()) ?? null;
    } catch (err) {
      this.logger.warn(
        `getCikByTicker(${ticker}) failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

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

  /**
   * Current >5% beneficial owners of an issuer, from its Schedule 13D/13G
   * filings on EDGAR.
   *
   * Since the SEC's 2024 structured-data rule these schedules carry a
   * `primary_doc.xml` cover page with the reporting person, the aggregate
   * amount owned, the percent of class and the voting/dispositive split — so
   * the numbers below are read from the filing itself, not inferred.
   *
   * Two things this has to get right:
   *
   *  1. EDGAR lists a 13D/G under BOTH the subject issuer and the filer. A
   *     company that itself takes a >5% stake in another (NVIDIA in Nebius,
   *     Gold Fields in Galiano) therefore has that filing in its own
   *     submissions feed. Every parsed document is checked against the
   *     requested CIK and dropped unless this issuer is the SUBJECT.
   *  2. A 13G/A supersedes the filer's earlier schedule, so only the newest
   *     filing per reporting person is kept — otherwise one institution shows
   *     up several times with stale, contradictory stakes.
   *
   * Filings older than the structured-XML mandate have HTML/TXT cover pages
   * with no machine-readable numbers; they are returned separately as
   * `legacyFilings` (form, date, link) rather than guessed at.
   */
  async getSchedule13Ownership(
    cik: string,
    maxFilings = 24,
  ): Promise<Schedule13Ownership> {
    const { recentFilings } = await this.getSubmissions(cik);
    // Both spellings occur: EDGAR labelled these "SC 13G" before the structured
    // form types ("SCHEDULE 13G") were introduced.
    const filings = recentFilings.filter((f) =>
      /^(SCHEDULE 13|SC 13)[DG]/i.test(f.form),
    );

    const structured: SecFiling[] = [];
    const legacyFilings: Schedule13LegacyFiling[] = [];
    for (const f of filings) {
      if (/primary_doc\.xml$/i.test(f.primaryDocument ?? "")) structured.push(f);
      else
        legacyFilings.push({
          form: f.form,
          filingDate: f.filingDate,
          accessionNumber: f.accessionNumber,
          url: this.filingIndexUrl(cik, f.accessionNumber),
        });
    }

    let cusip: string | null = null;
    let securitiesClass: string | null = null;
    // Newest filing wins per reporting person; `structured` is newest-first
    // because EDGAR's submissions feed is.
    const byPerson = new Map<string, Schedule13Holder>();

    for (const f of structured.slice(0, maxFilings)) {
      let parsed: Record<string, any>;
      try {
        const accNoDash = f.accessionNumber.replace(/-/g, "");
        const xml = await this.throttledFetchText(
          `${ARCHIVES_BASE}/${this.pad10(cik)}/${accNoDash}/primary_doc.xml`,
        );
        parsed = xmlParserNS.parse(xml)?.edgarSubmission ?? {};
      } catch (err) {
        // One unreachable cover page must not lose the other filings.
        this.logger.warn(
          `13D/G ${f.accessionNumber} for CIK ${cik} unreadable: ${(err as Error).message}`,
        );
        continue;
      }

      const header = parsed.formData?.coverPageHeader ?? {};
      const issuer = header.issuerInfo ?? {};
      // 13G spells it issuerCik, 13D issuerCIK.
      const issuerCik = issuer.issuerCik ?? issuer.issuerCIK;
      // The subject-vs-filer check described above. A document with no issuer
      // CIK at all is dropped rather than assumed to be about this issuer.
      if (!sameCik(issuerCik, cik)) continue;

      // Three spellings across the schema versions in circulation: the current
      // 13G (X02) wraps it as issuerCusips.issuerCusipNumber, the earlier 13G
      // (X01) writes a bare issuerCusip, and 13D writes issuerCUSIP. A filing
      // with several classes carries an array — the first is the one the
      // cover page's percent-of-class refers to.
      const rawCusip =
        issuer.issuerCusips?.issuerCusipNumber ??
        issuer.issuerCusip ??
        issuer.issuerCUSIP ??
        null;
      cusip ??= Array.isArray(rawCusip)
        ? (rawCusip[0] == null ? null : String(rawCusip[0]))
        : rawCusip == null
          ? null
          : String(rawCusip);
      securitiesClass ??= header.securitiesClassTitle ?? null;
      const eventDate =
        header.eventDateRequiresFilingThisStatement ??
        header.dateOfEvent ??
        null;

      // 13G puts the reporting persons in coverPageHeaderReportingPersonDetails
      // with `classPercent`; 13D uses reportingPersons.reportingPersonInfo with
      // `percentOfClass` and flattened power fields.
      const g = parsed.formData?.coverPageHeaderReportingPersonDetails;
      const d = parsed.formData?.reportingPersons?.reportingPersonInfo;
      const rows: any[] = [
        ...(g == null ? [] : Array.isArray(g) ? g : [g]),
        ...(d == null ? [] : Array.isArray(d) ? d : [d]),
      ];

      for (const r of rows) {
        const filerName = String(r?.reportingPersonName ?? "").trim();
        if (!filerName) continue;
        const key = filerName.toUpperCase();
        if (byPerson.has(key)) continue; // an earlier (newer) filing already won
        const powers = r.reportingPersonBeneficiallyOwnedNumberOfShares ?? r;
        byPerson.set(key, {
          filerName,
          form: f.form,
          filingDate: f.filingDate,
          eventDate: eventDate == null ? null : String(eventDate),
          accessionNumber: f.accessionNumber,
          shares: num(
            r.reportingPersonBeneficiallyOwnedAggregateNumberOfShares ??
              r.aggregateAmountOwned,
          ),
          percentOfClass: num(r.classPercent ?? r.percentOfClass),
          soleVoting: num(powers.soleVotingPower),
          sharedVoting: num(powers.sharedVotingPower),
          soleDispositive: num(powers.soleDispositivePower),
          sharedDispositive: num(powers.sharedDispositivePower),
          personType: r.typeOfReportingPerson
            ? String(r.typeOfReportingPerson)
            : null,
          filingUrl: this.filingIndexUrl(cik, f.accessionNumber),
        });
      }
    }

    const holders = [...byPerson.values()].sort(
      (a, b) => (b.percentOfClass ?? -1) - (a.percentOfClass ?? -1),
    );
    return {
      cusip,
      securitiesClass,
      holders,
      legacyFilings,
      totalFilings: filings.length,
    };
  }

  /**
   * The readable document from a filing, ready to render in the app.
   *
   * EDGAR's full-index gives only `edgar/data/{cik}/{accession}.txt` — the
   * COMPLETE SUBMISSION file, every document in the filing concatenated as raw
   * SGML. That is what a browser shows as a wall of plain text, and it is not
   * something a reader can use. The actual filing is one HTML document inside
   * that submission, and this resolves and returns it.
   *
   * The document name comes from the issuer's submissions feed, which states
   * the primary document per accession. For a filing older than that feed's
   * recent window there is no such record, so the directory listing is used and
   * the largest HTML file that is not the index is taken — in a filing the
   * prospectus is reliably the biggest document, exhibits are smaller.
   */
  async getFilingDocument(
    cik: string,
    accessionNumber: string,
  ): Promise<FilingDocument | null> {
    const bare = cik.replace(/\D/g, "");
    const accNoDash = accessionNumber.replace(/-/g, "");
    const dirUrl = `${ARCHIVES_BASE}/${bare}/${accNoDash}`;

    let companyName: string | null = null;
    let form: string | null = null;
    let filingDate: string | null = null;
    let docName: string | null = null;

    try {
      const subs = await this.getSubmissions(cik);
      companyName = subs.name ?? null;
      const match = subs.recentFilings.find(
        (f) => f.accessionNumber === accessionNumber,
      );
      if (match) {
        form = match.form;
        filingDate = match.filingDate;
        docName = match.primaryDocument || null;
      }
    } catch (err) {
      // The submissions feed is a convenience here, not the source of the
      // document — fall through to the directory listing.
      this.logger.warn(
        `submissions lookup for ${accessionNumber} failed: ${(err as Error).message}`,
      );
    }

    if (!docName) {
      let files: Array<{ name: string; size: number }>;
      try {
        const idx = await this.throttledFetch(`${dirUrl}/index.json`);
        files = (idx?.directory?.item ?? []).map((i: any) => ({
          name: String(i.name),
          size: Number(i.size) || 0,
        }));
      } catch {
        return null;
      }
      const candidates = files
        .filter(
          (f) =>
            /\.html?$/i.test(f.name) &&
            !/index/i.test(f.name) &&
            !/^R\d+\.htm/i.test(f.name), // XBRL viewer fragments
        )
        .sort((a, b) => b.size - a.size);
      docName = candidates[0]?.name ?? null;
    }
    if (!docName) return null;

    let html: string;
    try {
      html = await this.throttledFetchText(`${dirUrl}/${docName}`);
    } catch (err) {
      this.logger.warn(
        `filing document ${docName} (${accessionNumber}) unreachable: ${(err as Error).message}`,
      );
      return null;
    }

    const truncated = html.length > MAX_FILING_BYTES;
    if (truncated) html = html.slice(0, MAX_FILING_BYTES);

    return {
      cik: bare,
      accessionNumber,
      companyName,
      form,
      filingDate,
      primaryDocument: docName,
      html: sanitizeFilingHtml(html, `${dirUrl}/`),
      truncated,
      edgarUrl: this.filingIndexUrl(cik, accessionNumber),
    };
  }

  /** Human-facing EDGAR page for a filing — what the drawer links out to. */
  private filingIndexUrl(cik: string, accessionNumber: string): string {
    return `${ARCHIVES_BASE}/${this.pad10(cik)}/${accessionNumber.replace(/-/g, "")}/${accessionNumber}-index.htm`;
  }
}
