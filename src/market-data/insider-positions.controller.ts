import { BadRequestException, Controller, Get, Header, Query } from '@nestjs/common';
import { FUND_UNIVERSE } from '../common/fund-universe';
import { SecEdgarService } from '../vendors/sec-edgar/sec-edgar.service';

const ACCESSION_RE = /^[A-Za-z0-9.\-]{1,32}$/;

interface Position {
  cusip: string;
  nameOfIssuer: string;
  value: number;
  shares: number;
}

function aggregateByCusip(rows: any[]): { positions: Position[]; totalValue: number } {
  const byCusip = new Map<string, Position>();
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
 * GET /market-data/fund-holdings — the 5-fund 13F summary list.
 * GET /market-data/fund-holdings/positions — the per-filing positions
 * drill-down.
 * Both call SEC EDGAR directly on every request (no Firestore cache, no sync
 * job) — mirrors sec-13f.job.ts's fetch + aggregation, minus persistence.
 */
@Controller('market-data')
export class InsiderPositionsController {
  constructor(private readonly secEdgar: SecEdgarService) {}

  @Get('fund-holdings')
  @Header('Cache-Control', 'no-store')
  async fundHoldings() {
    const docs: Record<string, unknown>[] = [];
    for (const fund of FUND_UNIVERSE) {
      try {
        const { recentFilings } = await this.secEdgar.getSubmissions(fund.cik);
        const latest13F = recentFilings.find((f) => f.form === '13F-HR');
        if (!latest13F) continue;
        const rows = (await this.secEdgar.get13FInformationTable(fund.cik, latest13F.accessionNumber)) as any[];
        const { positions, totalValue } = aggregateByCusip(rows);
        docs.push({
          id: fund.cik,
          fundName: fund.displayName,
          latestFilingDate: latest13F.filingDate,
          latestAccessionNumber: latest13F.accessionNumber,
          totalPositions: positions.length,
          totalValue,
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // best-effort per fund, same resilience as the sync job
      }
    }
    return docs;
  }

  @Get('fund-holdings/positions')
  @Header('Cache-Control', 'no-store')
  async positions(@Query('cik') cik: string | undefined, @Query('accession') accession: string | undefined) {
    const knownCik = FUND_UNIVERSE.find((f) => f.cik === (cik ?? '').trim());
    if (!knownCik) {
      throw new BadRequestException(`cik must be one of: ${FUND_UNIVERSE.map((f) => f.cik).join(', ')}`);
    }
    const accessionNumber = (accession ?? '').trim();
    if (!ACCESSION_RE.test(accessionNumber)) {
      throw new BadRequestException('accession is required');
    }

    const rows = (await this.secEdgar.get13FInformationTable(knownCik.cik, accessionNumber)) as any[];
    const { positions, totalValue } = aggregateByCusip(rows);
    return positions.slice(0, 25).map((p) => ({
      id: p.cusip,
      cusip: p.cusip,
      nameOfIssuer: p.nameOfIssuer,
      value: p.value,
      shares: p.shares,
      pctOfPortfolio: totalValue > 0 ? Math.round((p.value / totalValue) * 10000) / 100 : null,
    }));
  }
}
