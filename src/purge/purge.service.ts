import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import {
  PURGE_TARGETS,
  PURGE_TARGETS_BY_NAME,
  PurgeTarget,
  toBound,
} from './purge.registry';

/** Firestore caps a write batch at 500 operations. */
const DELETE_BATCH_SIZE = 500;

/** A preview token is only good for this long — criteria go stale. */
const TOKEN_TTL_MS = 5 * 60 * 1000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface PurgeCriteria {
  collections: string[];
  from?: string | null;
  to?: string | null;
  /** Also clear the sync watermarks/cursors for the affected jobs. */
  resetSyncState?: boolean;
}

export interface PurgePreviewRow {
  collection: string;
  label: string;
  matched: number;
  dateFiltered: boolean;
  note?: string;
  warning?: string;
}

@Injectable()
export class PurgeService {
  private readonly logger = new Logger(PurgeService.name);

  /**
   * Issued preview tokens. Execute is refused without one, so a purge can never
   * happen unless the exact same criteria were counted first and the operator
   * saw the number. In-memory by design: a process restart invalidates
   * outstanding tokens, which fails closed.
   */
  private readonly tokens = new Map<
    string,
    { fingerprint: string; issuedAt: number; totalMatched: number }
  >();

  constructor(private readonly firebase: FirebaseAdminService) {}

  listTargets() {
    return PURGE_TARGETS.map((t) => ({
      collection: t.collection,
      label: t.label,
      dateField: t.dateField,
      supportsDateRange: t.dateField !== null,
      recursive: t.recursive,
      jobs: t.jobs,
      note: t.note ?? null,
    }));
  }

