import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ProviderError } from "../src/errors.js";
import { hybridProviderOrder, SearchService, providerOrder } from "../src/service.js";
import { ResearchSessionStore } from "../src/research-session.js";
import type { ProviderRegistry } from "../src/service.js";
import type {
  DeepSeekNativeProvider,
  ResearchResult,
  Reranker,
  SearchProvider,
  SearchProviderId,
  SearchSource,
} from "../src/types.js";

function successfulProvider(id: SearchProviderId): SearchProvider {
  return {
    id,
    async search() {
      return {
        provider: id,
        sources: [{ url: `https://${id}.example.com/result`, provider: id }],
        warnings: [],
      };
    },
  };
}

function successfulNative(): DeepSeekNativeProvider & { calls: number } {
  return {
    id: "deepseek-native",
    calls: 0,
    async research(input): Promise<Omit<ResearchResult, "degraded">> {
      this.calls += 1;
      return {
        query: input.query,
        provider: "deepseek-native",
        answerMarkdown: "Native answer with a citation.",
        sources: [{
          url: "https://native.example.com/result",
          title: "Native result",
          provider: "deepseek-native",
        }],
        nativeSearchRequests: 1,
        nativeSearchCalls: [{
          id: "native-call-1",
          type: "server_tool_use",
          query: input.query,
        }],
        warnings: [],
      };
    },
  };
}

describe("provider routing", () => {
  it("uses the Chinese-first order", () => {
    expect(providerOrder("cn")).toEqual(["anysearch", "searxng", "tavily"]);
  });

  it("uses the global-first order", () => {
    expect(providerOrder("global")).toEqual(["tavily", "searxng", "anysearch"]);
  });

  it("appends DeepSeek native search to the external provider order", () => {
    expect(hybridProviderOrder("global")).toEqual([
      "tavily",
      "searxng",
      "anysearch",
      "deepseek-native",
    ]);
  });
});

describe("webResearch fallback", () => {
  it("returns degraded external sources when native search fails", async () => {
    const native: DeepSeekNativeProvider = {
      id: "deepseek-native",
      async research() {
        throw new ProviderError("deepseek-native", "search_not_executed", "no result block");
      },
    };
    const providers = {
      anysearch: successfulProvider("anysearch"),
      tavily: successfulProvider("tavily"),
      searxng: successfulProvider("searxng"),
    };
    const service = new SearchService(loadConfig({}), providers, native);
    const result = await service.webResearch({
      query: "OpenAI MCP documentation",
      maxSources: 3,
      freshness: "any",
    });

    expect(result.degraded).toBe(true);
    expect(result.provider).toBe("deepseek-native");
    expect(result.sources[0]?.provider).toBe("tavily");
    expect(result.warnings[0]).toContain("native search was unavailable");
  });
});

