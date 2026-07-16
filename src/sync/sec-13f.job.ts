import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { FUND_UNIVERSE } from '../common/fund-universe';
import { SyncMetaService } from '../common/sync-meta.service';
import { SecEdgarService } from '../vendors/sec-edgar/sec-edgar.service';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'sec-13f';

@Injectable()
export class Sec13FJob implements OnModuleInit {
  private readonly logger = new Logger(Sec13FJob.name);

  constructor(
    private readonly secEdgar: SecEdgarService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: [
        'fund_holdings',
        'fund_holdings/{cik}/filings',
        'fund_holdings/{cik}/filings/{id}/positions',
      ],
      cronExpression: '0 1 * * *',
      timeZone: 'America/New_York',
    });
  }

  @Cron('0 1 * * *', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    let fundsWritten = 0;
    let positionsWritten = 0;
    for (const fund of FUND_UNIVERSE) {
      try {
        const { recentFilings } = await this.secEdgar.getSubmissions(fund.cik);
        const latest13F = recentFilings.find((f) => f.form === '13F-HR');
        if (!latest13F) {
          this.logger.warn(`No 13F-HR filing found for ${fund.displayName} (CIK ${fund.cik})`);
          continue;
        }
        const fundRef = this.firebase.firestore
          .collection('fund_holdings')
          .doc(fund.cik);
        const existingFund = await fundRef.get();
        if (existingFund.data()?.latestAccessionNumber ===
          latest13F.accessionNumber) {
          this.logger.log(`${fund.displayName}: no new 13F-HR since last sync (${latest13F.accessionNumber}) — skipping`);
          continue;
        }
        const rows = (await this.secEdgar.get13FInformationTable(fund.cik, latest13F.accessionNumber)) as any[];
        const byCusip = new Map();
        for (const row of rows) {
          const cusip = row.cusip?.trim();
          if (!cusip)
            continue;
          const value = Number(row.value) || 0;
          const shares = Number(row.shrsOrPrnAmt?.sshPrnamt) || 0;
          const existing = byCusip.get(cusip);
          if (existing) {
            existing.value += value;
            existing.shares += shares;
          } else {
            byCusip.set(cusip, {
              nameOfIssuer: row.nameOfIssuer,
              cusip,
              value,
              shares,
            });
          }
        }
        const positions = [...byCusip.values()].sort((a, b) => b.value - a.value);
        const totalValue = positions.reduce((sum, p) => sum + p.value, 0);
        await fundRef.set({
          fundName: fund.displayName,
          latestFilingDate: latest13F.filingDate,
          latestAccessionNumber: latest13F.accessionNumber,
          totalPositions: positions.length,
          totalValue,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
        fundsWritten++;
        const filingRef = fundRef
          .collection('filings')
          .doc(latest13F.accessionNumber);
        await filingRef.set({
          filingDate: latest13F.filingDate,
          totalPositions: positions.length,
          totalValue,
        }, { merge: true });
        const batch = this.firebase.firestore.batch();
        const positionsCol = filingRef.collection('positions');
        for (const p of positions.slice(0, 200)) {
          batch.set(positionsCol.doc(p.cusip), {
            cusip: p.cusip,
            nameOfIssuer: p.nameOfIssuer,
            value: p.value,
            shares: p.shares,
            pctOfPortfolio: totalValue > 0
              ? Math.round((p.value / totalValue) * 10000) / 100
              : null,
          }, { merge: true });
        }
        await batch.commit();
        positionsWritten += Math.min(positions.length, 200);
      } catch (err) {
        this.logger.error(`Failed syncing 13F for ${fund.displayName}: ${err.message}\n${err.stack}`);
      }
    }
    await this.meta.record(JOB_NAME, { ok: true, count: fundsWritten });
    return { fundsWritten, positionsWritten };
  }
}
