import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { FirebaseAdminService } from "./firebase-admin.provider";

/**
 * On-demand cache coordination (cron -> request migration).
 *
 * WHY: scheduled jobs used to refresh data whether or not anyone was looking.
 * Now a user request finds out the stored copy is old and refreshes it. Many
 * requests (and several instances) can arrive at the same moment, so something
 * shared must say "somebody is already fetching this" — otherwise every one of
 * them calls FMP / Polygon for the same data.
 *
 * That something is one Firestore doc per cache object: `cache_status/{key}`
 * (e.g. `news:breaking`, `news:ticker:NVDA`).
 *
 * THE RULES (agreed with the lead):
 *   1. Every request serves what is stored. Nobody waits on a provider.
 *   2. Stored copy still inside its TTL (`expiresAt` in the future) -> do nothing.
 *   3. TTL passed -> ONE request wins a transaction that flips the status to
 *      `fetching` BEFORE the provider is called, then starts the refresh WITHOUT
 *      awaiting it and returns straight away. The caller serves the old data.
 *   4. TTL passed and status `fetching` -> serve the old data, do not fetch.
 *   5. `fetching` for longer than `recoveryMs` (15 min) -> presumed lost (the
 *      instance died, the provider hung): the next request starts it again.
 *   6. Refresh ends -> `valid` with a fresh `expiresAt` (fetch time + TTL, or a
 *      fixed time such as next midnight when `expiresAtFor` is given), or `failed`.
 *   7. Only the very first fill ever (nothing stored yet) is awaited, because
 *      there is no old data to serve.
 *
 * STORED STATES are `valid | fetching | failed`. "expired" is not stored: it is
 * simply `valid` with `expiresAt` in the past, so no job is needed to flip it.
 *
 * ADDITION to the lead's rules: after a `failed` refresh the next request waits
 * `failureBackoffMs` (60 s) before retrying. Without it, a provider outage would
 * be hit by a new refresh the moment the previous one failed, for as long as the
 * outage lasted.
 *
 * KNOWN LIMIT: step 3 does not await the refresh. On Cloud Run / App Hosting the
 * CPU is throttled once the response is sent, so with little traffic a refresh
 * can run slowly or stall. The status then stays `fetching` and rule 5 recovers
 * it. `cpuAlwaysAllocated` on the backend would remove the limit (costs more).
 *
 * Times are epoch millis from the instance clock, with ISO mirrors for reading
 * the doc in the console (same convention as job_locks).
 */

const logger = new Logger("CacheStatus");

export const CACHE_STATUS_COLLECTION = "cache_status";
/** A refresh stuck in `fetching` this long is presumed lost and may be restarted. */
export const DEFAULT_RECOVERY_MS = 15 * 60_000;
/** After a failed refresh, how long before the next request may retry. */
export const DEFAULT_FAILURE_BACKOFF_MS = 60_000;

export type CacheState = "valid" | "fetching" | "failed";

export interface CacheStatusDoc {
  /** The cache key, same as the doc id. */
  name: string;
  /** Where the data itself lives (informational), e.g. "news". */
  location: string;
  status: CacheState;
  ttlMs: number;
  /** Stored copy is trusted until this instant. null = never filled. */
  expiresAt: number | null;
  /** When the last SUCCESSFUL refresh started (the data is current as of then). */
  lastFetchedAt: number | null;
  /** Bookmark of how far the last refresh got; the next refresh starts here. */
  watermark: string | null;
  /** When the current refresh was claimed. Only set while `fetching`. */
  fetchingSince: number | null;
  /** Token of the refresh that holds the claim. Only that refresh may finish it. */
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

/** What a refresh is told about the previous successful one. */
export interface RefreshContext {
  previousWatermark: string | null;
  lastFetchedAt: number | null;
}

export interface RefreshResult {
  /** New bookmark to store. Omit to keep the previous one. */
  watermark?: string | null;
}

export interface EnsureOptions {
  /** Cache key, e.g. "news:breaking". Becomes the doc id; must not contain "/". */
  key: string;
  /** Where the data lives (informational). */
  location: string;
  ttlMs: number;
  /**
   * A fixed expiry instead of "fetch time + ttlMs". Given when the successful
   * refresh started, returns when the stored copy expires. Used for daily
   * caches that must expire at the start of the next day whatever time they
   * were fetched (e.g. ticker news: a 17:00 fetch still expires at midnight).
   */
  expiresAtFor?: (fetchedAt: number) => number;
  /** Fetch from the provider and write the data. Must be safe to run twice. */
  refresh: (ctx: RefreshContext) => Promise<RefreshResult | void>;
  recoveryMs?: number;
  failureBackoffMs?: number;
  /**
   * Is there already stored data to serve, even though this key has no status
   * doc yet? True when a cron (or an earlier version of the code) filled it.
   * Then the first refresh runs in the background instead of being awaited, so
   * the first request after deploy is not made to wait. A function is only
   * called when the key has never been filled, so it costs nothing afterwards.
   */
  hasData?: boolean | (() => Promise<boolean>);
  /**
   * Wait for the refresh when this request wins it, instead of running it in the
   * background. For BATCH callers (a scheduled job), whose process can end before
   * a background refresh finishes and which have no user to keep waiting. Other
   * requests still never wait: if someone else is refreshing, this returns at once.
   */
  awaitRefresh?: boolean;
}

/**
 * What `ensureFresh` did. In EVERY case the caller just serves what is stored —
 * the outcome is for logging and tests, not for branching on.
 */
export type EnsureOutcome =
  /** Stored copy is inside its TTL. Nothing done. */
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

/** Stored copy is trusted: status valid and the TTL has not passed. */
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