describe("web_search native backend compatibility", () => {
  it("keeps auto external-only when no native credential is configured", async () => {
    const native = successfulNative();
    const service = new SearchService(
      loadConfig({}),
      {
        anysearch: successfulProvider("anysearch"),
        tavily: successfulProvider("tavily"),
        searxng: successfulProvider("searxng"),
      },
      native,
    );

    const result = await service.webSearch({
      query: "auto without native key",
      scope: "global",
      maxResults: 3,
      freshness: "any",
      backend: "auto",
    });

    expect(result.backend).toBe("external");
    expect(result.provider).toBe("tavily");
    expect(native.calls).toBe(0);
  });

  it("uses DeepSeek native search without calling external providers", async () => {
    const native = successfulNative();
    const external = {
      anysearch: {
        id: "anysearch" as const,
        async search() {
          throw new Error("external provider should not be called");
        },
      },
      tavily: {
        id: "tavily" as const,
        async search() {
          throw new Error("external provider should not be called");
        },
      },
      searxng: {
        id: "searxng" as const,
        async search() {
          throw new Error("external provider should not be called");
        },
      },
    };
    const service = new SearchService(
      loadConfig({ DEEPSEEK_API_KEY: "test-key" }),
      external,
      native,
    );

    const result = await service.webSearch({
      query: "native compatibility",
      scope: "global",
      maxResults: 3,
      freshness: "any",
      backend: "deepseek-native",
    });

    expect(native.calls).toBe(1);
    expect(result.backend).toBe("deepseek-native");
    expect(result.mode).toBe("native");
    expect(result.provider).toBe("deepseek-native");
    expect(result.answer).toContain("Native answer");
    expect(result.sources[0]?.provider).toBe("deepseek-native");
    expect(result.nativeSearchRequests).toBe(1);
    expect(result.nativeSearchDegraded).toBe(false);
  });

  it("includes native and external sources in auto mode", async () => {
    const native = successfulNative();
    const service = new SearchService(
      loadConfig({ DEEPSEEK_API_KEY: "test-key" }),
      {
        anysearch: successfulProvider("anysearch"),
        tavily: successfulProvider("tavily"),
        searxng: successfulProvider("searxng"),
      },
      native,
    );

    const result = await service.webSearch({
      query: "auto compatibility",
      scope: "global",
      maxResults: 8,
      freshness: "any",
      backend: "auto",
    });

    expect(result.backend).toBe("hybrid");
    expect(result.provider).toBe("multiple");
    expect(result.sources.some((source) => source.provider === "deepseek-native")).toBe(true);
    expect(result.sources.some((source) => source.provider === "tavily")).toBe(true);
    expect(result.nativeSearchRequests).toBe(1);
    expect(result.nativeSearchDegraded).toBe(false);
    expect(native.calls).toBe(1);
  });

  it("keeps external sources when native search fails in hybrid mode", async () => {
    const native: DeepSeekNativeProvider = {
      id: "deepseek-native",
      async research() {
        throw new ProviderError("deepseek-native", "timeout", "native timeout");
      },
    };
    const service = new SearchService(
      loadConfig({ DEEPSEEK_API_KEY: "test-key" }),
      {
        anysearch: successfulProvider("anysearch"),
        tavily: successfulProvider("tavily"),
        searxng: successfulProvider("searxng"),
      },
      native,
    );

    const result = await service.webSearch({
      query: "auto compatibility",
      scope: "global",
      maxResults: 8,
      freshness: "any",
      backend: "hybrid",
    });

    expect(result.backend).toBe("hybrid");
    expect(result.provider).toBe("multiple");
    expect(result.fallbackUsed).toBe(true);
    expect(result.nativeSearchDegraded).toBe(true);
    expect(result.warnings[0]).toContain("native timeout");
  });

  it("sends native and external candidates through the same reranker", async () => {
    const seen: SearchSource[][] = [];
    const reranker: Reranker = {
      id: "openrouter-rerank",
      async rerank(_query, sources) {
        seen.push(sources);
        return {
          sources: sources.map((source) => ({ ...source, rerankScore: 0.9 })),
          model: "test-reranker",
          elapsedMs: 1,
          inputCount: sources.length,
        };
      },
      async health() {
        return 1;
      },
    };
    const service = new SearchService(
      loadConfig({ DEEPSEEK_API_KEY: "test-key" }),
      {
        anysearch: successfulProvider("anysearch"),
        tavily: successfulProvider("tavily"),
        searxng: successfulProvider("searxng"),
      },
      successfulNative(),
      reranker,
    );

    const result = await service.webSearch({
      query: "hybrid rerank compatibility",
      scope: "global",
      maxResults: 1,
      freshness: "any",
      quality: "balanced",
      backend: "hybrid",
    });

    expect(result.backend).toBe("hybrid");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.some((source) => source.provider === "deepseek-native")).toBe(true);
    expect(seen[0]?.some((source) => source.provider === "tavily")).toBe(true);
  });
});

