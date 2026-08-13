import { Injectable, Logger } from "@nestjs/common";
import { FUND_UNIVERSE } from "../common/fund-universe";
import { SecEdgarService } from "../vendors/sec-edgar/sec-edgar.service";

@Injectable()
export class Sec13FJob {
  private readonly logger = new Logger(Sec13FJob.name);

  constructor(private readonly secEdgar: SecEdgarService) {}

  /** Fold a 13F information table into deduped, value-sorted positions. */
  private aggregatePositions(rows: any[]): {
    positions: {
      nameOfIssuer: unknown;
      cusip: string;
      value: number;
      shares: number;
    }[];
    totalValue: number;
  } {
    const byCusip = new Map<
      string,
      { nameOfIssuer: unknown; cusip: string; value: number; shares: number }
    >();
    for (const row of rows) {
      const cusip = row.cusip?.trim();
      if (!cusip) continue;
      const value = Number(row.value) || 0;
      const shares = Number(row.shrsOrPrnAmt?.sshPrnamt) || 0;
      const existing = byCusip.get(cusip);
      if (existing) {
        existing.value += value;
        existing.shares += shares;
      } else {
        byCusip.set(cusip, { nameOfIssuer: row.nameOfIssuer, cusip, value, shares });
      }
    }
    const positions = [...byCusip.values()].sort((a, b) => b.value - a.value);
    const totalValue = positions.reduce((sum, p) => sum + p.value, 0);
    return { positions, totalValue };
  }

  /**
   * Live-direct: the 5-fund 13F summary list (`fund_holdings/{cik}` shape),
   * fetched fresh from SEC-EDGAR per request WITHOUT writing Firestore and
   * WITHOUT the "no new filing" dedupe read. Backs GET /market-data/fund-holdings.
   */
  async fetchLive(): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (const fund of FUND_UNIVERSE) {
      try {
        const { recentFilings } = await this.secEdgar.getSubmissions(fund.cik);
        const latest13F = recentFilings.find((f) => f.form === "13F-HR");
        if (!latest13F) {
          this.logger.warn(
            `No 13F-HR filing found for ${fund.displayName} (CIK ${fund.cik})`,
          );
          continue;
        }
        const rows = (await this.secEdgar.get13FInformationTable(
          fund.cik,
          latest13F.accessionNumber,
        )) as any[];
        const { positions, totalValue } = this.aggregatePositions(rows);
        out.push({
          id: fund.cik,
          fundName: fund.displayName,
          latestFilingDate: latest13F.filingDate,
          latestAccessionNumber: latest13F.accessionNumber,
          totalPositions: positions.length,
          totalValue,
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        this.logger.error(
          `Failed live 13F for ${fund.displayName}: ${(err as Error).message}`,
        );
      }
    }
    return out;
  }

  /**
   * Live-direct: the per-filing positions drill-down (top 25 by value),
   * fetched fresh from SEC-EDGAR WITHOUT reading the Firestore subcollection.
   * Backs GET /market-data/fund-holdings/positions. Returns the same
   * `{id: cusip, cusip, nameOfIssuer, value, shares, pctOfPortfolio}` shape.
   */
  async fetchPositionsLive(
    cik: string,
    accession: string,
  ): Promise<Record<string, unknown>[]> {
    const rows = (await this.secEdgar.get13FInformationTable(
      cik,
      accession,
    )) as any[];
    const { positions, totalValue } = this.aggregatePositions(rows);
    return positions.slice(0, 25).map((p) => ({
      id: p.cusip,
      cusip: p.cusip,
      nameOfIssuer: p.nameOfIssuer,
      value: p.value,
      shares: p.shares,
      pctOfPortfolio:
        totalValue > 0 ? Math.round((p.value / totalValue) * 10000) / 100 : null,
    }));
  }
}
