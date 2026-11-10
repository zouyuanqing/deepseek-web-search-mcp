import { describe, expect, it } from "vitest";
import {
  authorityScore,
  candidateTarget,
  fuseRankings,
  providerRequestLimit,
  rerankConfidence,
  RERANK_CONFIDENCE_FLOOR,
  RERANK_TOP1_MIN,
  resolveQuality,
  withoutRankingMetadata,
} from "../src/ranking.js";
import type { SearchSource } from "../src/types.js";

const NEW_MODEL = "nvidia/nemotron-3.5-rerank-8b:free";

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

function reranked(
  item: SearchSource,
  relevanceScore: number,
): SearchSource {
  return { ...item, rerankScore: relevanceScore };
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

  it("never gives an authority prior to reported content farms", () => {
    for (const url of [
      "https://ofox.ai/ai-tools",
      "https://techsy.io/en/ai-tools",
      "https://taskade.com/ai-tools",
    ]) {
      expect(authorityScore("ai tools", source(url)), url).toBe(0);
    }
  });

  it("does not demote unknown domains to make room for a content farm", () => {
    expect(authorityScore("kubernetes ingress", source("https://docs.k8s.io/guide"))).toBe(0.7);
    expect(authorityScore("kubernetes ingress", source("https://unknown-blog.example/guide"))).toBe(0);
  });

  it("uses the DeepSeek Search API authority tier after explicit host denylists", () => {
    const tiered = (tier: number, url = "https://example.com/page"): SearchSource => ({
      ...source(url),
      authorityTier: tier,
    });
    expect(authorityScore("any query", tiered(4))).toBe(0.9);
    expect(authorityScore("any query", tiered(3))).toBe(0.9);
    expect(authorityScore("any query", tiered(2))).toBe(0.6);
    expect(authorityScore("any query", tiered(1))).toBe(0.3);
    expect(authorityScore("any query", tiered(0))).toBe(0);
    // -1 means unknown: fall back to the existing host heuristics.
    expect(authorityScore("any query", tiered(-1, "https://example.com/docs/page"))).toBe(0.7);
    // The explicit aggregator/content-farm denylist still wins over a high tier.
    expect(authorityScore("any query", tiered(4, "https://reddit.com/r/deepseek"))).toBe(0);
    expect(authorityScore("any query", tiered(4, "https://techsy.io/en/deepseek"))).toBe(0);
  });
});

