import type {
  Freshness,
  NativeSearchProviderId,
  ResolvedScope,
  SearchProviderId,
  SearchSource,
} from "./types.js";
import { canonicalizeUrl } from "./utils.js";

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
