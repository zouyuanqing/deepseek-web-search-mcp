export type Scope = "auto" | "cn" | "global";
export type ResolvedScope = Exclude<Scope, "auto">;
export type Freshness = "any" | "day" | "week" | "month" | "year";
export type FreshnessMode = "soft" | "strict";
export type FastCleaningMode = "off" | "shadow" | "on";
export type Quality = "fast" | "balanced" | "deep";
export type SearchBackend = "auto" | "external" | "deepseek-native" | "hybrid";
export type SearchProviderId = "anysearch" | "tavily" | "searxng";
export type NativeSearchProviderId = "deepseek-native";
export type RerankerId = "openrouter-rerank";

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
  };
}

export interface FreshnessReport {
  requested: Freshness;
  mode: FreshnessMode;
  status: "not-requested" | "verified" | "estimated" | "unknown" | "unmet";
  cutoff?: string;
  filteredCount: number;
  providerCapabilities: Record<string, "native" | "soft" | "unsupported">;
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
}

export interface Reranker {
  id: RerankerId;
  rerank(
    query: string,
    sources: SearchSource[],
    signal?: AbortSignal,
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
