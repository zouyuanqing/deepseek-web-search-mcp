import type {
  FastCleaningMode,
  Freshness,
  NativeSearchProviderId,
  ResolvedScope,
  SearchProviderId,
  SearchSource,
} from "./types.js";
import { authorityScore, hasOfficialIntent } from "./ranking.js";
import { domainKey as registrableDomainKey, isLowAuthorityHost } from "./hosts.js";
import { canonicalizeUrl, dedupeSources } from "./utils.js";

export type QualityProviderId = SearchProviderId | NativeSearchProviderId;

export interface ReplayProviderRun {
  provider: QualityProviderId;
  status: "ok" | "empty" | "error";
  elapsedMs: number;
  sources: SearchSource[];
  errorCode?: string;
  errorMessage?: string;
}

export interface ReplayRerankRun {
  status: "ok" | "error";
  model: string;
  elapsedMs: number;
  sources: SearchSource[];
  errorCode?: string;
  errorMessage?: string;
}

export interface ReplayCase {
  id: string;
  query: string;
  scope: ResolvedScope;
  freshness: Freshness;
  providers: ReplayProviderRun[];
  rerank?: ReplayRerankRun;
  labels?: Record<string, 0 | 1 | 2 | 3>;
}

export interface ProviderSourceList {
  provider: QualityProviderId;
  sources: SearchSource[];
  weight?: number;
}

export interface ProviderAwareOptions {
  k?: number;
  rerankWeight?: number;
}

export interface ProviderAwareRankedSource extends SearchSource {
  providerRanks: Record<string, number>;
  providerContributions: Record<string, number>;
  providerCoverage: number;
  fusionScore: number;
  rerankRank?: number;
  rerankContribution: number;
}

export interface FastCleaningOptions {
  mode: FastCleaningMode;
  maxResults: number;
  domainCap: number;
}

export interface FastCleaningResult {
  sources: SearchSource[];
  shadowSources: SearchSource[];
  applied: boolean;
  candidateCount: number;
  selectedCount: number;
  providerCoverage: number;
}

function hostKey(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return url.toLowerCase();
  }
}

