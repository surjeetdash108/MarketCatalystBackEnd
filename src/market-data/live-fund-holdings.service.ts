import { Injectable } from "@nestjs/common";
import { FUND_UNIVERSE } from "../common/fund-universe";
import { SecEdgarService } from "../vendors/sec-edgar/sec-edgar.service";
import { LiveCoalescer } from "../common/live-coalescer";

/**
 * Live replacement for the `sec-13f` sync job + Firestore cache. Both the 5(+)-
 * fund summary and the per-filing positions drill-down are computed on demand
 * from SEC EDGAR. Aggregation logic (by CUSIP, value-sorted, pct-of-portfolio)
 * preserved from `sync/sec-13f.job.ts`.
 *
 * SEC enforces a global ≥150ms gap between requests, so funds are processed
 * sequentially. 13F data is quarterly, so the coalescer's few-second reuse
 * window comfortably covers a page visit.
 */
interface AggPos {
  nameOfIssuer: string;
  cusip: string;
  value: number;
  shares: number;
}

@Injectable()
export class LiveFundHoldingsService {
  private readonly coalescer = new LiveCoalescer(5_000);

  constructor(private readonly secEdgar: SecEdgarService) {}

  private aggregate(rows: any[]): AggPos[] {
    const byCusip = new Map<string, AggPos>();
    for (const row of rows) {
      const cusip = row.cusip?.trim();
      if (!cusip) continue;
      const value = Number(row.value) || 0;
      const shares = Number(row.shrsOrPrnAmt?.sshPrnamt) || 0;
      const ex = byCusip.get(cusip);
      if (ex) {
        ex.value += value;
        ex.shares += shares;
      } else {
        byCusip.set(cusip, { nameOfIssuer: row.nameOfIssuer, cusip, value, shares });
      }
    }
    return [...byCusip.values()].sort((a, b) => b.value - a.value);
  }

  async getFundHoldings() {
    return this.coalescer.run("fund-holdings", async () => {
      const out: Record<string, unknown>[] = [];
      for (const fund of FUND_UNIVERSE) {
        try {
          const { recentFilings } = await this.secEdgar.getSubmissions(fund.cik);
          const latest = recentFilings.find((f) => f.form === "13F-HR");
          if (!latest) continue;
          const rows = (await this.secEdgar.get13FInformationTable(
            fund.cik,
            latest.accessionNumber,
          )) as any[];
          const positions = this.aggregate(rows);
          out.push({
            id: fund.cik,
            fundName: fund.displayName,
            latestFilingDate: latest.filingDate,
            latestAccessionNumber: latest.accessionNumber,
            totalPositions: positions.length,
            totalValue: positions.reduce((s, p) => s + p.value, 0),
          });
        } catch {
          // Skip a fund whose filing can't be read rather than failing the list.
        }
      }
      return out;
    });
  }

  async getPositions(cik: string, accession: string) {
    return this.coalescer.run(`positions:${cik}:${accession}`, async () => {
      const rows = (await this.secEdgar.get13FInformationTable(cik, accession)) as any[];
      const positions = this.aggregate(rows);
      const totalValue = positions.reduce((s, p) => s + p.value, 0);
      return positions.slice(0, 25).map((p) => ({
        id: p.cusip,
        cusip: p.cusip,
        nameOfIssuer: p.nameOfIssuer,
        value: p.value,
        shares: p.shares,
        pctOfPortfolio:
          totalValue > 0 ? Math.round((p.value / totalValue) * 10000) / 100 : null,
      }));
    });
  }
}
