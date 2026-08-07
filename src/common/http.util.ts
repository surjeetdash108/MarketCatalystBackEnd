export interface FetchJsonOptions extends RequestInit {
  retries?: number;
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      if (SECRET_PARAMS.test(k)) u.searchParams.set(k, 'REDACTED');
    }
    return u.toString();
  } catch {
    // Not a parseable URL — fall back to a regex so a malformed input can never
    // pass a raw key through.
    return url.replace(
      /([?&](?:api_?key|token|access_token|apitoken|key)=)[^&]*/gi,
      '$1REDACTED',
    );
  }
}

export async function fetchJson<T = unknown>(
  url: string,
  opts: FetchJsonOptions = {},
): Promise<T> {
  const { retries = 3, retryDelayMs = 1000, ...init } = opts;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, init);
    if (res.status === 429 && attempt < retries) {
      await sleep(retryDelayMs * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `${init.method ?? 'GET'} ${redactUrl(url)} -> ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    return res.json() as Promise<T>;
  }
  throw new Error(`${redactUrl(url)} exceeded retry budget`);
}