describe("fast cleaning integration", () => {
  it("can promote an official source without changing the default shadow mode", async () => {
    const providers = {
      anysearch: successfulProvider("anysearch"),
      tavily: {
        id: "tavily" as const,
        async search() {
          return {
            provider: "tavily" as const,
            sources: [
              { url: "https://reddit.com/r/deepseek", provider: "tavily" as const },
              { url: "https://api-docs.deepseek.com/", provider: "tavily" as const, title: "DeepSeek API Docs" },
            ],
            warnings: [],
          };
        },
      },
      searxng: successfulProvider("searxng"),
    };
    const shadow = new SearchService(loadConfig({}), providers, successfulNative());
    const shadowResult = await shadow.webSearch({
      query: "DeepSeek official API documentation",
      scope: "global",
      maxResults: 2,
      freshness: "any",
      backend: "external",
      quality: "fast",
    });
    const on = new SearchService(loadConfig({ FAST_CLEANING_MODE: "on" }), providers, successfulNative());
    const onResult = await on.webSearch({
      query: "DeepSeek official API documentation",
      scope: "global",
      maxResults: 2,
      freshness: "any",
      backend: "external",
      quality: "fast",
    });

    expect(shadowResult.fastCleaning?.applied).toBe(false);
    expect(onResult.fastCleaning?.applied).toBe(true);
    expect(onResult.sources[0]?.url).toBe("https://api-docs.deepseek.com/");
  });

  it("routes official documentation queries away from deep reranking by default", async () => {
    const service = new SearchService(
      loadConfig({ DOCUMENTATION_QUERY_MODE: "fast" }),
      {
        anysearch: successfulProvider("anysearch"),
        tavily: successfulProvider("tavily"),
        searxng: successfulProvider("searxng"),
      },
      successfulNative(),
    );
    const result = await service.webSearch({
      query: "Next.js official API documentation",
      scope: "global",
      maxResults: 3,
      freshness: "any",
      quality: "deep",
      backend: "external",
    });

    expect(result.quality).toBe("fast");
    expect(result.mode).toBe("fast");
    expect(result.rerank).toBeUndefined();
    expect(result.warnings).toContain("Documentation query routed from quality=deep to fast to protect primary documentation results.");
  });
});

describe("research session service", () => {
  it("starts, follows up, and closes a research session", async () => {
    const service = new SearchService(
      loadConfig({ DEEPSEEK_API_KEY: "test-key", RESEARCH_SESSION_MAX_TURNS: "2" }),
      {
        anysearch: successfulProvider("anysearch"),
        tavily: successfulProvider("tavily"),
        searxng: successfulProvider("searxng"),
      },
      successfulNative(),
    );

    const started = await service.researchStart({
      query: "DeepSeek API",
      maxSources: 3,
      freshness: "any",
    });
    const followed = await service.researchFollowup({
      sessionId: started.sessionId,
      question: "What endpoint?",
      maxSources: 3,
      freshness: "any",
    });

    expect(started.turn).toBe(1);
    expect(followed.turn).toBe(2);
    expect(followed.sources.length).toBeGreaterThan(0);
    expect(service.researchClose(started.sessionId).closed).toBe(true);
  });
});

