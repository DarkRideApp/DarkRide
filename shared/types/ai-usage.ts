/**
 * Response shape of `GET /v1/ai/usage/report` (not `GET /v1/ai/usage`, which is the older per-conversation
 * token summary). Costs are estimates from a price table; they are `null` when a model
 * has no known price, never zero.
 */

export interface AiUsageTotals {
  /** Agent runs in the window. */
  runs: number;
  /** Runs whose outcome was `error`. */
  failedRuns: number;
  /** Prompt tokens including cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** `cacheReadTokens / inputTokens`, or `null` when there was no input. */
  cacheHitRate: number | null;
  /** Estimated cost in USD, summed over priced requests; `null` when no request had a price. */
  costUsd: number | null;
  /** Runs that had at least one request on a model with no known price (their cost is partial or missing). */
  unpricedRuns: number;
}

export interface AiUsageByPurpose extends AiUsageTotals {
  /** Stable key: `apk-analysis`, `apk-diff`, `chat`, `plugin:<name>`, `service:<name>` or `other`. */
  purpose: string;
  /** Human label for the UI, for example `APK analysis`. */
  label: string;
  /** Median and 90th percentile estimated cost per run, over priced runs only. */
  medianCostUsd: number | null;
  p90CostUsd: number | null;
  medianTurns: number | null;
}

export interface AiUsageDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  purpose: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface AiUsageRun {
  id: number;
  /** ISO 8601. */
  startedAt: string;
  durationMs: number | null;
  purpose: string;
  label: string;
  /** Distinct model ids used by the run's requests, in first-use order. */
  models: string[];
  turns: number | null;
  toolCalls: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  outcome: 'success' | 'error' | 'aborted' | null;
  error: string | null;
  /** Number of requests that were served after one or more models were skipped or failed. */
  fallbackRequests: number;
}

export interface AiUsageResponse {
  /** Window length in days. */
  days: number;
  /** ISO 8601. */
  generatedAt: string;
  totals: AiUsageTotals;
  byPurpose: AiUsageByPurpose[];
  byDay: AiUsageDay[];
  recentRuns: AiUsageRun[];
}
