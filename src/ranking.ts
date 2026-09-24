import type { Quality, SearchInput, SearchSource } from "./types.js";
import { canonicalizeUrl } from "./utils.js";

export interface QualityProfile {
  providerLimit: number;
  candidateTarget: number;
  rerank: boolean;
}

export const QUALITY_PROFILES: Record<Quality, QualityProfile> = {
  fast: {
    providerLimit: 10,
    candidateTarget: 10,
    rerank: false,
  },
  balanced: {
    providerLimit: 10,
    candidateTarget: 20,
    rerank: true,
  },
  deep: {
    providerLimit: 15,
    candidateTarget: 30,
    rerank: true,
  },
};

export const RANK_FUSION_WEIGHTS = {
  original: 0.5,
  rerank: 0.5,
} as const;

const RRF_K = 60;
const OFFICIAL_BOOST = 0.003;
export const RERANK_CONFIDENCE_FLOOR = 0.35;
export const TOP1_MIN_RERANK_RELEVANCE = 0.5;

const OFFICIAL_INTENT_PATTERN =
  /(?:官方|official|\bdocs?\b|documentation|\bapi\b|reference|source\s+code|release|changelog)/iu;

const TOKEN_STOP_WORDS = new Set([
  "and",
  "api",
  "code",
  "current",
  "docs",
  "documentation",
  "for",
  "latest",
  "official",
  "reference",
  "recommendation",
  "release",
  "search",
  "source",
  "the",
  "web",
  "with",
]);

const AGGREGATOR_HOSTS = [
  "reddit.com",
  "medium.com",
  "juejin.cn",
  "csdn.net",
  "zhihu.com",
  "cnblogs.com",
  "segmentfault.com",
  "dev.to",
];

export interface RankedSource extends SearchSource {
  originalRank: number;
  rerankRank: number;
  rerankConfidence: number;
  authorityScore: number;
  fusionScore: number;
}

export interface FusionResult {
  sources: RankedSource[];
  top1Protected: boolean;
  officialIntent: boolean;
}

export function resolveQuality(input: Pick<SearchInput, "quality" | "rerank">): Quality {
  if (input.quality !== undefined) return input.quality;
  return input.rerank === true ? "balanced" : "fast";
}

export function providerRequestLimit(quality: Quality, maxResults: number): number {
  const profile = QUALITY_PROFILES[quality];
  return Math.min(20, Math.max(maxResults, profile.providerLimit));
}

export function candidateTarget(
  quality: Quality,
  maxResults: number,
  maxCandidateLimit = 30,
): number {
  const profile = QUALITY_PROFILES[quality];
  return Math.max(maxResults, Math.min(profile.candidateTarget, maxCandidateLimit));
}

export function hasOfficialIntent(query: string): boolean {
  return OFFICIAL_INTENT_PATTERN.test(query);
}

function queryTokens(query: string): string[] {
  const normalized = query.normalize("NFKC").toLowerCase();
  const rawTokens = normalized.match(/[a-z0-9][a-z0-9_-]{1,}/gu) ?? [];
  const tokens = new Set<string>();
  for (const rawToken of rawTokens) {
    for (const token of [rawToken, ...rawToken.split(/[-_]+/u)]) {
      if (token.length >= 3 && !TOKEN_STOP_WORDS.has(token)) tokens.add(token);
    }
  }
  return [...tokens];
}

function isAggregatorHost(host: string): boolean {
  return AGGREGATOR_HOSTS.some(
    (aggregator) => host === aggregator || host.endsWith(`.${aggregator}`),
  );
}

function hasMatchingHostLabel(host: string, tokens: string[]): boolean {
  const labels = host.split(".");
  return tokens.some((token) => labels.includes(token));
}

function hasMatchingGithubOrganization(pathname: string, tokens: string[]): boolean {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const organization = segments[0]?.toLowerCase();
  return organization !== undefined && tokens.includes(organization);
}

function hasMatchingNpmPackage(pathname: string, tokens: string[]): boolean {
  const packagePath = pathname
    .replace(/^\/package\/?/u, "")
    .toLowerCase();
  return tokens.some((token) => packagePath.includes(token));
}

function isDocumentationHostOrPath(host: string, pathname: string): boolean {
  return /^(?:docs|developers|api|api-docs)\./u.test(host)
    || /\/(?:docs?|reference|api)(?:\/|$)/iu.test(pathname);
}

function isPublicAuthorityHost(host: string): boolean {
  return host.split(".").some((label) => label === "gov" || label === "edu");
}

