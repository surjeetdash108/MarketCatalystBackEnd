export interface FetchJsonOptions extends RequestInit {
  retries?: number;
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
        `${init.method ?? 'GET'} ${url} -> ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    return res.json() as Promise<T>;
  }
  throw new Error(`${url} exceeded retry budget`);
}