  /**
   * Criteria are fingerprinted rather than stored verbatim so execute cannot
   * widen the range after a narrow preview — any change produces a different
   * hash and is rejected.
   */
  private fingerprint(c: PurgeCriteria): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          collections: [...c.collections].sort(),
          from: c.from ?? null,
          to: c.to ?? null,
          resetSyncState: !!c.resetSyncState,
        }),
      )
      .digest('hex');
  }

  private validate(c: PurgeCriteria): PurgeTarget[] {
    if (!Array.isArray(c.collections) || c.collections.length === 0) {
      throw new BadRequestException(
        'Select at least one collection. Purge never defaults to "everything".',
      );
    }
    for (const d of [c.from, c.to]) {
      if (d != null && d !== '' && !ISO_DATE.test(d)) {
        throw new BadRequestException(`Date must be YYYY-MM-DD, got "${d}".`);
      }
    }
    if (c.from && c.to && c.from > c.to) {
      throw new BadRequestException(`from (${c.from}) is after to (${c.to}).`);
    }

    const targets: PurgeTarget[] = [];
    for (const name of c.collections) {
      const t = PURGE_TARGETS_BY_NAME.get(name);
      if (!t) {
        // Also the guard that keeps sync_meta/sync_watermarks unpurgeable:
        // they are not in the registry, so they can never resolve here.
        throw new BadRequestException(
          `"${name}" is not a purgeable collection.`,
        );
      }
      if ((c.from || c.to) && t.dateField === null) {
        throw new BadRequestException(
          `"${name}" has no date field — it can only be purged in full, without a date range.`,
        );
      }
      targets.push(t);
    }
    return targets;
  }

  private query(target: PurgeTarget, c: PurgeCriteria) {
    let q: FirebaseFirestore.Query = this.firebase.firestore.collection(
      target.collection,
    );
    if (target.dateField) {
      if (c.from) q = q.where(target.dateField, '>=', c.from);
      if (c.to) q = q.where(target.dateField, '<=', toBound(target, c.to));
    }
    return q;
  }

  async preview(c: PurgeCriteria) {
    const targets = this.validate(c);
    const dateFiltered = !!(c.from || c.to);

    const rows: PurgePreviewRow[] = [];
    for (const t of targets) {
      const snap = await this.query(t, c).count().get();
      const matched = snap.data().count;

      let warning: string | undefined;
      if (dateFiltered && t.dateField) {
        // Documents missing the field are invisible to a range query — Firestore
        // excludes them entirely. Say so, or the count looks like a bug.
        const total = (
          await this.firebase.firestore.collection(t.collection).count().get()
        ).data().count;
        if (total > matched) {
          warning =
            `${total - matched} of ${total} docs will NOT be purged: they fall outside the range ` +
            `or have no "${t.dateField}" field (Firestore range queries skip documents missing the field).`;
        }
      }

      rows.push({
        collection: t.collection,
        label: t.label,
        matched,
        dateFiltered,
        note: t.note,
        warning,
      });
    }

    const totalMatched = rows.reduce((s, r) => s + r.matched, 0);
    const token = randomUUID();
    this.tokens.set(token, {
      fingerprint: this.fingerprint(c),
      issuedAt: Date.now(),
      totalMatched,
    });
    this.sweepTokens();

    return {
      token,
      expiresInMs: TOKEN_TTL_MS,
      totalMatched,
      rows,
      syncStateReset: c.resetSyncState
        ? [...new Set(targets.flatMap((t) => t.jobs))].sort()
        : [],
    };
  }

  private sweepTokens() {
    const now = Date.now();
    for (const [k, v] of this.tokens) {
      if (now - v.issuedAt > TOKEN_TTL_MS) this.tokens.delete(k);
    }
  }

  private consumeToken(token: string | undefined, c: PurgeCriteria): number {
    if (!token) {
      throw new BadRequestException(
        'Missing previewToken. Call POST /purge/preview first — execute is refused until the matching document count has been produced.',
      );
    }
    const entry = this.tokens.get(token);
    if (!entry) {
      throw new BadRequestException(
        'Unknown or already-used previewToken. Preview again.',
      );
    }
    if (Date.now() - entry.issuedAt > TOKEN_TTL_MS) {
      this.tokens.delete(token);
      throw new BadRequestException(
        'previewToken expired (5 min). Preview again.',
      );
    }
    if (entry.fingerprint !== this.fingerprint(c)) {
      throw new BadRequestException(
        'Criteria do not match the ones that were previewed. Preview the exact selection you intend to purge.',
      );
    }
    // Single-use: consumed even on a later failure, so a token can never drive
    // two deletes.
    this.tokens.delete(token);
    return entry.totalMatched;
  }

  /**
   * Deletes in bounded pages. Each pass re-runs the query rather than paging
   * with a cursor, because deleting shifts the result set under a cursor.
   */
  private async deleteQuery(
    target: PurgeTarget,
    c: PurgeCriteria,
  ): Promise<number> {
    const firestore = this.firebase.firestore;
    let deleted = 0;

    for (;;) {
      const snap = await this.query(target, c).limit(DELETE_BATCH_SIZE).get();
      if (snap.empty) break;

      if (target.recursive) {
        // recursiveDelete removes subcollections too; a batch delete would
        // orphan them — still stored, still billed, no longer reachable.
        for (const doc of snap.docs) {
          await firestore.recursiveDelete(doc.ref);
        }
      } else {
        const batch = firestore.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }

      deleted += snap.size;
      if (snap.size < DELETE_BATCH_SIZE) break;
    }
    return deleted;
  }

  /**
   * Clears watermarks and cursor for the jobs that own a purged collection.
   * Without this the next run reads a watermark beyond the purged range,
   * concludes it is already synced, and writes nothing back.
   */
  private async resetSyncState(jobs: string[]): Promise<string[]> {
    const firestore = this.firebase.firestore;
    const cleared: string[] = [];

    for (const job of jobs) {
      const wm = await firestore
        .collection('sync_watermarks')
        .where('jobName', '==', job)
        .get();
      for (const chunk of chunk500(wm.docs)) {
        const batch = firestore.batch();
        chunk.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }

      // Cursor lives on the sync_meta doc. Reset the field only — deleting the
      // doc would destroy the run history and counters the monitor UI reads.
      await firestore
        .collection('sync_meta')
        .doc(job)
        .set({ cursor: 0 }, { merge: true });

      cleared.push(`${job} (${wm.size} watermark(s), cursor→0)`);
    }
    return cleared;
  }

  async execute(c: PurgeCriteria, previewToken?: string) {
    const targets = this.validate(c);
    const previewedTotal = this.consumeToken(previewToken, c);

    const scope = `${c.collections.join(', ')} [${c.from ?? 'beginning'} → ${c.to ?? 'end'}]`;
    this.logger.warn(`PURGE starting: ${scope} (previewed ${previewedTotal} docs)`);

    const results: Array<{ collection: string; deleted: number; error?: string }> = [];
    for (const t of targets) {
      try {
        const deleted = await this.deleteQuery(t, c);
        results.push({ collection: t.collection, deleted });
        this.logger.warn(`PURGE ${t.collection}: deleted ${deleted}`);
      } catch (err) {
        const error = (err as Error).message;
        results.push({ collection: t.collection, deleted: 0, error });
        this.logger.error(`PURGE ${t.collection} FAILED: ${error}`);
      }
    }

    let syncStateCleared: string[] = [];
    if (c.resetSyncState) {
      const jobs = [...new Set(targets.flatMap((t) => t.jobs))].sort();
      syncStateCleared = await this.resetSyncState(jobs);
      this.logger.warn(`PURGE reset sync state: ${syncStateCleared.join('; ')}`);
    }

    const totalDeleted = results.reduce((s, r) => s + r.deleted, 0);
    return {
      ok: results.every((r) => !r.error),
      scope,
      previewedTotal,
      totalDeleted,
      results,
      syncStateCleared,
      completedAt: new Date().toISOString(),
    };
  }
}

function chunk500<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += DELETE_BATCH_SIZE) {
    out.push(arr.slice(i, i + DELETE_BATCH_SIZE));
  }
  return out;
}
