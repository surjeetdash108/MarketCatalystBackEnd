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
 *
 * `isEmpty` is OPT-IN. When omitted (default), behaviour is unchanged: the
 * fallback fires ONLY when the primary THROWS, and any resolved result — even
 * an empty array/null — is returned as success. When a caller provides
 * `isEmpty`, a primary that RESOLVES but is considered empty is treated as a
 * soft failure: the next source is tried, the first non-empty result wins, and
 * if every source is empty (or throws after a resolved-empty) the last empty
 * result is returned rather than an error — so a legitimately-empty upstream
 * (e.g. a stock with no dividends) stays a benign empty result. Only when
 * EVERY source throws (nothing ever resolved) is AllSourcesFailedError raised.
 */
export async function withFallback<A extends NamedSource, T>(
  entity: string,
  logger: Logger,
  primary: A,
  secondary: A | null,
  call: (adapter: A) => Promise<AdapterResult<T>>,
  isEmpty?: (result: AdapterResult<T>) => boolean,
): Promise<AdapterResult<T>> {
  const attempts: SourceAttempt[] = [];
  // Most recent resolved-but-empty result (only set when `isEmpty` is given).
  // Returned in preference to an error so an empty upstream stays benign.
  let lastEmpty: AdapterResult<T> | undefined;

  try {
    const result = await call(primary);
    // No `isEmpty` → original behaviour: any resolved result is success.
    if (!isEmpty || !isEmpty(result)) return result;
    lastEmpty = result;
    logger.warn(
      `${primary.sourceName} ${entity} resolved but returned an empty result` +
        (secondary
          ? ` — trying fallback ${secondary.sourceName}`
          : " — no fallback configured"),
    );
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
    // A resolved-empty primary with no fallback stays a benign empty result;
    // only a thrown primary (no result at all) raises.
    if (lastEmpty !== undefined) return lastEmpty;
    throw new AllSourcesFailedError(entity, attempts);
  }

  try {
    const result = await call(secondary);
    if (isEmpty && isEmpty(result)) {
      // Fallback also empty — remember it; fall through to return an empty
      // result rather than fabricate a FALLBACK_USED "success".
      lastEmpty = result;
    } else {
      const fallbackWarning: AdapterWarning = {
        code: "FALLBACK_USED",
        message:
          `Primary source ${primary.sourceName} ` +
          (attempts.length
            ? `failed (${attempts[0].error})`
            : "returned an empty result") +
          ` — served by fallback ${secondary.sourceName} instead.`,
      };
      return { ...result, warnings: [fallbackWarning, ...result.warnings] };
    }
  } catch (err) {
    attempts.push({
      source: secondary.sourceName,
      error: (err as Error).message,
      retryable: isRetryableVendorError(err),
    });
  }

  // Every source was empty or threw. Prefer returning the last empty result
  // (a real, benign empty) over an error; raise only when nothing ever
  // resolved (all sources threw), preserving the original throw path.
  if (lastEmpty !== undefined) return lastEmpty;
  throw new AllSourcesFailedError(entity, attempts);
}
