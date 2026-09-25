import { describe, expect, it } from "vitest";
import { providerAwareRrf } from "../src/quality.js";
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
