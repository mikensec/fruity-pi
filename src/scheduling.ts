/** Admission controls for Pi agent *turns*. Pi can make multiple model API
 * requests per turn, so these are guardrails, not exact provider token quotas.
 * Use an LLM gateway for token/RPM enforcement at the request layer.
 */
export interface ProviderLimit {
  maxConcurrent?: number;
  maxStartsPerMinute?: number;
}

export function providerForModel(model?: string): string {
  return model?.split("/")[0]?.trim().toLowerCase() || "unknown";
}

/** null = permitted, Infinity = wait for a running turn to finish. */
export function providerWaitMs(
  limit: ProviderLimit | undefined,
  active: number,
  starts: number[],
  now: number,
  cooldownUntil = 0,
): number | null {
  if (cooldownUntil > now) return cooldownUntil - now;
  if (limit?.maxConcurrent && active >= limit.maxConcurrent) return Infinity;
  if (limit?.maxStartsPerMinute) {
    const recent = starts.filter((t) => t > now - 60_000).sort((a, b) => a - b);
    if (recent.length >= limit.maxStartsPerMinute) {
      return Math.max(1, recent[recent.length - limit.maxStartsPerMinute] + 60_000 - now);
    }
  }
  return null;
}

export function isRateLimitError(message: string): boolean {
  return /\b429\b|rate[ -]?limit|too many requests|throttl/i.test(message);
}

/** A zero or absent limit disables the daily budget gate. */
export function budgetExceeded(spentUsd: number, limitUsd?: number): boolean {
  return !!limitUsd && spentUsd >= limitUsd;
}
