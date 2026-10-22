import { type Observable, takeUntil, timer } from "rxjs";

/**
 * Longest a single SSE response stays open before the server ends it.
 *
 * Each open stream holds one of the live service's concurrency slots. Left to
 * the 1-hour Cloud Run request timeout, streams the browser could no longer
 * use (closed tabs, a proxy that buffers instead of streaming) held their slot
 * for the full hour; on 22 Oct 2026 ~1,000 of them filled every slot and
 * Cloud Run answered all other requests with 429 "Rate exceeded". The browser's
 * EventSource reconnects on its own a few seconds after the server ends the
 * response, so a live page keeps streaming while an abandoned one lets go.
 */
export const SSE_MAX_LIFETIME_MS =
  Number(process.env.SSE_MAX_LIFETIME_MS) > 0
    ? Number(process.env.SSE_MAX_LIFETIME_MS)
    : 5 * 60_000;

/** Ends an SSE stream after SSE_MAX_LIFETIME_MS (its teardown still runs). */
export function capStreamLifetime<T>(stream$: Observable<T>): Observable<T> {
  return stream$.pipe(takeUntil(timer(SSE_MAX_LIFETIME_MS)));
}