export function authorityScore(query: string, source: SearchSource): number {
  let parsed: URL;
  try {
    parsed = new URL(source.url);
  } catch {
    return 0;
  }

  const host = parsed.hostname.toLowerCase();
  if (isAggregatorHost(host)) return 0;

  const tokens = queryTokens(query);
  if (tokens.length > 0) {
    if (hasMatchingHostLabel(host, tokens)) return 1;
    if (host === "github.com" || host.endsWith(".github.com")) {
      if (hasMatchingGithubOrganization(parsed.pathname, tokens)) return 0.9;
    }
    if (host === "npmjs.com" || host.endsWith(".npmjs.com")) {
      if (hasMatchingNpmPackage(parsed.pathname, tokens)) return 0.9;
    }
  }
  if (isDocumentationHostOrPath(host, parsed.pathname)) return 0.7;
  if (isPublicAuthorityHost(host)) return 0.7;
  return 0;
}

function sourceKey(source: SearchSource): string {
  return canonicalizeUrl(source.url) ?? source.url;
}

function rankScore(rank: number, weight: number): number {
  return weight / (RRF_K + rank);
}

export function rerankConfidence(score: number | undefined): number {
  if (score === undefined || !Number.isFinite(score)) return 0;
  const normalized = Math.max(0, Math.min(1, score));
  // Low-confidence candidates receive no rerank evidence, not a noisy rank bonus.
  if (normalized <= RERANK_CONFIDENCE_FLOOR) return 0;
  return (normalized - RERANK_CONFIDENCE_FLOOR) / (1 - RERANK_CONFIDENCE_FLOOR);
}

function hasTop1RelevantRerank(source: RankedSource): boolean {
  return source.rerankScore !== undefined
    && source.rerankScore >= TOP1_MIN_RERANK_RELEVANCE;
}

function compareRanked(left: RankedSource, right: RankedSource): number {
  return right.fusionScore - left.fusionScore
    || right.rerankConfidence - left.rerankConfidence
    || right.authorityScore - left.authorityScore
    || left.rerankRank - right.rerankRank
    || left.originalRank - right.originalRank
    || left.url.localeCompare(right.url);
}

export function fuseRankings(
  query: string,
  originalSources: SearchSource[],
  rerankSources: SearchSource[],
): FusionResult {
  const officialIntent = hasOfficialIntent(query);
  const originalRanks = new Map<string, number>();
  originalSources.forEach((source, index) => {
    const key = sourceKey(source);
    if (!originalRanks.has(key)) originalRanks.set(key, index + 1);
  });

  const rerankRanks = new Map<string, number>();
  rerankSources.forEach((source, index) => {
    const key = sourceKey(source);
    if (!rerankRanks.has(key)) rerankRanks.set(key, index + 1);
  });

  const missingRerankRank = originalSources.length + 1;
  const rerankByKey = new Map(rerankSources.map((source) => [sourceKey(source), source]));
  const ranked: RankedSource[] = originalSources.map((source, index) => {
    const key = sourceKey(source);
    const originalRank = originalRanks.get(key) ?? index + 1;
    const rerankRank = rerankRanks.get(key) ?? missingRerankRank;
    const sourceAuthority = authorityScore(query, source);
    const rerankSource = rerankByKey.get(key);
    const confidence = rerankConfidence(rerankSource?.rerankScore);
    const rrf = rankScore(originalRank, RANK_FUSION_WEIGHTS.original)
      + rankScore(rerankRank, RANK_FUSION_WEIGHTS.rerank * confidence);
    return {
      ...source,
      ...(rerankSource?.rerankScore === undefined
        ? {}
        : { rerankScore: rerankSource.rerankScore }),
      originalRank,
      rerankRank,
      rerankConfidence: confidence,
      authorityScore: sourceAuthority,
      fusionScore: rrf + (
        officialIntent ? sourceAuthority * OFFICIAL_BOOST * confidence : 0
      ),
    };
  });

  ranked.sort(compareRanked);

  const originalTop = ranked.find((source) => source.originalRank === 1);
  const fusedTop = ranked[0];
  let top1Protected = false;
  if (
    originalTop !== undefined
    && fusedTop !== undefined
    && originalTop.rerankRank <= 5
    && hasTop1RelevantRerank(originalTop)
    && !(
      fusedTop.rerankRank <= 2
      && hasTop1RelevantRerank(fusedTop)
      && fusedTop.authorityScore >= originalTop.authorityScore + 0.25
    )
  ) {
    const originalIndex = ranked.indexOf(originalTop);
    if (originalIndex > 0) {
      ranked.splice(originalIndex, 1);
      ranked.unshift(originalTop);
    }
    top1Protected = true;
  }

  return {
    sources: ranked,
    top1Protected,
    officialIntent,
  };
}

export function withoutRankingMetadata(source: RankedSource): SearchSource {
  const {
    originalRank: _originalRank,
    rerankRank: _rerankRank,
    rerankConfidence: _rerankConfidence,
    authorityScore: _authorityScore,
    fusionScore: _fusionScore,
    ...publicSource
  } = source;
  return publicSource;
}
