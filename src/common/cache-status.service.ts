import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { FirebaseAdminService } from "./firebase-admin.provider";

const logger = new Logger("CacheStatus");

export const CACHE_STATUS_COLLECTION = "cache_status";
export const DEFAULT_RECOVERY_MS = 15 * 60_000;
export const DEFAULT_FAILURE_BACKOFF_MS = 60_000;

export type CacheState = "valid" | "fetching" | "failed";

export interface CacheStatusDoc {
  name: string;
  location: string;
  status: CacheState;
  ttlMs: number;
  expiresAt: number | null;
  lastFetchedAt: number | null;
  watermark: string | null;
  fetchingSince: number | null;
  fetchOwner: string | null;
  lastError: string | null;
  lastErrorAt: number | null;
  updatedAt: number;
  expiresAtIso: string | null;
  lastFetchedAtIso: string | null;
  fetchingSinceIso: string | null;
  updatedAtIso: string;
}

type CoreFields = Omit<
  CacheStatusDoc,
  "expiresAtIso" | "lastFetchedAtIso" | "fetchingSinceIso" | "updatedAtIso"
>;

const iso = (ms: number | null): string | null =>
  ms == null ? null : new Date(ms).toISOString();

function withMirrors(core: CoreFields): CacheStatusDoc {
  return {
    ...core,
    expiresAtIso: iso(core.expiresAt),
    lastFetchedAtIso: iso(core.lastFetchedAt),
    fetchingSinceIso: iso(core.fetchingSince),
    updatedAtIso: new Date(core.updatedAt).toISOString(),
  };
}

export interface RefreshContext {
  previousWatermark: string | null;
  lastFetchedAt: number | null;
}

export interface RefreshResult {
  watermark?: string | null;
}

export interface EnsureOptions {
  key: string;
  location: string;
  ttlMs: number;
  expiresAtFor?: (fetchedAt: number) => number;
  refresh: (ctx: RefreshContext) => Promise<RefreshResult | void>;
  recoveryMs?: number;
  failureBackoffMs?: number;
  hasData?: boolean | (() => Promise<boolean>);
  awaitRefresh?: boolean;
}

export type EnsureOutcome =
  | { kind: "fresh" }
  /** TTL passed. We claimed the refresh and started it WITHOUT awaiting. */
  | { kind: "refresh-started" }
  /** TTL passed, another request is already refreshing. Nothing done. */
  | { kind: "already-fetching" }
  /** The last refresh failed less than `failureBackoffMs` ago. Nothing done. */
  | { kind: "failed-backoff" }
  /** Nothing stored yet. We claimed it and AWAITED the refresh. */
  | { kind: "first-fill"; ok: boolean; error?: string }
  /** TTL passed and the caller asked to wait (`awaitRefresh`): we ran the refresh. */
  | { kind: "refreshed"; ok: boolean; error?: string }
  /** Nothing stored yet and another request is filling it. Nothing done. */
  | { kind: "first-fill-in-progress" }
  /** Firestore itself failed. Nothing done; the caller serves what it can. */
  | { kind: "unavailable"; error: string };

type ClaimResult =
  | { won: true; neverFilled: boolean; previous: CacheStatusDoc | null }
  | {
      won: false;
      reason: "fresh" | "fetching" | "backoff";
      neverFilled: boolean;
    };

export function isCacheFresh(
  doc: CacheStatusDoc | null | undefined,
  now: number,
): boolean {
  return (
    !!doc &&
    doc.status === "valid" &&
    doc.expiresAt != null &&
    now < doc.expiresAt
  );
}

@Injectable()
export class CacheStatusService {
  constructor(private readonly firebase: FirebaseAdminService) {}

  protected now(): number {
    return Date.now();
  }

  async get(key: string): Promise<CacheStatusDoc | null> {
    try {
      const snap = await this.firebase.firestore
        .collection(CACHE_STATUS_COLLECTION)
        .doc(key)
        .get();
      return snap.exists ? (snap.data() as CacheStatusDoc) : null;
    } catch (err) {
      logger.warn(`get("${key}") failed: ${(err as Error).message}`);
      return null;
    }
  }

