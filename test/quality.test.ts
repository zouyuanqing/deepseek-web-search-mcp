import { describe, expect, it } from "vitest";
import { cleanFastSources, providerAwareRrf } from "../src/quality.js";
import type { SearchSource } from "../src/types.js";

function source(url: string, provider: SearchSource["provider"]): SearchSource {
  return { url, provider };
}

describe("provider-aware RRF shadow challenger", () => {
  it("preserves independent provider ranks and rewards cross-provider agreement", () => {
    const result = providerAwareRrf([
      { provider: "tavily", sources: [source("https://example.com/a", "tavily")] },
      { provider: "searxng", sources: [
        source("https://example.com/b", "searxng"),
        source("https://example.com/a", "searxng"),
      ] },
      { provider: "deepseek-native", sources: [
        source("https://example.com/a", "deepseek-native"),
      ] },
    ], [], { k: 60 });

    expect(result[0]?.url).toBe("https://example.com/a");
    expect(result[0]?.providerRanks).toEqual({
      tavily: 1,
      searxng: 2,
      "deepseek-native": 1,
    });
    expect(result[0]?.providerCoverage).toBe(3);
    expect(result[0]?.fusionScore).toBeGreaterThan(result[1]?.fusionScore ?? 0);
  });

  it("adds an independent rerank list without changing provider ranks", () => {
    const result = providerAwareRrf([
      { provider: "tavily", sources: [
        source("https://example.com/a", "tavily"),
        source("https://example.com/b", "tavily"),
      ] },
    ], [source("https://example.com/b", "tavily")], { k: 60, rerankWeight: 0.5 });

    expect(result[0]?.url).toBe("https://example.com/b");
    expect(result[0]?.rerankRank).toBe(1);
    expect(result[1]?.rerankRank).toBeUndefined();
  });

  it("ignores invalid URLs and does not invent missing provider ranks", () => {
    const result = providerAwareRrf([
      { provider: "tavily", sources: [source("not-a-url", "tavily")] },
      { provider: "searxng", sources: [source("https://example.com/a", "searxng")] },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.providerRanks).toEqual({ searxng: 1 });
  });
});

describe("fast source cleaning", () => {
  it("keeps authoritative sources ahead of low-quality aggregators", () => {
    const result = cleanFastSources(
      "DeepSeek official API documentation",
      [
        source("https://www.reddit.com/r/deepseek/comments/1", "tavily"),
        { ...source("https://api-docs.deepseek.com/", "tavily"), title: "DeepSeek API Docs" },
        { ...source("https://youtube.com/watch?v=1", "searxng"), title: "DeepSeek video" },
      ],
      { mode: "on", maxResults: 3, domainCap: 2 },
    );

    expect(result.applied).toBe(true);
    expect(result.sources[0]?.url).toBe("https://api-docs.deepseek.com/");
    expect(result.sources[0]?.url).not.toContain("reddit.com");
  });

  it("supports shadow mode without changing returned sources", () => {
    const sources = [
      source("https://reddit.com/r/deepseek", "tavily"),
      source("https://api-docs.deepseek.com/", "tavily"),
    ];
    const result = cleanFastSources("DeepSeek official API", sources, {
      mode: "shadow",
      maxResults: 2,
      domainCap: 2,
    });

    expect(result.applied).toBe(false);
    expect(result.sources).toEqual(sources);
    expect(result.shadowSources[0]?.url).toBe("https://api-docs.deepseek.com/");
  });
});
