export type Scope = "auto" | "cn" | "global";
export type ResolvedScope = Exclude<Scope, "auto">;
export type Freshness = "any" | "day" | "week" | "month" | "year";
export type FreshnessMode = "soft" | "strict";
export type FastCleaningMode = "off" | "shadow" | "on";
export type Quality = "fast" | "balanced" | "deep";
export type SearchBackend = "auto" | "external" | "deepseek-search" | "deepseek-native" | "hybrid";
export type DocumentationQueryMode = "fast" | "deep";
export type SearchProviderId = "anysearch" | "tavily" | "searxng" | "deepseek-search";
export type NativeSearchProviderId = "deepseek-native";
export type RerankerId = "openrouter-rerank";
export type RerankNormalization = "auto" | "raw" | "minmax";
export type RerankSignalQuality = "strong" | "weak";
export type EmbeddingMode = "off" | "shadow" | "on";
export type DecisionsMode = "off" | "shadow" | "on";

export interface RerankScoreReport {
  mode: RerankNormalization;
  applied: boolean;
  rawMin?: number;
  rawMax?: number;
  spread?: number;
  signalQuality: RerankSignalQuality;
}

export interface EmbeddingReport {
  mode: EmbeddingMode;
  applied: boolean;
  model?: string;
  dims?: number;
  candidates: number;
  embedded: number;
  mergedPairs: number;
  partial: boolean;
  fallbackIndex?: number;
  circuitOpen: boolean;
  elapsedMs: number;
  usage?: Record<string, unknown>;
  /** Shadow mode: number of pairs that would have been merged. */
  wouldMerge?: number;
}

export interface DecisionsReport {
  mode: DecisionsMode;
  applied: boolean;
  verdict: "veto" | "keep" | "fallback";
  p?: number;
  threshold: number;
  regexOfficialIntent: boolean;
  resolvedOfficialIntent: boolean;
  cached: boolean;
  fallbackReason?: string;
  elapsedMs: number;
  annotations?: number;
}

export interface SearchInput {
  query: string;
  scope: Scope;
  maxResults: number;
  freshness: Freshness;
  freshnessMode?: FreshnessMode;
  quality?: Quality;
  rerank?: boolean;
  backend?: SearchBackend;
}

export interface ResearchInput {
  query: string;
  maxSources: number;
  freshness: Freshness;
  freshnessMode?: FreshnessMode;
}

export interface SearchSource {
  title?: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  score?: number;
  rerankScore?: number;
  /** DeepSeek Search API authority tier: 0-4, -1 when unknown. */
  authorityTier?: number;
  /** Full page content, only when DEEPSEEK_SEARCH_NEED_CONTENT is enabled. */
  content?: string;
  provider: SearchProviderId | NativeSearchProviderId;
}

export interface ProviderResult {
  provider: SearchProviderId | NativeSearchProviderId;
  sources: SearchSource[];
  answer?: string;
  warnings: string[];
  usage?: Record<string, unknown>;
  nativeSearch?: {
    requests: number;
    calls: NativeSearchCall[];
  };
}

export interface ProviderAttempt {
  provider: SearchProviderId | NativeSearchProviderId;
  status: "ok" | "empty" | "error";
  elapsedMs: number;
  cached?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface SearchResult {
  query: string;
  scope: ResolvedScope;
  mode: "fast" | "reranked" | "native";
  quality: Quality;
  backend: Exclude<SearchBackend, "auto">;
  provider: SearchProviderId | NativeSearchProviderId | "multiple" | null;
  fallbackUsed: boolean;
  attempts: ProviderAttempt[];
  sources: SearchSource[];
  answer?: string;
  warnings: string[];
  nativeSearchRequests?: number;
  nativeSearchCalls?: NativeSearchCall[];
  nativeSearchDegraded?: boolean;
  freshness?: FreshnessReport;
  sourceIdentity?: SourceIdentityReport;
  fastCleaning?: {
    mode: FastCleaningMode;
    applied: boolean;
    candidateCount: number;
    selectedCount: number;
    providerCoverage: number;
  };
  rerank?: {
    requested: boolean;
    applied: boolean;
    provider: RerankerId;
    strategy?: "rank_fusion";
    weights?: {
      original: number;
      rerank: number;
    };
    model?: string;
    elapsedMs?: number;
    inputCount?: number;
    candidateCount?: number;
    cached?: boolean;
    top1Protected?: boolean;
    reason?: string;
    normalization?: RerankNormalization;
    scoreRange?: { min: number; max: number; spread: number };
    signalQuality?: RerankSignalQuality;
    usage?: Record<string, unknown>;
  };
  embedding?: EmbeddingReport;
  decisions?: DecisionsReport;
}

export interface FreshnessReport {
  requested: Freshness;
  mode: FreshnessMode;
  status: "not-requested" | "verified" | "estimated" | "unknown" | "unmet";
  cutoff?: string;
  filteredCount: number;
  providerCapabilities: Record<string, "native" | "soft" | "unsupported">;
  intent?: {
    timeSensitive: boolean;
    signals: string[];
    recommendedFreshness?: Exclude<Freshness, "any">;
    recommendedMode?: "strict";
  };
}

export interface SourceIdentityReport {
  applied: boolean;
  inputCount: number;
  mergedCount: number;
  languageVariantCount: number;
  crossHostCopyCount: number;
  conflictingDateCount: number;
  /** Additional merges attributed to semantic dedupe (0 when off). */
  semanticCopyCount?: number;
  independence: {
    independentDomains: number;
    dominantDomainShare: number;
    lowAuthorityShare: number;
    level: "high" | "medium" | "low";
  };
  groups?: Array<{
    keptUrl: string;
    mergedUrls: string[];
    hosts: string[];
    reason: "same-url" | "language-variant" | "syndicated-copy" | "semantic-syndication";
    dateConflict: boolean;
  }>;
}

export interface NativeSearchCall {
  id?: string;
  type: "server_tool_use";
  query?: string;
}

export interface ResearchResult {
  query: string;
  provider: NativeSearchProviderId;
  answerMarkdown: string;
  sources: SearchSource[];
  nativeSearchRequests: number;
  nativeSearchCalls: NativeSearchCall[];
  usage?: Record<string, unknown>;
  warnings: string[];
  degraded: boolean;
  freshness?: FreshnessReport;
  sourceQuality?: {
    officialSources: number;
    totalSources: number;
    independentDomains?: number;
    independence?: "high" | "medium" | "low";
  };
  sourceIdentity?: SourceIdentityReport;
}

export interface SearchProvider {
  id: SearchProviderId;
  search(input: SearchInput, signal?: AbortSignal): Promise<ProviderResult>;
}

export interface RerankResult {
  sources: SearchSource[];
  model: string;
  elapsedMs: number;
  inputCount: number;
  usage?: Record<string, unknown>;
}

export interface Reranker {
  id: RerankerId;
  rerank(
    query: string,
    sources: SearchSource[],
    signal?: AbortSignal,
    options?: { model?: string },
  ): Promise<RerankResult>;
  health(signal?: AbortSignal): Promise<number>;
}

export interface DeepSeekNativeProvider {
  id: NativeSearchProviderId;
  research(input: ResearchInput, signal?: AbortSignal): Promise<Omit<ResearchResult, "degraded">>;
}

export interface HealthReport {
  ok: boolean;
  checkedAt: string;
  providers: Record<string, {
    ok: boolean;
    elapsedMs: number;
    detail?: string;
  }>;
}