describe("rank fusion", () => {
  it("preserves equal rankings with the 50/50 weights", () => {
    const original = [
      source("https://example.com/a"),
      source("https://example.com/b"),
      source("https://example.com/c"),
    ];
    const fused = fuseRankings(
      "test query",
      original,
      original.map((item) => reranked(item, 0.9)),
    );
    expect(fused.sources.map((item) => item.url)).toEqual(original.map((item) => item.url));
    expect(fused.top1Protected).toBe(true);
  });

  it("guards the original top result while rerank keeps it near the top", () => {
    const original = [
      source("https://example.com/a"),
      source("https://example.com/b"),
      source("https://example.com/c"),
    ];
    const rerankedSources = [
      reranked(original[2]!, 0.9),
      reranked(original[0]!, 0.9),
      reranked(original[1]!, 0.9),
    ];
    const fused = fuseRankings("test query", original, rerankedSources);
    expect(fused.sources[0]?.url).toBe(original[0]?.url);
    expect(fused.top1Protected).toBe(true);
  });

  it("requires the original top result to clear the recalibrated 0.85 floor", () => {
    const original = [
      source("https://example.com/original-top"),
      source("https://example.com/reliable-alternative"),
      source("https://example.com/third"),
    ];
    const fused = fuseRankings(
      "test query",
      original,
      [
        reranked(original[1]!, 0.9),
        reranked(original[0]!, RERANK_TOP1_MIN - 0.01),
        reranked(original[2]!, 0.9),
      ],
    );

    expect(fused.sources[0]?.url).toBe(original[1]?.url);
    expect(fused.top1Protected).toBe(false);
  });

  it("protects the original top result when it clears the floor and rerank kept it at rank 2", () => {
    const originalTop = source("https://example.com/original-top");
    const second = source("https://example.com/second");
    const official = source("https://docs.searxng.org/guide");
    const original = [originalTop, second, official];
    // Rerank promotes an authoritative-but-rank-3 candidate over the original
    // top; the original top is still near the top (rank 2) so it is protected.
    const fused = fuseRankings(
      "SearXNG official documentation",
      original,
      [
        reranked(second, 0.9),
        reranked(originalTop, 0.9),
        reranked(official, 0.9),
      ],
    );

    expect(fused.sources[0]?.url).toBe(originalTop.url);
    expect(fused.top1Protected).toBe(true);
  });

  it("does not protect an original top result that fell to rerank rank 3", () => {
    const original = [
      source("https://example.com/a"),
      source("https://example.com/b"),
      source("https://example.com/c"),
    ];
    const fused = fuseRankings(
      "test query",
      original,
      [
        reranked(original[2]!, 0.95),
        reranked(original[1]!, 0.9),
        reranked(original[0]!, 0.9),
      ],
    );

    expect(fused.sources[0]?.url).toBe(original[2]?.url);
    expect(fused.top1Protected).toBe(false);
  });

  it("keeps a materially more authoritative near-top rerank winner", () => {
    const aggregator = source("https://reddit.com/r/deepseek");
    const official = source("https://api-docs.deepseek.com/guides/anthropic_api");
    const original = [
      aggregator,
      source("https://example.com/b"),
      source("https://example.com/c"),
      source("https://example.com/d"),
      official,
    ];
    const rerankedSources = [
      reranked(official, 0.9),
      reranked(aggregator, 0.9),
      ...original.slice(1, 4).map((item) => reranked(item, 0.9)),
    ];
    const fused = fuseRankings("DeepSeek official API documentation", original, rerankedSources);

    expect(fused.sources[0]?.url).toBe(official.url);
    expect(fused.top1Protected).toBe(false);
  });

  it("honors a configured top-1 floor", () => {
    const originalTop = source("https://example.com/original-top");
    const second = source("https://example.com/second");
    const official = source("https://docs.searxng.org/guide");
    const original = [originalTop, second, official];
    const rerankSources = [
      reranked(second, 0.8),
      reranked(originalTop, 0.8),
      reranked(official, 0.8),
    ];

    const defaultFloor = fuseRankings("SearXNG official documentation", original, rerankSources);
    expect(defaultFloor.sources[0]?.url).toBe(official.url);
    expect(defaultFloor.top1Protected).toBe(false);

    const lowered = fuseRankings(
      "SearXNG official documentation",
      original,
      rerankSources,
      { top1Min: 0.75 },
    );
    expect(lowered.sources[0]?.url).toBe(originalTop.url);
    expect(lowered.top1Protected).toBe(true);
  });

  it("zeroes low-confidence rerank contributions so noise cannot win by rank alone", () => {
    const original = [
      source("https://example.com/original-top"),
      source("https://example.com/noise"),
      source("https://example.com/relevant"),
    ];
    const fused = fuseRankings(
      "test query",
      original,
      [
        reranked(original[1]!, 0),
        reranked(original[0]!, RERANK_CONFIDENCE_FLOOR),
        reranked(original[2]!, 0.9),
      ],
    );

    expect(fused.sources[0]?.url).toBe(original[2]?.url);
    expect(fused.sources[1]?.rerankConfidence).toBe(0);
    expect(fused.top1Protected).toBe(false);
  });

  it("disables rerank evidence entirely for a weak min-max signal", () => {
    const original = [
      source("https://example.com/a"),
      source("https://example.com/b"),
      source("https://example.com/c"),
    ];
    const fused = fuseRankings(
      "test query",
      original,
      [
        reranked(original[1]!, 0.015),
        reranked(original[2]!, 0.018),
        reranked(original[0]!, 0.02),
      ],
      { rerankModel: NEW_MODEL, rerankNormalization: "auto" },
    );

    expect(fused.sources.map((item) => item.url)).toEqual(original.map((item) => item.url));
    expect(fused.top1Protected).toBe(false);
    expect(fused.calibration?.signalQuality).toBe("weak");
    expect(fused.calibration?.applied).toBe(false);
    expect(fused.calibration?.scores).toEqual([0, 0, 0]);
    expect(fused.sources.every((item) => item.rerankConfidence === 0)).toBe(true);
  });

  it("recovers rerank ordering from compressed scores with min-max calibration", () => {
    const original = [
      source("https://example.com/a"),
      source("https://example.com/b"),
      source("https://example.com/c"),
    ];
    const fused = fuseRankings(
      "test query",
      original,
      [
        reranked(original[2]!, 0.262),
        reranked(original[1]!, 0.14),
        reranked(original[0]!, 0.015),
      ],
      { rerankModel: NEW_MODEL, rerankNormalization: "auto" },
    );

    expect(fused.sources.map((item) => item.url)).toEqual([
      original[2]?.url,
      original[1]?.url,
      original[0]?.url,
    ]);
    expect(fused.calibration?.mode).toBe("minmax");
    expect(fused.calibration?.applied).toBe(true);
    expect(fused.calibration?.signalQuality).toBe("strong");
    expect(fused.calibration?.rawMin).toBeCloseTo(0.015, 10);
    expect(fused.calibration?.rawMax).toBeCloseTo(0.262, 10);
    expect(fused.calibration?.spread).toBeCloseTo(0.247, 10);
    const calibrated = fused.calibration?.scores ?? [];
    expect(calibrated[0]).toBe(1);
    expect(calibrated[1]).toBeCloseTo(0.125 / 0.247, 10);
    expect(calibrated[2]).toBe(0);
  });

  it("maps calibrated scores by canonical URL", () => {
    const original = [
      source("https://example.com/a?utm_source=newsletter"),
      source("https://example.com/b"),
    ];
    const fused = fuseRankings(
      "test query",
      original,
      [
        reranked(source("https://example.com/b"), 0.9),
        reranked(source("https://example.com/a"), 0.9),
      ],
    );

    const top = fused.sources.find((item) => item.url.includes("/a"));
    expect(top?.rerankConfidence).toBeCloseTo((0.9 - RERANK_CONFIDENCE_FLOOR) / (1 - RERANK_CONFIDENCE_FLOOR), 10);
  });

  it("lets an explicit officialIntent override the query detection", () => {
    const low = source("https://example.com/low");
    const other = source("https://example.com/other");
    const docs = source("https://docs.searxng.org/guide");
    const original = [low, other, docs];
    const rerankSources = [
      reranked(low, 0.9),
      reranked(docs, 0.9),
      reranked(other, 0.9),
    ];

    const detected = fuseRankings("searxng query", original, rerankSources);
    expect(detected.officialIntent).toBe(false);
    expect(detected.sources[0]?.url).toBe(low.url);

    const overridden = fuseRankings("searxng query", original, rerankSources, {
      officialIntent: true,
    });
    expect(overridden.officialIntent).toBe(true);
    expect(overridden.sources[0]?.url).toBe(docs.url);
  });

  it("applies a custom confidence floor", () => {
    const original = [source("https://example.com/a"), source("https://example.com/b")];
    const fused = fuseRankings(
      "test query",
      original,
      [reranked(original[1]!, 0.5), reranked(original[0]!, 0.5)],
      { confidenceFloor: 0.6 },
    );
    expect(fused.sources.every((item) => item.rerankConfidence === 0)).toBe(true);
    expect(fused.top1Protected).toBe(false);
  });

  it("normalizes rerank confidence and clamps invalid scores", () => {
    expect(RERANK_CONFIDENCE_FLOOR).toBe(0.35);
    expect(RERANK_TOP1_MIN).toBe(0.85);
    expect(rerankConfidence(undefined)).toBe(0);
    expect(rerankConfidence(Number.NaN)).toBe(0);
    expect(rerankConfidence(-1)).toBe(0);
    expect(rerankConfidence(RERANK_CONFIDENCE_FLOOR)).toBe(0);
    expect(rerankConfidence(1)).toBe(1);
    expect(rerankConfidence(2)).toBe(1);
    expect(rerankConfidence(0.675)).toBeCloseTo(0.5, 10);
    expect(rerankConfidence(0.675, 0.5)).toBeCloseTo(0.35, 10);
    expect(rerankConfidence(0.5, 0.5)).toBe(0);
    expect(rerankConfidence(0.9, Number.NaN)).toBeCloseTo(0.8461538461538461, 10);
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
