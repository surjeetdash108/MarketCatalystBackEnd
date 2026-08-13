import { Controller, Get, Header, Inject } from '@nestjs/common';
import { AllSourcesFailedError } from '../adapters/adapter-error';
import { COMPANY_PROFILE_ADAPTER, type CompanyProfileAdapter } from '../adapters/types';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { activeUniverse } from '../common/ticker-universe';

const CONCURRENCY = 25;

/**
 * GET /market-data/companies — the bulk `companies` collection (per-ticker
 * price/pctChange/marketCap/rvol), shared by Movers (rvol enrichment),
 * Heatmap (tile price/marketCap), Screener and Dashboard. Calls the company
 * profile adapter directly on every request (no Firestore cache, no sync
 * job) — mirrors companies.job.ts's per-ticker fetch, minus persistence.
 *
 * Unlike the job (which paces itself with a 200ms sleep between SEQUENTIAL
 * calls, batching a slice of the universe per cron run), this fetches the
 * FULL active universe every request and fans the per-ticker calls out with
 * a concurrency cap instead of a sleep — sequential would take minutes at
 * today's universe size and only grows from here.
 */
@Controller('market-data')
export class CompaniesController {
  constructor(
    @Inject(COMPANY_PROFILE_ADAPTER) private readonly companyProfile: CompanyProfileAdapter,
    private readonly firebase: FirebaseAdminService,
  ) {}

  @Get('companies')
  @Header('Cache-Control', 'no-store')
  async companies() {
    const universe = await activeUniverse(this.firebase.firestore);
    const docs: Record<string, unknown>[] = [];

    for (let i = 0; i < universe.length; i += CONCURRENCY) {
      const chunk = universe.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (symbol): Promise<Record<string, unknown> | null> => {
          try {
            const result = await this.companyProfile.fetchCompany(symbol);
            if (!result) return null;
            const { data, source, warnings } = result;
            return {
              id: symbol,
              ...data,
              source,
              warnings,
              updatedAt: new Date().toISOString(),
            };
          } catch (err) {
            if (!(err instanceof AllSourcesFailedError)) throw err;
            return null;
          }
        }),
      );
      docs.push(...results.filter((d): d is Record<string, unknown> => d != null));
    }
    return docs;
  }
}