describe("source identity integration", () => {
  const translatedCopies: SearchSource[] = [
    { url: "https://techsy.io/it/deepseek-v4-release-notes", title: "DeepSeek V4 release notes", provider: "tavily" },
    { url: "https://techsy.io/ar/deepseek-v4-release-notes", title: "ملاحظات إصدار V4", provider: "tavily" },
    { url: "https://api-docs.deepseek.com/news/deepseek-v4", title: "DeepSeek V4 official release notes", provider: "tavily" },
  ];

  function identityProviders(): ProviderRegistry {
    return {
      anysearch: { id: "anysearch", async search() { return { provider: "anysearch", sources: [], warnings: [] }; } },
      tavily: { id: "tavily", async search() { return { provider: "tavily", sources: translatedCopies, warnings: [] }; } },
      searxng: { id: "searxng", async search() { throw new Error("unavailable"); } },
    };
  }

  it("collapses translated copies before the reranker sees candidates", async () => {
    const seen: SearchSource[][] = [];
    const reranker: Reranker = {
      id: "openrouter-rerank",
      async rerank(_query, sources) {
        seen.push(sources);
        return {
          sources: sources.map((item) => ({ ...item, rerankScore: 0.9 })),
          model: "test-reranker",
          elapsedMs: 1,
          inputCount: sources.length,
        };
      },
      async health() {
        return 1;
      },
    };
    const service = new SearchService(
      loadConfig({ OPENROUTER_API_KEY: "k" }),
      identityProviders(),
      successfulNative(),
      reranker,
    );
    const result = await service.webSearch({
      query: "DeepSeek V4 benchmark numbers",
      scope: "global",
      maxResults: 1,
      freshness: "any",
      quality: "balanced",
      backend: "external",
    });

    expect(seen[0]?.map((item) => item.url)).toEqual([
      "https://techsy.io/it/deepseek-v4-release-notes",
      "https://api-docs.deepseek.com/news/deepseek-v4",
    ]);
    expect(result.sourceIdentity?.languageVariantCount).toBe(1);
    expect(result.sourceIdentity?.mergedCount).toBe(1);
    expect(result.warnings).toContain("Collapsed 1 translated copy/copies of the same article into one source.");
  });

  it("reports independence limits for content-farm dominated results", async () => {
    const service = new SearchService(
      loadConfig({}),
      {
        anysearch: { id: "anysearch", async search() { return { provider: "anysearch", sources: [], warnings: [] }; } },
        tavily: {
          id: "tavily",
          async search() {
            return {
              provider: "tavily",
              sources: [
                { url: "https://ofox.ai/ai-tool-roundup", title: "AI tool roundup", provider: "tavily" },
                { url: "https://taskade.com/ai-tool-roundup", title: "AI tool roundup", provider: "tavily" },
              ],
              warnings: [],
            };
          },
        },
        searxng: { id: "searxng", async search() { throw new Error("unavailable"); } },
      },
      successfulNative(),
    );
    const result = await service.webSearch({
      query: "ai tool roundup",
      scope: "global",
      maxResults: 5,
      freshness: "any",
      backend: "external",
    });

    expect(result.sourceIdentity?.independence.level).toBe("low");
    expect(result.sourceIdentity?.crossHostCopyCount).toBe(1);
    expect(result.warnings.join(" ")).toMatch(/not independent corroboration/u);
  });

  it("can be turned off with SOURCE_IDENTITY_MODE=off", async () => {
    const service = new SearchService(loadConfig({ SOURCE_IDENTITY_MODE: "off" }), identityProviders(), successfulNative());
    const result = await service.webSearch({
      query: "DeepSeek V4 release notes",
      scope: "global",
      maxResults: 5,
      freshness: "any",
      backend: "external",
    });

    expect(result.sources.map((item) => item.url)).toHaveLength(3);
    expect(result.sourceIdentity?.applied).toBe(false);
  });

  it("keeps one identity when a follow-up returns a translated copy", async () => {
    const store = new ResearchSessionStore(60_000, 4);
    const first = store.start(
      { query: "DeepSeek V4", maxTurns: 3 },
      {
        query: "DeepSeek V4",
        provider: "deepseek-native",
        answerMarkdown: "answer",
        sources: [
          { url: "https://techsy.io/en/deepseek-v4-release-notes", provider: "deepseek-native" },
        ],
        nativeSearchRequests: 1,
        nativeSearchCalls: [],
        warnings: [],
        degraded: false,
      },
    );
    store.append(store.get(first.id), "more", {
      query: "more",
      provider: "deepseek-native",
      answerMarkdown: "answer-2",
      sources: [
        { url: "https://techsy.io/it/deepseek-v4-release-notes", provider: "deepseek-native" },
        { url: "https://api-docs.deepseek.com/news/v4", provider: "deepseek-native" },
      ],
      nativeSearchRequests: 1,
      nativeSearchCalls: [],
      warnings: [],
      degraded: false,
    });

    expect(store.get(first.id).sources.map((item) => item.url)).toEqual([
      "https://techsy.io/en/deepseek-v4-release-notes",
      "https://api-docs.deepseek.com/news/v4",
    ]);
  });
});

