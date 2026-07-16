export interface SourceAttempt {
  source: string;
  error: string;
  retryable: boolean;
}

export class AllSourcesFailedError extends Error {
  readonly attempts: SourceAttempt[];

  constructor(entity: string, attempts: SourceAttempt[]) {
    super(
      `All sources failed for ${entity}: ` +
        attempts
          .map(
            (a) =>
              `${a.source} (${a.error}${a.retryable ? ', retryable' : ', not retryable'})`,
          )
          .join('; '),
    );
    this.name = 'AllSourcesFailedError';
    this.attempts = attempts;
  }

  get anyRetryable(): boolean {
    return this.attempts.some((a) => a.retryable);
  }
}

export function isRetryableVendorError(err: unknown): boolean {
  const message = (err as any)?.message?.toLowerCase() ?? '';
  if (/\b(429|rate.?limit|too many requests)\b/.test(message)) return true;
  if (/\b(50[0-4]|timeout|timed out|econnreset|network|fetch failed)\b/.test(message))
    return true;
  if (/\b(401|403|404|400|invalid|not.?found|plan restriction|402)\b/.test(message))
    return false;
  return true;
}
