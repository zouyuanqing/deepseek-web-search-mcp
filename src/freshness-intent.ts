import type { Freshness } from "./types.js";

export interface FreshnessIntent {
  timeSensitive: boolean;
  recommendedMode: "strict";
  recommendedFreshness: Exclude<Freshness, "any">;
  signals: string[];
  reason: string;
}

interface SignalRule {
  id: string;
  pattern: RegExp;
  freshness: Exclude<Freshness, "any">;
  reason: string;
}

const SIGNAL_RULES: readonly SignalRule[] = [
  {
    id: "explicit-latest",
    pattern: /\b(latest|newest|most\s+recent|current|up[- ]to[- ]date)\b|最新|最近|当前|目前/u,
    freshness: "month",
    reason: "the query asks for the latest or current state",
  },
  {
    id: "today",
    pattern: /\b(today|tonight|this\s+(?:week|month|morning))\b|今天|今日|本周|本月/u,
    freshness: "week",
    reason: "the query is anchored to a recent time window",
  },
  {
    id: "release-version",
    pattern: /\b(release[ds]?|changelog|patch\s+notes?|version|v\d+(?:\.\d+)*|pricing|price|model\s+name)\b|版本|发布|更新日志|价格|定价/u,
    freshness: "month",
    reason: "the query targets a versioned or repriced artifact",
  },
  {
    id: "deprecated-changed",
    pattern: /\b(deprecat\w*|end\s+of\s+life|eol|still\s+support\w*|roadmap|schedule[ds]?)\b|停用|下线|维护/u,
    freshness: "month",
    reason: "the answer changes when support or deprecation status changes",
  },
  {
    id: "live-fact",
    pattern: /\b(today'?s?\s+(?:price|weather|score|news)|stock\s+price|exchange\s+rate|weather\s+(?:today|forecast)|live\s+(?:score|result))\b|实时|股价|汇率|天气/u,
    freshness: "day",
    reason: "the underlying fact changes within a day",
  },
];

const DEFAULT_INTENT: FreshnessIntent = {
  timeSensitive: false,
  recommendedMode: "strict",
  recommendedFreshness: "month",
  signals: [],
  reason: "no time-sensitivity signal was detected",
};

export function detectFreshnessIntent(query: string): FreshnessIntent {
  const matched = SIGNAL_RULES.filter((rule) => rule.pattern.test(query));
  if (matched.length === 0) return DEFAULT_INTENT;
  const order: Record<Exclude<Freshness, "any">, number> = { day: 0, week: 1, month: 2, year: 3 };
  const tightest = [...matched].sort(
    (left, right) => order[left.freshness] - order[right.freshness],
  )[0]!;
  return {
    timeSensitive: true,
    recommendedMode: "strict",
    recommendedFreshness: tightest.freshness,
    signals: matched.map((rule) => rule.id),
    reason: tightest.reason,
  };
}

/**
 * Returns an explicit recommendation instead of silently changing behavior.
 * Callers keep their requested mode; the user is told which mode to pass.
 */
export function freshnessIntentWarning(
  query: string,
  requested: Freshness,
  mode: "soft" | "strict" | undefined,
): string | undefined {
  const intent = detectFreshnessIntent(query);
  if (!intent.timeSensitive) return undefined;
  if (mode === "strict" && requested !== "any") return undefined;
  const suggested = requested === "any"
    ? `freshness="${intent.recommendedFreshness}", freshness_mode="strict"`
    : `freshness_mode="strict"`;
  return `This query looks time-sensitive (${intent.reason}; signals: ${intent.signals.join(", ")}). Re-run with ${suggested} so undated or stale sources are dropped instead of only warned about.`;
}