  async expireIfOlderThan(
    items: Array<{ key: string; dataNewerThan: number }>,
  ): Promise<string[]> {
    if (!items.length) return [];
    try {
      const fs = this.firebase.firestore;
      const refs = items.map((i) =>
        fs.collection(CACHE_STATUS_COLLECTION).doc(i.key),
      );
      const snaps = await fs.getAll(...refs);
      const now = this.now();
      const due = (cur: CacheStatusDoc | null | undefined, newer: number) =>
        !!cur &&
        cur.status === "valid" &&
        cur.lastFetchedAt != null &&
        cur.lastFetchedAt < newer &&
        cur.expiresAt != null &&
        cur.expiresAt > now;

      const expired: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const first = snaps[i].exists
          ? (snaps[i].data() as CacheStatusDoc)
          : null;
        if (!due(first, items[i].dataNewerThan)) continue;
        const done = await fs.runTransaction(async (tx) => {
          const snap = await tx.get(refs[i]);
          const cur = snap.exists ? (snap.data() as CacheStatusDoc) : null;
          if (!due(cur, items[i].dataNewerThan)) return false;
          tx.set(
            refs[i],
            withMirrors({ ...cur, expiresAt: now, updatedAt: now }),
          );
          return true;
        });
        if (done) expired.push(items[i].key);
      }
      return expired;
    } catch (err) {
      logger.warn(`expireIfOlderThan failed: ${(err as Error).message}`);
      return [];
    }
  }

  async ensureFresh(opts: EnsureOptions): Promise<EnsureOutcome> {
    try {
      const ref = this.firebase.firestore
        .collection(CACHE_STATUS_COLLECTION)
        .doc(opts.key);
      const now = this.now();

      const pre = await ref.get();
      const preDoc = pre.exists ? (pre.data() as CacheStatusDoc) : null;
      if (isCacheFresh(preDoc, now)) {
        return { kind: "fresh" };
      }

      let hasData = false;
      if (!preDoc || preDoc.lastFetchedAt == null) {
        hasData =
          typeof opts.hasData === "function"
            ? await opts.hasData().catch(() => false)
            : !!opts.hasData;
      }

      const token = randomUUID();
      const claim = await this.claim(ref, opts, now, token, hasData);

      if (claim.won === false) {
        if (claim.reason === "fresh") return { kind: "fresh" };
        if (claim.reason === "backoff") return { kind: "failed-backoff" };
        return claim.neverFilled
          ? { kind: "first-fill-in-progress" }
          : { kind: "already-fetching" };
      }

      if (claim.neverFilled || opts.awaitRefresh) {
        const res = await this.runRefresh(
          ref,
          opts,
          token,
          now,
          claim.previous,
        );
        return {
          kind: claim.neverFilled ? "first-fill" : "refreshed",
          ok: res.ok,
          error: res.error,
        };
      }

      void this.runRefresh(ref, opts, token, now, claim.previous);
      return { kind: "refresh-started" };
    } catch (err) {
      const error = (err as Error).message;
      logger.error(`ensureFresh("${opts.key}") failed: ${error}`);
      return { kind: "unavailable", error };
    }
  }

  private async claim(
    ref: FirebaseFirestore.DocumentReference,
    opts: EnsureOptions,
    now: number,
    token: string,
    hasData: boolean,
  ): Promise<ClaimResult> {
    const recoveryMs = opts.recoveryMs ?? DEFAULT_RECOVERY_MS;
    const backoffMs = opts.failureBackoffMs ?? DEFAULT_FAILURE_BACKOFF_MS;

    return this.firebase.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.exists ? (snap.data() as CacheStatusDoc) : null;
      const neverFilled = (!cur || cur.lastFetchedAt == null) && !hasData;

      if (isCacheFresh(cur, now)) {
        return { won: false, reason: "fresh", neverFilled } as const;
      }
      if (
        cur &&
        cur.status === "fetching" &&
        cur.fetchingSince != null &&
        now - cur.fetchingSince < recoveryMs
      ) {
        return { won: false, reason: "fetching", neverFilled } as const;
      }
      if (
        cur &&
        cur.status === "failed" &&
        cur.lastErrorAt != null &&
        now - cur.lastErrorAt < backoffMs
      ) {
        return { won: false, reason: "backoff", neverFilled } as const;
      }

      tx.set(
        ref,
        withMirrors({
          name: opts.key,
          location: opts.location,
          status: "fetching",
          ttlMs: opts.ttlMs,
          expiresAt: cur?.expiresAt ?? null,
          lastFetchedAt: cur?.lastFetchedAt ?? null,
          watermark: cur?.watermark ?? null,
          fetchingSince: now,
          fetchOwner: token,
          lastError: cur?.lastError ?? null,
          lastErrorAt: cur?.lastErrorAt ?? null,
          updatedAt: now,
        }),
      );
      return { won: true, neverFilled, previous: cur } as const;
    });
  }

  private async runRefresh(
    ref: FirebaseFirestore.DocumentReference,
    opts: EnsureOptions,
    token: string,
    claimedAt: number,
    previous: CacheStatusDoc | null,
  ): Promise<{ ok: boolean; error?: string }> {
    let result: RefreshResult | void;
    try {
      result = await opts.refresh({
        previousWatermark: previous?.watermark ?? null,
        lastFetchedAt: previous?.lastFetchedAt ?? null,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn(`refresh of "${opts.key}" failed: ${error}`);
      await this.finish(ref, opts, token, (cur) => ({
        ...cur,
        status: "failed",
        lastError: error.slice(0, 500),
        lastErrorAt: this.now(),
        fetchingSince: null,
        fetchOwner: null,
        updatedAt: this.now(),
      }));
      return { ok: false, error };
    }

    await this.finish(ref, opts, token, (cur) => ({
      ...cur,
      status: "valid",
      lastFetchedAt: claimedAt,
      expiresAt: opts.expiresAtFor
        ? opts.expiresAtFor(claimedAt)
        : claimedAt + opts.ttlMs,
      watermark:
        result && result.watermark !== undefined
          ? result.watermark
          : cur.watermark,
      fetchingSince: null,
      fetchOwner: null,
      lastError: null,
      lastErrorAt: null,
      updatedAt: this.now(),
    }));
    return { ok: true };
  }

  private async finish(
    ref: FirebaseFirestore.DocumentReference,
    opts: EnsureOptions,
    token: string,
    change: (cur: CoreFields) => CoreFields,
  ): Promise<void> {
    try {
      await this.firebase.firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const cur = snap.exists ? (snap.data() as CacheStatusDoc) : null;
        if (!cur || cur.fetchOwner !== token) {
          logger.warn(
            `refresh of "${opts.key}" finished after being superseded; status left as is`,
          );
          return;
        }
        tx.set(ref, withMirrors(change(cur)));
      });
    } catch (err) {
      logger.error(
        `could not record result of "${opts.key}": ${(err as Error).message}`,
      );
    }
  }
}
