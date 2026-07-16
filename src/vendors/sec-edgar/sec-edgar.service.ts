import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { XMLParser } from 'fast-xml-parser';
import { fetchJson } from '../../common/http.util';

const SUBMISSIONS_BASE = 'https://data.sec.gov/submissions';
const ARCHIVES_BASE = 'https://www.sec.gov/Archives/edgar/data';
const MIN_DELAY_MS = 150;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SecFiling {
  form: string;
  filingDate: string;
  accessionNumber: string;
  primaryDocument: string;
}

@Injectable()
export class SecEdgarService {
  private readonly logger = new Logger(SecEdgarService.name);
  private readonly userAgent: string;
  private lastRequestAt = 0;

  constructor(private readonly config: ConfigService) {
    this.userAgent = this.config.get(
      'SEC_EDGAR_USER_AGENT',
      'Market Catalyst Backend (unset-contact@example.com)',
    );
  }

  private async throttledFetch(url: string): Promise<any> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < MIN_DELAY_MS) await sleep(MIN_DELAY_MS - elapsed);
    this.lastRequestAt = Date.now();
    return fetchJson(url, { headers: { 'User-Agent': this.userAgent } });
  }

  private async throttledFetchText(url: string): Promise<string> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < MIN_DELAY_MS) await sleep(MIN_DELAY_MS - elapsed);
    this.lastRequestAt = Date.now();
    const res = await fetch(url, { headers: { 'User-Agent': this.userAgent } });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.text();
  }

  private pad10(cik: string): string {
    return cik.replace(/\D/g, '').padStart(10, '0');
  }

  async getSubmissions(cik: string): Promise<{ name: string; recentFilings: SecFiling[] }> {
    const data = await this.throttledFetch(`${SUBMISSIONS_BASE}/CIK${this.pad10(cik)}.json`);
    const r = data.filings.recent;
    const recentFilings = r.form.map((form: string, i: number) => ({
      form,
      filingDate: r.filingDate[i],
      accessionNumber: r.accessionNumber[i],
      primaryDocument: r.primaryDocument[i],
    }));
    return { name: data.name, recentFilings };
  }

  private async getFilingFileNames(cik: string, accessionNumber: string): Promise<string[]> {
    const accNoDash = accessionNumber.replace(/-/g, '');
    const idx = await this.throttledFetch(
      `${ARCHIVES_BASE}/${this.pad10(cik)}/${accNoDash}/index.json`,
    );
    return idx.directory.item.map((i: any) => i.name);
  }

  async get13FInformationTable(cik: string, accessionNumber: string): Promise<unknown[]> {
    const accNoDash = accessionNumber.replace(/-/g, '');
    const files = await this.getFilingFileNames(cik, accessionNumber);
    const infoTableFile = files.find(
      (f) => f.endsWith('.xml') && f !== 'primary_doc.xml' && !f.includes('index'),
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
    const accNoDash = accessionNumber.replace(/-/g, '');
    const files = await this.getFilingFileNames(cik, accessionNumber);
    const form4File = files.find((f) => f.endsWith('.xml') && !f.includes('index'));
    if (!form4File) {
      throw new Error(`No Form 4 XML found in filing ${accessionNumber} for CIK ${cik}`);
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
          doc.reportingOwner?.reportingOwnerRelationship?.isOfficer === 'true' ||
          doc.reportingOwner?.reportingOwnerRelationship?.isOfficer === true,
        officerTitle:
          doc.reportingOwner?.reportingOwnerRelationship?.officerTitle ?? null,
      },
      transactions,
    };
  }
}
