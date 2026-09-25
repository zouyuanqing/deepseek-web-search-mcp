import { describe, expect, it } from "vitest";
import {
  analyzeSourceIndependence,
  dedupeSourceIdentities,
  parseSourceUrl,
} from "../src/source-identity.js";
import type { SearchSource } from "../src/types.js";

function source(url: string, extra: Partial<SearchSource> = {}): SearchSource {
  return { url, provider: "deepseek-native", ...extra };
}

describe("URL parsing for source identity", () => {
  it("strips locale path prefixes and locale query parameters", () => {
    expect(parseSourceUrl("https://techsy.io/it/ai-article-slug?lang=it")?.pathKey)
      .toBe("/ai-article-slug");
    expect(parseSourceUrl("https://techsy.io/ar/ai-article-slug")?.pathKey)
      .toBe("/ai-article-slug");
    expect(parseSourceUrl("https://techsy.io/ai-article-slug")?.pathKey)
      .toBe("/ai-article-slug");
  });

  it("does not treat a real path segment as a language prefix", () => {
    expect(parseSourceUrl("https://example.com/it/finance/2026-report")?.pathKey)
      .toBe("/finance/2026-report");
    expect(parseSourceUrl("https://example.com/in/2024")?.pathKey).toBe("/in/2024");
  });

  it("normalizes amp, index, trailing slash, and tracking noise", () => {
    expect(parseSourceUrl("https://example.com/docs/Guide/amp/?utm_source=x")?.pathKey)
      .toBe("/docs/guide");
    expect(parseSourceUrl("https://example.com/docs/guide/index.html")?.pathKey)
      .toBe("/docs/guide");
  });

  it("rejects non-http URLs", () => {
    expect(parseSourceUrl("javascript:void(0)")).toBeNull();
    expect(parseSourceUrl("not-a-url")).toBeNull();
  });
});

describe("same-article dedupe", () => {
  it("collapses the Italian, Arabic, and English copies of one article", () => {
    const result = dedupeSourceIdentities([
      source("https://techsy.io/it/deepseek-release-notes-explained", { title: "DeepSeek release notes explained" }),
      source("https://techsy.io/ar/deepseek-release-notes-explained", { title: "شرح ملاحظات الإصدار" }),
      source("https://techsy.io/en/deepseek-release-notes-explained", { title: "DeepSeek release notes explained" }),
      source("https://api-docs.deepseek.com/news/release", { title: "DeepSeek official release notes" }),
    ]);

    expect(result.sources.map((item) => item.url)).toEqual([
      "https://techsy.io/it/deepseek-release-notes-explained",
      "https://api-docs.deepseek.com/news/release",
    ]);
    expect(result.languageVariantCount).toBe(2);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.reason).toBe("language-variant");
    expect(result.groups[0]?.languageVariants.sort()).toEqual(["ar", "en", "it"]);
  });

  it("keeps the official source when a content-farm copy shares the slug and title", () => {
    const result = dedupeSourceIdentities([
      source("https://ofox.ai/best-ai-tools-2026-roundup", { title: "Best AI Tools 2026 complete roundup" }),
      source("https://techsy.io/best-ai-tools-2026-roundup", { title: "Best AI Tools 2026 complete roundup" }),
      source("https://api-docs.deepseek.com/models", { title: "DeepSeek model list" }),
    ]);

    expect(result.sources.map((item) => item.url)).toEqual([
      "https://ofox.ai/best-ai-tools-2026-roundup",
      "https://api-docs.deepseek.com/models",
    ]);
    expect(result.crossHostCopyCount).toBe(1);
    expect(result.groups[0]?.hosts).toEqual(["ofox.ai", "techsy.io"]);
    expect(result.groups[0]?.reason).toBe("syndicated-copy");
  });

  it("does not merge distinct articles that merely share a short slug", () => {
    const result = dedupeSourceIdentities([
      source("https://a.example.com/news", { title: "Quarterly results" }),
      source("https://b.example.com/news", { title: "Quarterly results" }),
    ]);

    expect(result.sources).toHaveLength(2);
    expect(result.crossHostCopyCount).toBe(0);
  });

  it("backfills missing metadata but never overwrites the retained source", () => {
    const result = dedupeSourceIdentities([
      source("https://techsy.io/en/guide-to-rag", {
        title: "Guide to RAG",
        publishedAt: "2026-09-20T00:00:00.000Z",
      }),
      source("https://techsy.io/ar/guide-to-rag", { snippet: "دليل RAG" }),
    ]);

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.url).toBe("https://techsy.io/en/guide-to-rag");
    expect(result.sources[0]?.title).toBe("Guide to RAG");
    expect(result.sources[0]?.publishedAt).toBe("2026-09-20T00:00:00.000Z");
    expect(result.sources[0]?.snippet).toBe("دليل RAG");
  });

  it("flags conflicting publishedAt values instead of silently choosing one", () => {
    const result = dedupeSourceIdentities([
      source("https://techsy.io/en/version-history", {
        title: "Version history",
        publishedAt: "2026-09-20T00:00:00.000Z",
      }),
      source("https://techsy.io/it/version-history", {
        title: "Cronologia versioni",
        publishedAt: "2025-04-02T00:00:00.000Z",
      }),
    ]);

    expect(result.conflictingDateCount).toBe(1);
    expect(result.groups[0]?.dateConflict).toBe(true);
    expect(result.sources[0]?.publishedAt).toBe("2026-09-20T00:00:00.000Z");
  });

  it("preserves input order and stays deterministic under permutation", () => {
    const sources = [
      source("https://techsy.io/en/a", { title: "A" }),
      source("https://api-docs.deepseek.com/a", { title: "A" }),
      source("https://example.org/b", { title: "B" }),
    ];
    const first = dedupeSourceIdentities(sources).sources.map((item) => item.url);
    const second = dedupeSourceIdentities(sources).sources.map((item) => item.url);
    expect(first).toEqual(second);
    expect(first).toEqual([
      "https://techsy.io/en/a",
      "https://api-docs.deepseek.com/a",
      "https://example.org/b",
    ]);
  });

  it("can be limited to exact identity with cross-host detection off", () => {
    const result = dedupeSourceIdentities(
      [
        source("https://ofox.ai/best-ai-tools-2026-roundup", { title: "Best AI Tools 2026 complete roundup" }),
        source("https://techsy.io/best-ai-tools-2026-roundup", { title: "Best AI Tools 2026 complete roundup" }),
      ],
      { crossHost: false },
    );
    expect(result.sources).toHaveLength(2);
    expect(result.crossHostCopyCount).toBe(0);
  });
});

