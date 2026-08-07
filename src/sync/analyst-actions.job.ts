import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SyncMetaService } from '../common/sync-meta.service';
import { SyncRegistry } from '../common/sync-registry.service';

const JOB_NAME = 'analyst-actions';

@Injectable()
export class AnalystActionsJob implements OnModuleInit {
  private readonly logger = new Logger(AnalystActionsJob.name);

  constructor(
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['analyst_actions'],
      cronExpression: '0 6 * * *',
      timeZone: 'America/New_York',
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    // Analyst ratings have NO Polygon source — Polygon exposes no analyst /
    // ratings / consensus endpoint on any tier — and the interim ratings source has
    // been removed. No analyst-ratings vendor is wired, so this job is a no-op
    // until one is added. Existing `analyst_actions` docs are left untouched
    // rather than cleared, so the screen keeps showing the last synced consensus.
    this.logger.warn(
      'analyst-actions: no ratings vendor configured (Polygon has no analyst endpoint) — skipping.',
    );
    await this.meta.record(JOB_NAME, { ok: true, count: 0 });
    return { written: 0 };
  }
}