describe("freshness intent integration", () => {
  it("recommends strict freshness for a fast-changing query without changing the request", async () => {
    const service = new SearchService(
      loadConfig({}),
      {
        anysearch: { id: "anysearch", async search() { return { provider: "anysearch", sources: [], warnings: [] }; } },
        tavily: {
          id: "tavily",
          async search() {
            return {
              provider: "tavily",
              sources: [{ url: "https://api-docs.deepseek.com/news/v4", provider: "tavily" }],
              warnings: [],
            };
          },
        },
        searxng: { id: "searxng", async search() { throw new Error("unavailable"); } },
      },
      successfulNative(),
    );
    const result = await service.webSearch({
      query: "DeepSeek latest model version",
      scope: "global",
      maxResults: 3,
      freshness: "any",
      backend: "external",
    });

    expect(result.warnings.join(" ")).toMatch(/time-sensitive/u);
    expect(result.warnings.join(" ")).toMatch(/freshness_mode="strict"/u);
    expect(result.freshness?.intent?.timeSensitive).toBe(true);
    expect(result.freshness?.mode).toBe("soft");
  });

  it("does not warn when the caller already used strict with a window", async () => {
    const service = new SearchService(
      loadConfig({}),
      {
        anysearch: { id: "anysearch", async search() { return { provider: "anysearch", sources: [], warnings: [] }; } },
        tavily: {
          id: "tavily",
          async search() {
            return {
              provider: "tavily",
              sources: [
                {
                  url: "https://api-docs.deepseek.com/news/v4",
                  provider: "tavily",
                  publishedAt: new Date().toISOString(),
                },
              ],
              warnings: [],
            };
          },
        },
        searxng: { id: "searxng", async search() { throw new Error("unavailable"); } },
      },
      successfulNative(),
    );
    const result = await service.webSearch({
      query: "DeepSeek latest model version",
      scope: "global",
      maxResults: 3,
      freshness: "month",
      freshnessMode: "strict",
      backend: "external",
    });

    expect(result.warnings.join(" ")).not.toMatch(/time-sensitive/u);
    expect(result.freshness?.status).toBe("verified");
  });
});

describe("freshness report describes the sources actually returned", () => {
  const recent = new Date().toISOString();
  const stale = "2020-01-01T00:00:00.000Z";

  it("does not report unmet when only the dropped provider failed the cutoff", async () => {
    const service = new SearchService(
      loadConfig({}),
      {
        anysearch: {
          id: "anysearch",
          async search() {
            return { provider: "anysearch", sources: [], warnings: [] };
          },
        },
        // Every tavily result is stale, so strict drops all of them.
        tavily: {
          id: "tavily",
          async search() {
            return {
              provider: "tavily",
              sources: [{ url: "https://tavily.example.com/old", provider: "tavily", publishedAt: stale }],
              warnings: [],
            };
          },
        },
        // searxng satisfies the cutoff and is what the caller actually receives.
        searxng: {
          id: "searxng",
          async search() {
            return {
              provider: "searxng",
              sources: [{ url: "https://searxng.example.com/new", provider: "searxng", publishedAt: recent }],
              warnings: [],
            };
          },
        },
      },
      successfulNative(),
    );
    const result = await service.webSearch({
      query: "current release notes",
      scope: "global",
      maxResults: 5,
      freshness: "month",
      freshnessMode: "strict",
      backend: "external",
    });

    expect(result.sources.map((item) => item.url)).toEqual(["https://searxng.example.com/new"]);
    expect(result.freshness?.status).toBe("verified");
    expect(result.freshness?.status).not.toBe("unmet");
  });
});
