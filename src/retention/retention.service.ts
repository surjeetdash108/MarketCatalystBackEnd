import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { RETENTION_RULES, cutoffFor, type RetentionRule } from './retention.config';

/** Firestore caps a batch at 500 writes. */
const DELETE_BATCH_SIZE = 500;

export interface RetentionResult {
  collection: string;
  cutoff: string;
  matched: number;
  deleted: number;
  dryRun: boolean;
}

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly config: ConfigService,
  ) {}

  /**
   * DRY-RUN by default. The first production run therefore only REPORTS what it
   * would delete — nothing is removed until `RETENTION_DRY_RUN=false` is set
   * explicitly, after the logged counts have been reviewed. Deletion is
   * irreversible, so the safe default is to do nothing.
   */
  private get dryRun(): boolean {
    return String(this.config.get('RETENTION_DRY_RUN', 'true')).trim().toLowerCase() !== 'false';
  }

  /** Weekly, Sunday 05:00 ET — after the Sunday ticker-universe run, before Monday. */
  @Cron('0 5 * * 0', { timeZone: 'America/New_York' })
  async scheduled(): Promise<void> {
    const results = await this.runAll();
    const totalMatched = results.reduce((a, r) => a + r.matched, 0);
    const totalDeleted = results.reduce((a, r) => a + r.deleted, 0);
    this.logger.log(
      `retention ${this.dryRun ? '(DRY-RUN)' : ''}: ${totalMatched} eligible, ${totalDeleted} deleted across ${results.length} collection(s)`,
    );
  }

  /** Run every rule. */
  async runAll(): Promise<RetentionResult[]> {
    const now = new Date();
    const out: RetentionResult[] = [];
    for (const rule of RETENTION_RULES) {
      try {
        out.push(await this.runRule(rule, now));
      } catch (err) {
        // One collection failing must not abort the rest.
        this.logger.error(`retention failed for ${rule.collection}: ${err.message}`);
        out.push({ collection: rule.collection, cutoff: '', matched: 0, deleted: 0, dryRun: this.dryRun });
      }
    }
    return out;
  }

  /** Count-only preview for a single collection (never deletes). */
  async previewRule(rule: RetentionRule, now = new Date()): Promise<RetentionResult> {
    const cutoff = cutoffFor(rule, now);
    const agg = await this.firebase.firestore
      .collection(rule.collection)
      .where(rule.dateField, '<', cutoff)
      .count()
      .get();
    return {
      collection: rule.collection,
      cutoff,
      matched: agg.data().count,
      deleted: 0,
      dryRun: true,
    };
  }

  /** Preview every rule without deleting — the "what would happen" report. */
  async previewAll(): Promise<RetentionResult[]> {
    const now = new Date();
    const out: RetentionResult[] = [];
    for (const rule of RETENTION_RULES) {
      try {
        out.push(await this.previewRule(rule, now));
      } catch (err) {
        this.logger.error(`retention preview failed for ${rule.collection}: ${err.message}`);
      }
    }
    return out;
  }

  private async runRule(rule: RetentionRule, now: Date): Promise<RetentionResult> {
    const cutoff = cutoffFor(rule, now);
    const col = this.firebase.firestore.collection(rule.collection);

    // Count first, so dry-run and live report the same "matched" figure.
    const matched = (await col.where(rule.dateField, '<', cutoff).count().get()).data().count;

    if (this.dryRun || matched === 0) {
      return { collection: rule.collection, cutoff, matched, deleted: 0, dryRun: this.dryRun };
    }

    let deleted = 0;
    // Page through in batch-sized chunks. Re-querying each loop (rather than a
    // cursor) is safe because deleted rows drop out of the filter.
    for (;;) {
      const snap = await col
        .where(rule.dateField, '<', cutoff)
        .limit(DELETE_BATCH_SIZE)
        .get();
      if (snap.empty) break;
      const batch = this.firebase.firestore.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      deleted += snap.size;
      if (snap.size < DELETE_BATCH_SIZE) break;
    }

    this.logger.log(`retention: ${rule.collection} pruned ${deleted} row(s) older than ${cutoff}`);
    return { collection: rule.collection, cutoff, matched, deleted, dryRun: false };
  }
}
