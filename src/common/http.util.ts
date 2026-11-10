export interface FetchJsonOptions extends RequestInit {
  retries?: number;
  retryDelayMs?: number;
  /**
   * Per-attempt timeout in ms. A vendor that accepts the connection but never
   * responds would otherwise block a whole job indefinitely (no HTTP status ever
   * arrives, so the 429/`!res.ok` paths never run). Pass 0 to disable. Defaults
   * to DEFAULT_TIMEOUT_MS / the HTTP_FETCH_TIMEOUT_MS env var.
   */
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Default per-request timeout. 15s is comfortably above every vendor's normal
 * response time while still bounding a hung connection. Overridable per call via
 * `timeoutMs`, or globally via the HTTP_FETCH_TIMEOUT_MS env var. Parsed
 * defensively (blank/typo/negative → the 15s default; `0` explicitly disables).
 */
const DEFAULT_TIMEOUT_MS = (() => {
  const raw = String(process.env.HTTP_FETCH_TIMEOUT_MS ?? "").trim();
  const parsed = raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 15_000;
})();

/**
 * Query parameters that carry a credential. Vendors differ: Polygon/Massive use
 * `apiKey`, FRED uses `api_key`.
 */
const SECRET_PARAMS = /^(api_?key|token|access_token|apitoken|key)$/i;

/**
 * Strips credentials out of a URL before it is put in an error message.
 *
 * Every vendor here authenticates via a query string, so an unredacted URL in a
 * thrown Error leaks the key into: the HTTP error body returned to the caller,
 * `sync_meta.lastError` in Firestore (readable by any signed-in user under the
 * deployed security rules), Sentry, and Cloud Run logs. Redacting at the single
 * point where the URL becomes a string is what keeps that from happening.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const [k] of [...u.searchParams]) {
      if (SECRET_PARAMS.test(k)) u.searchParams.set(k, "REDACTED");
    }
    return u.toString();
  } catch {
    // Not a parseable URL — fall back to a regex so a malformed input can never
    // pass a raw key through.
    return url.replace(
      /([?&](?:api_?key|token|access_token|apitoken|key)=)[^&]*/gi,
      "$1REDACTED",
    );
  }
}

export async function fetchJson<T = unknown>(
  url: string,
  opts: FetchJsonOptions = {},
): Promise<T> {
  const {
    retries = 3,
    retryDelayMs = 1000,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal: callerSignal,
    ...init
  } = opts;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Fresh controller per attempt: abort fires either on our timeout or on a
    // caller-supplied signal (chained below so both still work).
    const controller = new AbortController();
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : null;
    const onCallerAbort = () => controller.abort((callerSignal as any)?.reason);
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort((callerSignal as any).reason);
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      // A timeout is treated like a 429: retry within budget, then fail with a
      // message the retry classifier (isRetryableVendorError) recognises as
      // retryable via its `timeout|timed out` branch. A caller-initiated abort
      // or a genuine network error is rethrown unchanged (prior behaviour).
      if (timedOut) {
        if (attempt < retries) {
          await sleep(retryDelayMs * 2 ** attempt);
          continue;
        }
        throw new Error(
          `${init.method ?? "GET"} ${redactUrl(url)} -> timed out after ${timeoutMs}ms`,
        );
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
    }

    if (res.status === 429 && attempt < retries) {
      await sleep(retryDelayMs * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `${init.method ?? "GET"} ${redactUrl(url)} -> ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    return res.json() as Promise<T>;
  }
  throw new Error(`${redactUrl(url)} exceeded retry budget`);
}
