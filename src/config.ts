import type { SearchBackend } from "./types.js";

export interface AppConfig {
  webSearchBackend?: SearchBackend;
  deepseekApiKey?: string;
  deepseekSearchBaseUrl: string;
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
  openRouterRerankTimeoutMs: number;
  rerankCandidateLimit: number;
  rerankInputChars: number;
  searchCacheTtlMs: number;
  searchCacheMaxEntries: number;
  rerankCacheTtlMs: number;
  rerankCacheMaxEntries: number;
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

function searchBackend(value: string | undefined): SearchBackend {
  switch (optional(value)) {
    case "auto":
      return "auto";
    case "deepseek-native":
      return "deepseek-native";
    default:
      return "external";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const deepseekApiKey = optional(env.DEEPSEEK_API_KEY);
  const anySearchApiKey = optional(env.ANYSEARCH_API_KEY);
  const tavilyApiKey = optional(env.TAVILY_API_KEY);
  const openRouterApiKey = optional(env.OPENROUTER_API_KEY);
  const searxngUrl = optional(env.SEARXNG_URL);
  return {
    webSearchBackend: searchBackend(env.WEB_SEARCH_BACKEND),
    ...(deepseekApiKey === undefined ? {} : { deepseekApiKey }),
    deepseekSearchBaseUrl:
      optional(env.DEEPSEEK_SEARCH_BASE_URL) ?? "https://api.deepseek.com/anthropic",
    deepseekSearchModel: optional(env.DEEPSEEK_SEARCH_MODEL) ?? "deepseek-flash",
    deepseekSearchMaxUses: positiveInt(env.DEEPSEEK_SEARCH_MAX_USES, 5),
    deepseekSearchMaxTokens: positiveInt(env.DEEPSEEK_SEARCH_MAX_TOKENS, 4096),
    deepseekSearchTimeoutMs: positiveInt(env.DEEPSEEK_SEARCH_TIMEOUT_MS, 150_000),
    ...(anySearchApiKey === undefined ? {} : { anySearchApiKey }),
    anySearchMcpUrl: optional(env.ANYSEARCH_MCP_URL) ?? "https://api.anysearch.com/mcp",
    anySearchTimeoutMs: positiveInt(env.ANYSEARCH_TIMEOUT_MS, 6_000),
    ...(tavilyApiKey === undefined ? {} : { tavilyApiKey }),
    tavilyTimeoutMs: positiveInt(env.TAVILY_TIMEOUT_MS, 6_000),
    ...(openRouterApiKey === undefined ? {} : { openRouterApiKey }),
    openRouterRerankModel:
      optional(env.OPENROUTER_RERANK_MODEL) ?? "nvidia/llama-nemotron-rerank-vl-1b-v2:free",
    openRouterRerankTimeoutMs: positiveInt(env.OPENROUTER_RERANK_TIMEOUT_MS, 5_000),
    rerankCandidateLimit: positiveInt(env.RERANK_CANDIDATE_LIMIT, 30),
    rerankInputChars: positiveInt(env.RERANK_INPUT_CHARS, 800),
    searchCacheTtlMs: positiveInt(env.SEARCH_CACHE_TTL_MS, 600_000),
    searchCacheMaxEntries: positiveInt(env.SEARCH_CACHE_MAX_ENTRIES, 200),
    rerankCacheTtlMs: positiveInt(env.RERANK_CACHE_TTL_MS, 1_800_000),
    rerankCacheMaxEntries: positiveInt(env.RERANK_CACHE_MAX_ENTRIES, 200),
    ...(searxngUrl === undefined ? {} : { searxngUrl }),
    searxngLanguage: optional(env.SEARXNG_LANGUAGE) ?? "zh-CN",
    searxngTimeoutMs: positiveInt(env.SEARXNG_TIMEOUT_MS, 10_000),
  };
}
