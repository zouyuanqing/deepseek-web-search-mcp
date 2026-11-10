import type {
  DecisionsMode,
  DocumentationQueryMode,
  EmbeddingMode,
  FastCleaningMode,
  RerankNormalization,
  SearchBackend,
} from "./types.js";

export type SourceIdentityMode = "off" | "on";

export const DEFAULT_RERANK_MODEL = "nvidia/nemotron-3.5-rerank-8b:free";
export const DEFAULT_RERANK_BALANCED_MODEL = "nvidia/llama-nemotron-rerank-vl-1b-v2:free";
export const DEFAULT_EMBEDDING_MODEL = "nvidia/nemotron-3.5-embed-8b:free";
export const DEFAULT_EMBEDDING_FALLBACKS = [
  "nvidia/llama-nemotron-embed-vl-1b-v2:free",
  "baai/bge-m3",
] as const;
export const DEFAULT_DECISIONS_MODEL = "parallel/decisions-fast:free";

export interface AppConfig {
  webSearchBackend?: SearchBackend;
  fastCleaningMode: FastCleaningMode;
  fastDomainCap: number;
  documentationQueryMode: DocumentationQueryMode;
  sourceIdentityMode: SourceIdentityMode;
  sourceIdentityCrossHost: boolean;
  sourceIdentityVerbose: boolean;
  freshnessIntentWarning: boolean;
  researchSessionTtlMs: number;
  researchSessionMaxSessions: number;
  researchSessionMaxTurns: number;
  deepseekApiKey?: string;
  deepseekSearchBaseUrl: string;
  deepseekSearchApiBaseUrl: string;
  deepseekSearchApiTimeoutMs: number;
  deepseekSearchNeedContent: boolean;
  deepseekSearchModel: string;
  deepseekSearchMaxUses: number;
  deepseekSearchMaxTokens: number;
  deepseekSearchTimeoutMs: number;
  anySearchApiKey?: string;
  anySearchMcpUrl: string;
  anySearchTimeoutMs: number;
  tavilyApiKey?: string;
  tavilyTimeoutMs: number;
  openRouterApiKey?: string;
  openRouterRerankModel: string;
  openRouterRerankModelBalanced?: string;
  openRouterRerankModelDeep?: string;
  openRouterRerankFallbackModel?: string;
  /** 0 means "resolve from the model profile" (old 5000ms, new 12000ms). */
  openRouterRerankTimeoutMs: number;
  rerankNormalization: RerankNormalization;
  rerankConfidenceFloor: number;
  rerankTop1Min: number;
  rerankCandidateLimit: number;
  rerankInputChars: number;
  searchCacheTtlMs: number;
  searchCacheMaxEntries: number;
  rerankCacheTtlMs: number;
  rerankCacheMaxEntries: number;
  openRouterMaxCallsPerMinute: number;
  openRouterMaxConcurrency: number;
  embeddingMode: EmbeddingMode;
  embeddingModel: string;
  embeddingFallbackModels: string[];
  embeddingMaxPairs: number;
  embeddingBudgetMs: number;
  embeddingDedupeThreshold?: number;
  embeddingCacheTtlMs: number;
  embeddingCacheMaxEntries: number;
  embeddingCircuitFailures: number;
  embeddingCircuitCooldownMs: number;
  decisionsMode: DecisionsMode;
  openRouterDecisionsModel: string;
  openRouterDecisionsThreshold: number;
  openRouterDecisionsTimeoutMs: number;
  openRouterDecisionsCacheTtlMs: number;
  openRouterDecisionsCacheMaxEntries: number;
  decisionsMaxCallsPerMinute: number;
  decisionsCircuitCooldownMs: number;
  searxngUrl?: string;
  searxngLanguage: string;
  searxngTimeoutMs: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optional(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

function enumEnv<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const normalized = optional(value);
  return normalized !== undefined && (allowed as readonly string[]).includes(normalized)
    ? (normalized as T)
    : fallback;
}

function optionalFloatEnv(value: string | undefined): number | undefined {
  const normalized = optional(value);
  if (normalized === undefined) return undefined;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function floatEnv(value: string | undefined, fallback: number): number {
  const normalized = optional(value);
  if (normalized === undefined) return fallback;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function csvEnv(value: string | undefined, fallback: readonly string[]): string[] {
  const normalized = optional(value);
  if (normalized === undefined) return [...fallback];
  const items = normalized.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  return items.length > 0 ? items : [...fallback];
}

function searchBackend(value: string | undefined): SearchBackend {
  switch (optional(value)) {
    case "external":
      return "external";
    case "auto":
      return "auto";
    case "deepseek-native":
      return "deepseek-native";
    case "deepseek-search":
      return "deepseek-search";
    case "hybrid":
      return "hybrid";
    default:
      return "auto";
  }
}

function fastCleaningMode(value: string | undefined): FastCleaningMode {
  switch (optional(value)) {
    case "off":
      return "off";
    case "on":
      return "on";
    default:
      return "shadow";
  }
}

function documentationQueryMode(value: string | undefined): DocumentationQueryMode {
  return optional(value) === "deep" ? "deep" : "fast";
}

function sourceIdentityMode(value: string | undefined): SourceIdentityMode {
  return optional(value) === "off" ? "off" : "on";
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = optional(value)?.toLowerCase();
  if (normalized === undefined) return fallback;
  return normalized !== "off" && normalized !== "false" && normalized !== "0";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const deepseekApiKey = optional(env.DEEPSEEK_API_KEY);
  const anySearchApiKey = optional(env.ANYSEARCH_API_KEY);
  const tavilyApiKey = optional(env.TAVILY_API_KEY);
  const openRouterApiKey = optional(env.OPENROUTER_API_KEY);
  const searxngUrl = optional(env.SEARXNG_URL);
  const rerankModelDeep = optional(env.OPENROUTER_RERANK_MODEL_DEEP);
  const rerankFallbackModel = optional(env.OPENROUTER_RERANK_FALLBACK_MODEL);
  const embeddingDedupeThreshold = optionalFloatEnv(env.EMBEDDING_DEDUPE_THRESHOLD);
  const rerankCandidateLimit = Math.min(30, positiveInt(env.RERANK_CANDIDATE_LIMIT, 30));
  return {
    webSearchBackend: searchBackend(env.WEB_SEARCH_BACKEND),
    fastCleaningMode: fastCleaningMode(env.FAST_CLEANING_MODE),
    fastDomainCap: positiveInt(env.FAST_DOMAIN_CAP, 2),
    documentationQueryMode: documentationQueryMode(env.DOCUMENTATION_QUERY_MODE),
    sourceIdentityMode: sourceIdentityMode(env.SOURCE_IDENTITY_MODE),
    sourceIdentityCrossHost: booleanEnv(env.SOURCE_IDENTITY_CROSS_HOST, true),
    sourceIdentityVerbose: booleanEnv(env.SOURCE_IDENTITY_VERBOSE, false),
    freshnessIntentWarning: booleanEnv(env.FRESHNESS_INTENT_WARNING, true),
    researchSessionTtlMs: positiveInt(env.RESEARCH_SESSION_TTL_MS, 1_800_000),
    researchSessionMaxSessions: positiveInt(env.RESEARCH_SESSION_MAX_SESSIONS, 100),
    researchSessionMaxTurns: positiveInt(env.RESEARCH_SESSION_MAX_TURNS, 8),
    ...(deepseekApiKey === undefined ? {} : { deepseekApiKey }),
    deepseekSearchBaseUrl:
      optional(env.DEEPSEEK_SEARCH_BASE_URL) ?? "https://api.deepseek.com/anthropic",
    deepseekSearchModel: optional(env.DEEPSEEK_SEARCH_MODEL) ?? "deepseek-flash",
    deepseekSearchMaxUses: positiveInt(env.DEEPSEEK_SEARCH_MAX_USES, 5),
    deepseekSearchMaxTokens: positiveInt(env.DEEPSEEK_SEARCH_MAX_TOKENS, 4096),
    deepseekSearchTimeoutMs: positiveInt(env.DEEPSEEK_SEARCH_TIMEOUT_MS, 150_000),
    deepseekSearchApiBaseUrl:
      optional(env.DEEPSEEK_SEARCH_API_BASE_URL) ?? "https://api.deepseek.com/v1",
    deepseekSearchApiTimeoutMs: positiveInt(env.DEEPSEEK_SEARCH_API_TIMEOUT_MS, 15_000),
    deepseekSearchNeedContent: booleanEnv(env.DEEPSEEK_SEARCH_NEED_CONTENT, false),
    ...(anySearchApiKey === undefined ? {} : { anySearchApiKey }),
    anySearchMcpUrl: optional(env.ANYSEARCH_MCP_URL) ?? "https://api.anysearch.com/mcp",
    anySearchTimeoutMs: positiveInt(env.ANYSEARCH_TIMEOUT_MS, 6_000),
    ...(tavilyApiKey === undefined ? {} : { tavilyApiKey }),
    tavilyTimeoutMs: positiveInt(env.TAVILY_TIMEOUT_MS, 6_000),
    ...(openRouterApiKey === undefined ? {} : { openRouterApiKey }),
    openRouterRerankModel: optional(env.OPENROUTER_RERANK_MODEL) ?? DEFAULT_RERANK_MODEL,
    openRouterRerankModelBalanced:
      optional(env.OPENROUTER_RERANK_MODEL_BALANCED) ?? DEFAULT_RERANK_BALANCED_MODEL,
    ...(rerankModelDeep === undefined ? {} : { openRouterRerankModelDeep: rerankModelDeep }),
    ...(rerankFallbackModel === undefined
      ? {}
      : { openRouterRerankFallbackModel: rerankFallbackModel }),
    openRouterRerankTimeoutMs: positiveInt(env.OPENROUTER_RERANK_TIMEOUT_MS, 0),
    rerankNormalization: enumEnv<RerankNormalization>(
      env.RERANK_NORMALIZATION,
      ["auto", "raw", "minmax"],
      "auto",
    ),
    rerankConfidenceFloor: floatEnv(env.RERANK_CONFIDENCE_FLOOR, 0.35),
    rerankTop1Min: floatEnv(env.RERANK_TOP1_MIN, 0.85),
    rerankCandidateLimit,
    rerankInputChars: positiveInt(env.RERANK_INPUT_CHARS, 800),
    searchCacheTtlMs: positiveInt(env.SEARCH_CACHE_TTL_MS, 600_000),
    searchCacheMaxEntries: positiveInt(env.SEARCH_CACHE_MAX_ENTRIES, 200),
    rerankCacheTtlMs: positiveInt(env.RERANK_CACHE_TTL_MS, 1_800_000),
    rerankCacheMaxEntries: positiveInt(env.RERANK_CACHE_MAX_ENTRIES, 200),
    openRouterMaxCallsPerMinute: positiveInt(env.OPENROUTER_MAX_CALLS_PER_MINUTE, 30),
    openRouterMaxConcurrency: positiveInt(env.OPENROUTER_MAX_CONCURRENCY, 2),
    embeddingMode: enumEnv<EmbeddingMode>(env.EMBEDDING_MODE, ["off", "shadow", "on"], "off"),
    embeddingModel: optional(env.EMBEDDING_MODEL) ?? DEFAULT_EMBEDDING_MODEL,
    embeddingFallbackModels: csvEnv(env.EMBEDDING_FALLBACK_MODELS, DEFAULT_EMBEDDING_FALLBACKS),
    embeddingMaxPairs: positiveInt(env.EMBEDDING_MAX_PAIRS, 8),
    embeddingBudgetMs: positiveInt(env.EMBEDDING_BUDGET_MS, 6_000),
    ...(embeddingDedupeThreshold === undefined ? {} : { embeddingDedupeThreshold }),
    embeddingCacheTtlMs: positiveInt(env.EMBEDDING_CACHE_TTL_MS, 3_600_000),
    embeddingCacheMaxEntries: positiveInt(env.EMBEDDING_CACHE_MAX_ENTRIES, 300),
    embeddingCircuitFailures: positiveInt(env.EMBEDDING_CIRCUIT_FAILURES, 5),
    embeddingCircuitCooldownMs: positiveInt(env.EMBEDDING_CIRCUIT_COOLDOWN_MS, 120_000),
    decisionsMode: enumEnv<DecisionsMode>(
      optional(env.WEB_SEARCH_DECISIONS_MODE) ?? optional(env.DECISIONS_MODE),
      ["off", "shadow", "on"],
      "off",
    ),
    openRouterDecisionsModel:
      optional(env.OPENROUTER_DECISIONS_MODEL) ?? DEFAULT_DECISIONS_MODEL,
    openRouterDecisionsThreshold: floatEnv(env.OPENROUTER_DECISIONS_THRESHOLD, 0.30),
    openRouterDecisionsTimeoutMs: positiveInt(env.OPENROUTER_DECISIONS_TIMEOUT_MS, 4_000),
    openRouterDecisionsCacheTtlMs: positiveInt(env.OPENROUTER_DECISIONS_CACHE_TTL_MS, 86_400_000),
    openRouterDecisionsCacheMaxEntries: positiveInt(env.OPENROUTER_DECISIONS_CACHE_MAX_ENTRIES, 500),
    decisionsMaxCallsPerMinute: positiveInt(env.WEB_SEARCH_DECISIONS_MAX_CALLS_PER_MINUTE, 4),
    decisionsCircuitCooldownMs: positiveInt(env.WEB_SEARCH_DECISIONS_CIRCUIT_COOLDOWN_MS, 300_000),
    ...(searxngUrl === undefined ? {} : { searxngUrl }),
    searxngLanguage: optional(env.SEARXNG_LANGUAGE) ?? "zh-CN",
    searxngTimeoutMs: positiveInt(env.SEARXNG_TIMEOUT_MS, 10_000),
  };
}

/** Startup warnings for configuration combinations that silently degrade. */
export function validateConfig(config: AppConfig): string[] {
  const warnings: string[] = [];
  if (config.openRouterApiKey === undefined) {
    if (config.embeddingMode !== "off") {
      warnings.push("EMBEDDING_MODE is enabled but OPENROUTER_API_KEY is not configured; embeddings will be skipped.");
    }
    if (config.decisionsMode !== "off") {
      warnings.push("WEB_SEARCH_DECISIONS_MODE is enabled but OPENROUTER_API_KEY is not configured; decisions will be skipped.");
    }
  }
  return warnings;
}
