import { Logger } from "@nestjs/common";
import {
  AllSourcesFailedError,
  isRetryableVendorError,
  SourceAttempt,
} from "./adapter-error";
import { AdapterResult, AdapterWarning } from "./types";

interface NamedSource {
  readonly sourceName: string;
}

/**
 * Primary-then-fallback execution, extracted from the Composite*Adapter classes
 * because all of them implement the identical sequence: try primary, record a
 * SourceAttempt on failure, fall back if one is configured, tag the result with
 * FALLBACK_USED, and raise AllSourcesFailedError when nothing succeeds.
 *
 * `call` is passed the adapter rather than being bound to a method name, so one
 * helper serves interfaces with different method signatures.
 */
export async function withFallback<A extends NamedSource, T>(
  entity: string,
  logger: Logger,
  primary: A,
  secondary: A | null,
  call: (adapter: A) => Promise<AdapterResult<T>>,
): Promise<AdapterResult<T>> {
  const attempts: SourceAttempt[] = [];

  try {
    return await call(primary);
  } catch (err) {
    const message = (err as Error).message;
    const retryable = isRetryableVendorError(err);
    attempts.push({ source: primary.sourceName, error: message, retryable });
    logger.warn(
      `${primary.sourceName} ${entity} fetch failed (${retryable ? "retryable" : "not retryable"}): ${message}` +
        (secondary
          ? ` — falling back to ${secondary.sourceName}`
          : " — no fallback configured"),
    );
  }

  if (!secondary) {
    throw new AllSourcesFailedError(entity, attempts);
  }

  try {
    const result = await call(secondary);
    const fallbackWarning: AdapterWarning = {
      code: "FALLBACK_USED",
      message: `Primary source ${primary.sourceName} failed (${attempts[0].error}) — served by fallback ${secondary.sourceName} instead.`,
    };
    return { ...result, warnings: [fallbackWarning, ...result.warnings] };
  } catch (err) {
    attempts.push({
      source: secondary.sourceName,
      error: (err as Error).message,
      retryable: isRetryableVendorError(err),
    });
    throw new AllSourcesFailedError(entity, attempts);
  }
}
