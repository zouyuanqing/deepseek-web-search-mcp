import { describe, expect, it } from "vitest";
import { loadConfig, validateConfig } from "../src/config.js";

describe("web search backend configuration", () => {
  it("uses auto by default so a configured native key can join the source pool", () => {
    expect(loadConfig({}).webSearchBackend).toBe("auto");
    expect(loadConfig({}).fastCleaningMode).toBe("shadow");
    expect(loadConfig({}).fastDomainCap).toBe(2);
    expect(loadConfig({}).documentationQueryMode).toBe("fast");
    expect(loadConfig({}).researchSessionTtlMs).toBe(1_800_000);
    expect(loadConfig({}).researchSessionMaxTurns).toBe(8);
  });

  it("accepts native, hybrid, official-search, and automatic backend defaults", () => {
    expect(loadConfig({ WEB_SEARCH_BACKEND: "external" }).webSearchBackend).toBe("external");
    expect(loadConfig({ WEB_SEARCH_BACKEND: "deepseek-search" }).webSearchBackend)
      .toBe("deepseek-search");
    expect(loadConfig({ WEB_SEARCH_BACKEND: "deepseek-native" }).webSearchBackend)
      .toBe("deepseek-native");
    expect(loadConfig({ WEB_SEARCH_BACKEND: "hybrid" }).webSearchBackend).toBe("hybrid");
    expect(loadConfig({ WEB_SEARCH_BACKEND: "auto" }).webSearchBackend).toBe("auto");
  });

  it("defaults the official DeepSeek Search API configuration", () => {
    const config = loadConfig({});
    expect(config.deepseekSearchApiBaseUrl).toBe("https://api.deepseek.com/v1");
    expect(config.deepseekSearchApiTimeoutMs).toBe(15_000);
    expect(config.deepseekSearchNeedContent).toBe(false);
    // The legacy Messages API base stays separate from the official Search API base.
    expect(config.deepseekSearchBaseUrl).toBe("https://api.deepseek.com/anthropic");
  });

  it("accepts official DeepSeek Search API overrides", () => {
    const config = loadConfig({
      DEEPSEEK_SEARCH_API_BASE_URL: "https://search.example.test/v1",
      DEEPSEEK_SEARCH_API_TIMEOUT_MS: "9000",
      DEEPSEEK_SEARCH_NEED_CONTENT: "on",
    });
    expect(config.deepseekSearchApiBaseUrl).toBe("https://search.example.test/v1");
    expect(config.deepseekSearchApiTimeoutMs).toBe(9_000);
    expect(config.deepseekSearchNeedContent).toBe(true);
  });

  it("defaults the OpenRouter rerank/embedding/decisions configuration", () => {
    const config = loadConfig({});
    expect(config.openRouterRerankModel).toBe("nvidia/nemotron-3.5-rerank-8b:free");
    expect(config.openRouterRerankModelBalanced).toBe("nvidia/llama-nemotron-rerank-vl-1b-v2:free");
    expect(config.openRouterRerankModelDeep).toBeUndefined();
    expect(config.rerankNormalization).toBe("auto");
    expect(config.rerankConfidenceFloor).toBe(0.35);
    expect(config.rerankTop1Min).toBe(0.85);
    expect(config.openRouterRerankTimeoutMs).toBe(0);
    expect(config.embeddingMode).toBe("off");
    expect(config.embeddingModel).toBe("nvidia/nemotron-3.5-embed-8b:free");
    expect(config.embeddingFallbackModels).toEqual([
      "nvidia/llama-nemotron-embed-vl-1b-v2:free",
      "baai/bge-m3",
    ]);
    expect(config.decisionsMode).toBe("off");
    expect(config.openRouterDecisionsModel).toBe("parallel/decisions-fast:free");
    expect(config.openRouterDecisionsThreshold).toBeCloseTo(0.3);
    expect(config.rerankCandidateLimit).toBe(30);
  });

  it("accepts OpenRouter integration overrides and clamps unsafe values", () => {
    const config = loadConfig({
      OPENROUTER_RERANK_MODEL_BALANCED: "balanced/model",
      OPENROUTER_RERANK_MODEL_DEEP: "deep/model",
      RERANK_NORMALIZATION: "minmax",
      RERANK_CONFIDENCE_FLOOR: "0.4",
      RERANK_TOP1_MIN: "0.9",
      RERANK_CANDIDATE_LIMIT: "50",
      EMBEDDING_MODE: "shadow",
      DECISIONS_MODE: "shadow",
      WEB_SEARCH_DECISIONS_MODE: "on",
      OPENROUTER_DECISIONS_THRESHOLD: "0.35",
    });
    expect(config.openRouterRerankModelBalanced).toBe("balanced/model");
    expect(config.openRouterRerankModelDeep).toBe("deep/model");
    expect(config.rerankNormalization).toBe("minmax");
    expect(config.rerankConfidenceFloor).toBe(0.4);
    expect(config.rerankTop1Min).toBe(0.9);
    expect(config.rerankCandidateLimit).toBe(30);
    expect(config.embeddingMode).toBe("shadow");
    expect(config.decisionsMode).toBe("on");
    expect(config.openRouterDecisionsThreshold).toBe(0.35);
  });

  it("treats an invalid embedding dedupe threshold as unset", () => {
    expect(loadConfig({ EMBEDDING_DEDUPE_THRESHOLD: "not-a-number" }).embeddingDedupeThreshold)
      .toBeUndefined();
    expect(loadConfig({ EMBEDDING_DEDUPE_THRESHOLD: "0.7" }).embeddingDedupeThreshold).toBe(0.7);
  });

  it("warns when OpenRouter-backed modes are enabled without a key", () => {
    const warnings = validateConfig(loadConfig({ EMBEDDING_MODE: "on", DECISIONS_MODE: "on" }));
    expect(warnings.join(" ")).toContain("OPENROUTER_API_KEY");
    expect(validateConfig(loadConfig({ OPENROUTER_API_KEY: "k" }))).toEqual([]);
  });

  it("falls back to auto for an unknown backend value", () => {
    expect(loadConfig({ WEB_SEARCH_BACKEND: "unknown" }).webSearchBackend).toBe("auto");
  });

  it("accepts explicit fast-cleaning configuration", () => {
    expect(loadConfig({ FAST_CLEANING_MODE: "on" }).fastCleaningMode).toBe("on");
    expect(loadConfig({ FAST_DOMAIN_CAP: "3" }).fastDomainCap).toBe(3);
    expect(loadConfig({ DOCUMENTATION_QUERY_MODE: "deep" }).documentationQueryMode).toBe("deep");
  });
});
