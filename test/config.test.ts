import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

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

  it("falls back to auto for an unknown backend value", () => {
    expect(loadConfig({ WEB_SEARCH_BACKEND: "unknown" }).webSearchBackend).toBe("auto");
  });

  it("accepts explicit fast-cleaning configuration", () => {
    expect(loadConfig({ FAST_CLEANING_MODE: "on" }).fastCleaningMode).toBe("on");
    expect(loadConfig({ FAST_DOMAIN_CAP: "3" }).fastDomainCap).toBe(3);
    expect(loadConfig({ DOCUMENTATION_QUERY_MODE: "deep" }).documentationQueryMode).toBe("deep");
  });
});