describe("source independence", () => {
  it("flags a content-farm-dominated result set as low independence", () => {
    const identity = dedupeSourceIdentities([
      source("https://ofox.ai/a", { title: "A" }),
      source("https://techsy.io/b", { title: "B" }),
      source("https://taskade.com/c", { title: "C" }),
    ]);
    const analysis = analyzeSourceIndependence(identity.sources, identity);

    expect(analysis.independence).toBe("low");
    expect(analysis.lowAuthorityShare).toBe(1);
    expect(analysis.notes.join(" ")).toMatch(/aggregators or content farms/u);
  });

  it("treats a single-domain result set as one origin", () => {
    const identity = dedupeSourceIdentities([
      source("https://techsy.io/a", { title: "A" }),
      source("https://techsy.io/b", { title: "B" }),
    ]);
    const analysis = analyzeSourceIndependence(identity.sources, identity);
    expect(analysis.independentDomains).toBe(1);
    expect(analysis.dominantDomain).toBe("techsy.io");
    expect(analysis.independence).toBe("low");
    expect(analysis.notes.join(" ")).toMatch(/single-origin/u);
  });

  it("reports high independence for genuinely distinct primary sources", () => {
    const identity = dedupeSourceIdentities([
      source("https://api-docs.deepseek.com/a"),
      source("https://github.com/deepseek-ai/a"),
      source("https://arxiv.org/abs/1234"),
    ]);
    const analysis = analyzeSourceIndependence(identity.sources, identity);
    expect(analysis.independentDomains).toBe(3);
    expect(analysis.lowAuthoritySources).toBe(0);
    expect(analysis.independence).toBe("high");
    expect(analysis.notes).toHaveLength(0);
  });

  it("warns that cross-host agreement may be copied content", () => {
    const identity = dedupeSourceIdentities([
      source("https://ofox.ai/best-ai-tools-2026-roundup", { title: "Best AI Tools 2026 complete roundup" }),
      source("https://techsy.io/best-ai-tools-2026-roundup", { title: "Best AI Tools 2026 complete roundup" }),
      source("https://api-docs.deepseek.com/models", { title: "DeepSeek models" }),
    ]);
    const analysis = analyzeSourceIndependence(identity.sources, identity);
    expect(analysis.notes.join(" ")).toMatch(/not independent corroboration/u);
  });
});