function normalizedText(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function tokenSet(value: string | undefined): Set<string> {
  return new Set(normalizedText(value).split(" ").filter(Boolean));
}

function overlapRatio(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size < 3 || right.size < 3) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

function residualTokens(
  title: string | undefined,
  queryTokens: ReadonlySet<string>,
): Set<string> {
  const residual = tokenSet(title);
  for (const token of queryTokens) residual.delete(token);
  return residual;
}

/**
 * Two titles that merely echo the same query are not the same article. Only
 * the tokens that distinguish the title from the query are compared, so
 * "q source repository" and "q native research" stay separate while two real
 * copies of one syndicated page still collapse.
 */
export function nearDuplicate(
  left: SearchSource,
  right: SearchSource,
  query: string,
): boolean {
  const queryTokens = tokenSet(query);
  const leftResidual = residualTokens(left.title, queryTokens);
  const rightResidual = residualTokens(right.title, queryTokens);
  if (overlapRatio(leftResidual, rightResidual) >= 0.8) return true;
  // Titles with no distinguishing residual cannot be compared by title at all.
  if (leftResidual.size >= 2 && rightResidual.size >= 2) return false;
  if (overlapRatio(tokenSet(left.title), tokenSet(right.title)) >= 0.9) return true;
  const leftSnippet = normalizedText(left.snippet);
  const rightSnippet = normalizedText(right.snippet);
  return leftSnippet.length > 80
    && leftSnippet === rightSnippet;
}

function fastSourceScore(query: string, source: SearchSource, index: number): number {
  const authority = authorityScore(query, source);
  const lowAuthority = isLowAuthorityHost(source.url);
  const authorityBoost = hasOfficialIntent(query) ? 0.4 : 0.08;
  // The reciprocal-rank term spans 0.2..1.0, so a bounded additive penalty can
  // never displace a rank-1 low-authority hit (measured: reddit at rank 1 scored
  // 0.88 vs 0.78 for a rank-2 official page). The demotion is therefore
  // multiplicative: an explicit aggregator/content-farm signal must be able to
  // outrank a better raw position. Unknown domains are untouched.
  const lowAuthorityFactor = lowAuthority ? 0.35 : 1;
  return (1 / (index + 1) + authority * authorityBoost) * lowAuthorityFactor;
}

export function cleanFastSources(
  query: string,
  sources: SearchSource[],
  options: FastCleaningOptions,
): FastCleaningResult {
  const unique = dedupeSources(sources);
  if (options.mode === "off") {
    return {
      sources: unique,
      shadowSources: unique,
      applied: false,
      candidateCount: unique.length,
      selectedCount: Math.min(unique.length, options.maxResults),
      providerCoverage: new Set(unique.map((source) => source.provider)).size,
    };
  }

  const ranked = unique
    .map((source, index) => ({ source, index, score: fastSourceScore(query, source, index) }))
    .sort((left, right) =>
      right.score - left.score
      || left.index - right.index
      || left.source.url.localeCompare(right.source.url));

  const selected: SearchSource[] = [];
  const selectedDomains = new Map<string, number>();
  const representedProviders = new Set<string>();
  const remaining = [...ranked];
  while (selected.length < options.maxResults && remaining.length > 0) {
    const missingProviderBonus = (item: typeof remaining[number]): number =>
      representedProviders.has(item.source.provider) ? 0 : 0.04;
    remaining.sort((left, right) =>
      (right.score + missingProviderBonus(right)) - (left.score + missingProviderBonus(left))
      || left.index - right.index
      || left.source.url.localeCompare(right.source.url));
    const next = remaining.shift();
    if (next === undefined) break;
    const domain = registrableDomainKey(next.source.url);
    if ((selectedDomains.get(domain) ?? 0) >= options.domainCap) continue;
    if (selected.some((source) => nearDuplicate(source, next.source, query))) continue;
    selected.push(next.source);
    selectedDomains.set(domain, (selectedDomains.get(domain) ?? 0) + 1);
    representedProviders.add(next.source.provider);
  }

  const providerCoverage = new Set(selected.map((source) => source.provider)).size;
  return {
    sources: options.mode === "on" ? selected : unique,
    shadowSources: selected,
    applied: options.mode === "on",
    candidateCount: unique.length,
    selectedCount: selected.length,
    providerCoverage,
  };
}

interface CandidateAccumulator {
  source: SearchSource;
  providerRanks: Map<QualityProviderId, number>;
  providerContributions: Map<QualityProviderId, number>;
  rerankRank?: number;
  rerankContribution: number;
}

function keyFor(source: SearchSource): string | null {
  return canonicalizeUrl(source.url);
}

function mergeSource(target: SearchSource, incoming: SearchSource): SearchSource {
  return {
    ...target,
    ...(target.title === undefined && incoming.title !== undefined ? { title: incoming.title } : {}),
    ...(target.snippet === undefined && incoming.snippet !== undefined ? { snippet: incoming.snippet } : {}),
    ...(target.publishedAt === undefined && incoming.publishedAt !== undefined
      ? { publishedAt: incoming.publishedAt }
      : {}),
    ...(target.score === undefined && incoming.score !== undefined ? { score: incoming.score } : {}),
  };
}

function rankContribution(rank: number, k: number, weight: number): number {
  return weight / (k + rank);
}

export function providerAwareRrf(
  providerLists: ProviderSourceList[],
  rerankSources: SearchSource[] = [],
  options: ProviderAwareOptions = {},
): ProviderAwareRankedSource[] {
  const k = options.k ?? 60;
  const rerankWeight = options.rerankWeight ?? 0.5;
  const candidates = new Map<string, CandidateAccumulator>();

  for (const list of providerLists) {
    const weight = list.weight ?? 1;
    list.sources.forEach((source, index) => {
      const key = keyFor(source);
      if (key === null) return;
      const existing = candidates.get(key);
      if (existing === undefined) {
        candidates.set(key, {
          source: { ...source, url: key },
          providerRanks: new Map([[list.provider, index + 1]]),
          providerContributions: new Map([
            [list.provider, rankContribution(index + 1, k, weight)],
          ]),
          rerankContribution: 0,
        });
        return;
      }
      existing.source = mergeSource(existing.source, source);
      if (!existing.providerRanks.has(list.provider)) {
        existing.providerRanks.set(list.provider, index + 1);
        existing.providerContributions.set(
          list.provider,
          rankContribution(index + 1, k, weight),
        );
      }
    });
  }

  rerankSources.forEach((source, index) => {
    const key = keyFor(source);
    if (key === null) return;
    const candidate = candidates.get(key);
    if (candidate === undefined) return;
    candidate.rerankRank = index + 1;
    candidate.rerankContribution = rankContribution(index + 1, k, rerankWeight);
  });

  const ranked = [...candidates.values()].map((candidate): ProviderAwareRankedSource => {
    const providerContributions = Object.fromEntries(candidate.providerContributions);
    const providerScore = [...candidate.providerContributions.values()]
      .reduce((sum, value) => sum + value, 0);
    return {
      ...candidate.source,
      ...(candidate.rerankRank === undefined ? {} : { rerankRank: candidate.rerankRank }),
      providerRanks: Object.fromEntries(candidate.providerRanks),
      providerContributions,
      providerCoverage: candidate.providerRanks.size,
      fusionScore: providerScore + candidate.rerankContribution,
      rerankContribution: candidate.rerankContribution,
    };
  });

  ranked.sort((left, right) =>
    right.fusionScore - left.fusionScore
    || right.providerCoverage - left.providerCoverage
    || (left.rerankRank ?? Number.MAX_SAFE_INTEGER) - (right.rerankRank ?? Number.MAX_SAFE_INTEGER)
    || left.url.localeCompare(right.url));
  return ranked;
}
