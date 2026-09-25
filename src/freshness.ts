import type {
  Freshness,
  FreshnessMode,
  FreshnessReport,
  NativeSearchProviderId,
  SearchProviderId,
  SearchSource,
} from "./types.js";
import { detectFreshnessIntent } from "./freshness-intent.js";
import { dedupeSources } from "./utils.js";

type FreshnessProviderId = SearchProviderId | NativeSearchProviderId;
type FreshnessCapability = "native" | "soft" | "unsupported";

export const FRESHNESS_CAPABILITIES: Record<FreshnessProviderId, FreshnessCapability> = {
  tavily: "native",
  searxng: "native",
  anysearch: "soft",
  "deepseek-native": "soft",
};

export interface FreshnessApplication {
  sources: SearchSource[];
  report: FreshnessReport;
}

function intentFields(query: string | undefined): FreshnessReport["intent"] {
  if (query === undefined) return undefined;
  const intent = detectFreshnessIntent(query);
  if (!intent.timeSensitive) return undefined;
  return {
    timeSensitive: true,
    signals: intent.signals,
    recommendedFreshness: intent.recommendedFreshness,
    recommendedMode: "strict",
  };
}

function withIntent(
  report: FreshnessReport,
  query: string | undefined,
): FreshnessReport {
  const intent = intentFields(query);
  return intent === undefined ? report : { ...report, intent };
}

export function freshnessCutoff(
  freshness: Freshness,
  now = new Date(),
): Date | undefined {
  const days: Record<Exclude<Freshness, "any">, number> = {
    day: 1,
    week: 7,
    month: 30,
    year: 365,
  };
  if (freshness === "any") return undefined;
  return new Date(now.getTime() - days[freshness] * 24 * 60 * 60 * 1000);
}

function parseDate(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function mergeDates(sources: SearchSource[]): SearchSource[] {
  const byUrl = new Map<string, SearchSource>();
  for (const source of dedupeSources(sources)) {
    const key = source.url;
    const existing = byUrl.get(key);
    if (existing === undefined) {
      byUrl.set(key, { ...source });
      continue;
    }
    byUrl.set(key, {
      ...existing,
      ...(existing.title === undefined && source.title !== undefined ? { title: source.title } : {}),
      ...(existing.snippet === undefined && source.snippet !== undefined ? { snippet: source.snippet } : {}),
      ...(existing.publishedAt === undefined && source.publishedAt !== undefined
        ? { publishedAt: source.publishedAt }
        : {}),
    });
  }
  return [...byUrl.values()];
}

export function applyFreshnessPolicy(
  provider: FreshnessProviderId,
  sources: SearchSource[],
  freshness: Freshness,
  mode: FreshnessMode = "soft",
  now = new Date(),
  query?: string,
): FreshnessApplication {
  const merged = mergeDates(sources);
  const capability = FRESHNESS_CAPABILITIES[provider];
  const cutoff = freshnessCutoff(freshness, now);
  const cutoffMs = cutoff?.getTime();
  const nowMs = now.getTime();
  const dated = merged.filter((source) => parseDate(source.publishedAt) !== undefined);
  let filtered: SearchSource[];
  let status: FreshnessReport["status"];

  if (freshness === "any") {
    filtered = merged;
    status = "not-requested";
  } else if (mode === "strict") {
    filtered = merged.filter((source) => {
      const timestamp = parseDate(source.publishedAt);
      return timestamp !== undefined
        && timestamp >= (cutoffMs ?? Number.NEGATIVE_INFINITY)
        && timestamp <= nowMs + 5 * 60 * 1000;
    });
    status = filtered.length === merged.length && merged.length > 0
      ? "verified"
      : filtered.length > 0
        ? "estimated"
        : "unmet";
  } else {
    filtered = merged;
    status = dated.length === merged.length && merged.length > 0
      ? capability === "native" ? "verified" : "estimated"
      : dated.length > 0
        ? "estimated"
        : "unknown";
  }

  return {
    sources: filtered,
    report: withIntent(
      {
        requested: freshness,
        mode,
        status,
        ...(cutoff === undefined ? {} : { cutoff: cutoff.toISOString() }),
        filteredCount: merged.length - filtered.length,
        providerCapabilities: { [provider]: capability },
      },
      query,
    ),
  };
}

export function combineFreshnessReports(
  reports: FreshnessReport[],
  requested: Freshness,
  mode: FreshnessMode,
  query?: string,
): FreshnessReport {
  if (reports.length === 0) {
    return withIntent({
      requested,
      mode,
      status: requested === "any" ? "not-requested" : "unknown",
      filteredCount: 0,
      providerCapabilities: {},
    }, query);
  }
  const statuses = reports.map((report) => report.status);
  const status: FreshnessReport["status"] = requested === "any"
    ? "not-requested"
    : statuses.includes("unmet")
      ? "unmet"
      : statuses.includes("unknown")
        ? "unknown"
        : statuses.includes("estimated")
          ? "estimated"
          : "verified";
  const providerCapabilities: FreshnessReport["providerCapabilities"] = {};
  for (const report of reports) Object.assign(providerCapabilities, report.providerCapabilities);
  return withIntent({
    requested,
    mode,
    status,
    ...(reports.find((report) => report.cutoff !== undefined)?.cutoff === undefined
      ? {}
      : { cutoff: reports.find((report) => report.cutoff !== undefined)?.cutoff as string }),
    filteredCount: reports.reduce((sum, report) => sum + report.filteredCount, 0),
    providerCapabilities,
  }, query);
}

export function freshnessWarning(
  report: FreshnessReport,
  providerLabel?: string,
): string | undefined {
  if (report.requested === "any" || report.status === "verified") return undefined;
  const prefix = providerLabel === undefined ? "" : `${providerLabel}: `;
  if (report.status === "unmet") {
    return `${prefix}freshness constraint was not met; filtered ${report.filteredCount} source(s).`;
  }
  return `${prefix}freshness is soft or estimated; ${report.filteredCount} source(s) were filtered or lacked verifiable dates.`;
}
