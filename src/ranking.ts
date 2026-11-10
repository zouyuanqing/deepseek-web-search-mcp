import { calibrateRerankScores } from "./rerank-calibration.js";
import type {
  Quality,
  RerankNormalization,
  RerankScoreReport,
  SearchInput,
  SearchSource,
} from "./types.js";
import { canonicalizeUrl } from "./utils.js";
import {
  isAggregatorHost,
  isDocumentationHostOrPath,
  isLowAuthorityHost,
  isPublicAuthorityHost,
} from "./hosts.js";

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
/** Minimum calibrated rerank score for the top-1 protection gate (v1.7 recalibration). */
export const TOP1_MIN_RERANK_RELEVANCE = 0.85;
/** Profile-neutral alias for the top-1 relevance floor. */
export const RERANK_TOP1_MIN = TOP1_MIN_RERANK_RELEVANCE;
/** The original top result is only protected while rerank keeps it near the top. */
const TOP1_MAX_RERANK_RANK = 2;

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
  /** How rerank scores were calibrated, in rerank-result order. */
  calibration?: RerankScoreReport & { scores: number[] };
}

export interface FusionOptions {
  /** Overrides regex-based official intent detection (e.g. a decisions-model verdict). */
  officialIntent?: boolean;
  /** Rerank model that produced the scores; selects the calibration profile. */
  rerankModel?: string;
  /** Score normalization mode; "auto" resolves from the rerank model profile. */
  rerankNormalization?: RerankNormalization;
  /** Absolute calibrated-score floor below which rerank evidence is ignored. */
  confidenceFloor?: number;
  /** Minimum calibrated rerank score for top-1 protection. */
  top1Min?: number;
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

export function authorityScore(query: string, source: SearchSource): number {
  let parsed: URL;
  try {
    parsed = new URL(source.url);
  } catch {
    return 0;
  }

  const host = parsed.hostname.toLowerCase();
  if (isAggregatorHost(host)) return 0;
  if (isLowAuthorityHost(source.url)) return 0;
  // The official Search API returns its own authority tier; trust it over
  // host heuristics when present (tier 3+ is documented as highly authoritative).
  if (source.authorityTier !== undefined && Number.isFinite(source.authorityTier)) {
    const tier = Math.trunc(source.authorityTier);
    if (tier >= 3) return 0.9;
    if (tier === 2) return 0.6;
    if (tier === 1) return 0.3;
    if (tier === 0) return 0;
  }

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

export function rerankConfidence(
  score: number | undefined,
  floor = RERANK_CONFIDENCE_FLOOR,
): number {
  if (score === undefined || !Number.isFinite(score)) return 0;
  const effectiveFloor = Number.isFinite(floor)
    ? Math.max(0, Math.min(1, floor))
    : RERANK_CONFIDENCE_FLOOR;
  const normalized = Math.max(0, Math.min(1, score));
  // Low-confidence candidates receive no rerank evidence, not a noisy rank bonus.
  if (normalized <= effectiveFloor) return 0;
  return (normalized - effectiveFloor) / (1 - effectiveFloor);
}

function isTop1Relevant(score: number | undefined, top1Min: number): boolean {
  return score !== undefined && Number.isFinite(score) && score >= top1Min;
}

function resolveTop1Min(top1Min: number | undefined): number {
  if (top1Min === undefined || !Number.isFinite(top1Min)) {
    return TOP1_MIN_RERANK_RELEVANCE;
  }
  return Math.max(0, Math.min(1, top1Min));
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
  options: FusionOptions = {},
): FusionResult {
  const officialIntent = options.officialIntent ?? hasOfficialIntent(query);
  const top1Min = resolveTop1Min(options.top1Min);
  // Calibrate the model's raw scores before any absolute gate sees them: a
  // compressed distribution would otherwise make rerank a silent no-op.
  const calibration = calibrateRerankScores(
    rerankSources.map((source) => source.rerankScore ?? 0),
    options.rerankNormalization ?? "auto",
    options.rerankModel ?? "",
  );
  const calibratedByKey = new Map<string, number>();
  rerankSources.forEach((source, index) => {
    const key = sourceKey(source);
    if (!calibratedByKey.has(key)) {
      calibratedByKey.set(key, calibration.scores[index] ?? 0);
    }
  });

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
    const confidence = rerankConfidence(
      calibratedByKey.get(key),
      options.confidenceFloor,
    );
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
  const calibratedScore = (source: RankedSource | undefined): number | undefined =>
    source === undefined ? undefined : calibratedByKey.get(sourceKey(source));
  let top1Protected = false;
  if (
    originalTop !== undefined
    && fusedTop !== undefined
    && originalTop.rerankRank <= TOP1_MAX_RERANK_RANK
    && isTop1Relevant(calibratedScore(originalTop), top1Min)
    && !(
      fusedTop.rerankRank <= TOP1_MAX_RERANK_RANK
      && isTop1Relevant(calibratedScore(fusedTop), top1Min)
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
    calibration,
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
