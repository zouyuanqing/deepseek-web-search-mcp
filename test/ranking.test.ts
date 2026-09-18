import { describe, expect, it } from "vitest";
import {
  authorityScore,
  candidateTarget,
  fuseRankings,
  providerRequestLimit,
  resolveQuality,
  withoutRankingMetadata,
} from "../src/ranking.js";
import type { SearchSource } from "../src/types.js";

function source(
  url: string,
  provider: SearchSource["provider"] = "tavily",
  title?: string,
): SearchSource {
  return {
    url,
    provider,
    ...(title === undefined ? {} : { title }),
  };
}

describe("quality profiles", () => {
  it("defaults to fast and maps the legacy rerank flag to balanced", () => {
    expect(resolveQuality({})).toBe("fast");
    expect(resolveQuality({ rerank: true })).toBe("balanced");
    expect(resolveQuality({ quality: "deep", rerank: false })).toBe("deep");
  });

  it("uses the documented dynamic candidate and provider limits", () => {
    expect(providerRequestLimit("fast", 8)).toBe(10);
    expect(providerRequestLimit("balanced", 8)).toBe(10);
    expect(providerRequestLimit("deep", 8)).toBe(15);
    expect(providerRequestLimit("deep", 20)).toBe(20);
    expect(candidateTarget("fast", 8)).toBe(10);
    expect(candidateTarget("balanced", 8)).toBe(20);
    expect(candidateTarget("deep", 8)).toBe(30);
    expect(candidateTarget("deep", 20)).toBe(30);
  });
});

describe("official authority prior", () => {
  it("recognizes matching product domains and official source repositories", () => {
    const query = "SearXNG official Docker documentation";
    expect(authorityScore(query, source("https://docs.searxng.org/admin/installation.html"))).toBe(1);
    expect(authorityScore(query, source("https://github.com/searxng/searxng"))).toBe(0.9);
    expect(authorityScore(query, source("https://example.com/docs/searxng"))).toBe(0.7);
    expect(authorityScore(query, source("https://reddit.com/r/searxng"))).toBe(0);
  });

  it("keeps public authority signals for Chinese-only queries", () => {
    expect(authorityScore("上海天气 官方", source("http://sh.cma.gov.cn/"))).toBe(0.7);
  });
});

describe("rank fusion", () => {
  it("preserves equal rankings with the 50/50 weights", () => {
    const original = [
      source("https://example.com/a"),
      source("https://example.com/b"),
      source("https://example.com/c"),
    ];
    const fused = fuseRankings("test query", original, [...original]);
    expect(fused.sources.map((item) => item.url)).toEqual(original.map((item) => item.url));
    expect(fused.top1Protected).toBe(true);
  });

  it("guards the original top result when its rerank rank is still strong", () => {
    const original = [
      source("https://example.com/a"),
      source("https://example.com/b"),
      source("https://example.com/c"),
    ];
    const reranked = [original[2]!, original[0]!, original[1]!];
    const fused = fuseRankings("test query", original, reranked);
    expect(fused.sources[0]?.url).toBe(original[0]?.url);
    expect(fused.top1Protected).toBe(true);
  });

  it("allows a materially more authoritative rerank winner to replace top one", () => {
    const aggregator = source("https://reddit.com/r/deepseek");
    const official = source("https://api-docs.deepseek.com/guides/anthropic_api");
    const original = [
      aggregator,
      source("https://example.com/b"),
      source("https://example.com/c"),
      source("https://example.com/d"),
      official,
    ];
    const reranked = [official, aggregator, ...original.slice(1, 4)];
    const fused = fuseRankings("DeepSeek official API documentation", original, reranked);
    expect(fused.sources[0]?.url).toBe(official.url);
    expect(fused.top1Protected).toBe(false);
  });

  it("removes internal ranking metadata from public sources", () => {
    const fused = fuseRankings(
      "SearXNG official documentation",
      [source("https://docs.searxng.org/")],
      [source("https://docs.searxng.org/")],
    );
    expect(withoutRankingMetadata(fused.sources[0]!)).toEqual({
      url: "https://docs.searxng.org/",
      provider: "tavily",
    });
  });
});