  /** Instance clock. A method so tests can control it. */
  protected now(): number {
    return Date.now();
  }

  /** Read one status doc (monitoring, or "when was X last refreshed?"). */
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

  /**
   * Make stored copies count as expired because newer data is known to exist.
   * It does not fetch anything itself: the NEXT `ensureFresh` for each returned
   * key refreshes it (a user request does so in the background; a caller that
   * wants it now can call `ensureFresh` with `awaitRefresh`).
   *
   * Used when breaking news names a ticker: if the story is newer than that
   * ticker's last fetch, its detail news is out of date even though its TTL has
   * not run out. Only touches keys that are `valid`, were last fetched before
   * the data, and are not already expired. Keys with no status doc are left
   * alone (nobody has looked at them; their first request fetches anyway).
   * Returns the keys that were expired. Never throws.
   */
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
          // Re-check inside the transaction: a refresh may have just finished.
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

  /**
   * Call on every read of a cache object, BEFORE serving the stored data.
   * Never throws: a problem in this layer must not stop stored data being served.
   */
  async ensureFresh(opts: EnsureOptions): Promise<EnsureOutcome> {
    try {
      const ref = this.firebase.firestore
        .collection(CACHE_STATUS_COLLECTION)
        .doc(opts.key);
      const now = this.now();

      // Cheap pre-check outside a transaction: the common case (valid) costs
      // one read and no write.
      const pre = await ref.get();
      const preDoc = pre.exists ? (pre.data() as CacheStatusDoc) : null;
      if (isCacheFresh(preDoc, now)) {
        return { kind: "fresh" };
      }

      // Only a never-filled key needs to know whether data is already stored.
      let hasData = false;
      if (!preDoc || preDoc.lastFetchedAt == null) {
        hasData =
          typeof opts.hasData === "function"
            ? await opts.hasData().catch(() => false)
            : !!opts.hasData;
      }

      const token = randomUUID();
      const claim = await this.claim(ref, opts, now, token, hasData);

      // `=== false`, not `!claim.won`: the project compiles without strictNullChecks,
      // where truthiness checks do not narrow a discriminated union.
      if (claim.won === false) {
        if (claim.reason === "fresh") return { kind: "fresh" };
        if (claim.reason === "backoff") return { kind: "failed-backoff" };
        return claim.neverFilled
          ? { kind: "first-fill-in-progress" }
          : { kind: "already-fetching" };
      }

      if (claim.neverFilled || opts.awaitRefresh) {
        // Nothing stored (no old data to serve), or a batch caller that asked to
        // wait: run the refresh now and wait for it.
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

      // Old data exists: refresh in the background and let the caller serve it.
      // runRefresh never rejects (it catches everything), so `void` cannot leave
      // an unhandled rejection behind.
      void this.runRefresh(ref, opts, token, now, claim.previous);
      return { kind: "refresh-started" };
    } catch (err) {
      const error = (err as Error).message;
      logger.error(`ensureFresh("${opts.key}") failed: ${error}`);
      return { kind: "unavailable", error };
    }
  }

  /** Atomically decide whether THIS request gets to refresh. */
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
      // "Never filled" = nothing to serve. Data a cron stored earlier counts.
      const neverFilled = (!cur || cur.lastFetchedAt == null) && !hasData;

      // Somebody refreshed between our pre-check and now.
      if (isCacheFresh(cur, now)) {
        return { won: false, reason: "fresh", neverFilled } as const;
      }
      // Somebody is refreshing and has not been at it for too long yet.
      if (
        cur &&
        cur.status === "fetching" &&
        cur.fetchingSince != null &&
        now - cur.fetchingSince < recoveryMs
      ) {
        return { won: false, reason: "fetching", neverFilled } as const;
      }
      // The last refresh failed a moment ago.
      if (
        cur &&
        cur.status === "failed" &&
        cur.lastErrorAt != null &&
        now - cur.lastErrorAt < backoffMs
      ) {
        return { won: false, reason: "backoff", neverFilled } as const;
      }

      // We win. Flip to `fetching` BEFORE any provider is called, keeping what
      // we know about the stored data (expiresAt / lastFetchedAt / watermark).
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

  /** Run the refresh, then record the result. Never rejects. */
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
      // Current as of when we STARTED asking, so anything published while the
      // fetch ran is not skipped by the next watermark.
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

  /**
   * Record the outcome — but only if we still hold the claim. If we were
   * presumed lost and another request took over (rule 5), a late finish from us
   * must not overwrite its state.
   */
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
      // The data is already written; only the status is unrecorded. It stays
      // `fetching` and rule 5 recovers it.
      logger.error(
        `could not record result of "${opts.key}": ${(err as Error).message}`,
      );
    }
  }
}
