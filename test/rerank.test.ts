import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { ProviderError } from "../src/errors.js";
import { OpenRouterReranker } from "../src/providers/openrouter-rerank.js";
import { SearchService, type ProviderRegistry } from "../src/service.js";
import type {
  Reranker,
  SearchProvider,
  SearchProviderId,
  SearchSource,
} from "../src/types.js";

function provider(id: SearchProviderId, urls: string[]): SearchProvider {
  return {
    id,
    async search(input) {
      return {
        provider: id,
        sources: urls.slice(0, input.maxResults).map((url) => ({
          url,
          provider: id,
          title: `${id} result`,
        })),
        warnings: [],
      };
    },
  };
}

function providers(sourceCount = 1): ProviderRegistry {
  const urls = (id: SearchProviderId) => Array.from(
    { length: sourceCount },
    (_value, index) => `https://${id}.example.com/${index}`,
  );
  return {
    anysearch: provider("anysearch", urls("anysearch")),
    tavily: provider("tavily", urls("tavily")),
    searxng: provider("searxng", urls("searxng")),
  };
}

function reranker(reverse = false): Reranker & { calls: number } {
  return {
    id: "openrouter-rerank",
    calls: 0,
    async rerank(_query: string, sources: SearchSource[]) {
      this.calls += 1;
      return {
        sources: (reverse ? [...sources].reverse() : sources).map((source, index) => ({
          ...source,
          rerankScore: 1 - index / Math.max(sources.length, 1),
        })),
        model: "test-reranker",
        elapsedMs: 10,
        inputCount: sources.length,
      };
    },
    async health() {
      return 2;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouter reranker", () => {
  it("requests and returns the full candidate ranking", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { top_n?: number };
      expect(body.top_n).toBe(2);
      return new Response(JSON.stringify({
        model: "nvidia/llama-nemotron-rerank-vl-1b-v2",
        results: [
          { index: 0, relevance_score: 0.1 },
          { index: 1, relevance_score: 0.95 },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rerankerClient = new OpenRouterReranker(
      loadConfig({ OPENROUTER_API_KEY: "test-key" }),
    );
    const sources: SearchSource[] = [
      { url: "https://example.com/a", provider: "tavily", snippet: "A" },
      { url: "https://example.com/b", provider: "searxng", snippet: "B" },
    ];
    const result = await rerankerClient.rerank("query", sources);
    expect(result.sources[0]?.url).toBe("https://example.com/b");
    expect(result.sources[0]?.rerankScore).toBe(0.95);
    expect(result.sources).toHaveLength(2);
  });
});

describe("quality modes", () => {
  it("maps the legacy rerank flag to balanced and applies rank fusion", async () => {
    const fakeReranker = reranker(true);
    const service = new SearchService(
      loadConfig({}),
      providers(),
      undefined,
      fakeReranker,
    );
    const result = await service.webSearch({
      query: "DeepSeek search",
      scope: "global",
      maxResults: 2,
      freshness: "any",
      rerank: true,
    });

    expect(result.quality).toBe("balanced");
    expect(result.mode).toBe("reranked");
    expect(result.rerank?.applied).toBe(true);
    expect(result.rerank?.strategy).toBe("rank_fusion");
    expect(result.rerank?.top1Protected).toBe(true);
    expect(result.sources[0]?.provider).toBe("tavily");
    expect(fakeReranker.calls).toBe(1);
  });

  it("lets explicit fast quality override the legacy rerank flag", async () => {
    const fakeReranker = reranker();
    const service = new SearchService(
      loadConfig({}),
      providers(),
      undefined,
      fakeReranker,
    );
    const result = await service.webSearch({
      query: "DeepSeek search",
      scope: "global",
      maxResults: 2,
      freshness: "any",
      quality: "fast",
      rerank: true,
    });

    expect(result.quality).toBe("fast");
    expect(result.mode).toBe("fast");
    expect(result.rerank).toBeUndefined();
    expect(fakeReranker.calls).toBe(0);
  });

  it("requests 10 candidates per provider for balanced and 15 for deep", async () => {
    const limits: Record<string, number[]> = { balanced: [], deep: [] };
    const registry: ProviderRegistry = {
      anysearch: {
        id: "anysearch",
        async search(input) {
          limits[input.quality ?? "fast"]?.push(input.maxResults);
          return {
            provider: "anysearch",
            sources: Array.from({ length: input.maxResults }, (_value, index) => ({
              url: `https://anysearch.example.com/${input.quality}/${index}`,
              provider: "anysearch",
            })),
            warnings: [],
          };
        },
      },
      tavily: provider("tavily", []),
      searxng: provider("searxng", []),
    };
    const service = new SearchService(
      loadConfig({}),
      registry,
      undefined,
      reranker(),
    );

    await service.webSearch({
      query: "query one",
      scope: "global",
      maxResults: 5,
      freshness: "any",
      quality: "balanced",
    });
    await service.webSearch({
      query: "query two",
      scope: "global",
      maxResults: 5,
      freshness: "any",
      quality: "deep",
    });

    expect(limits.balanced).toEqual([10]);
    expect(limits.deep).toEqual([15]);
  });
});

describe("caching and fallback", () => {
  it("caches provider and rerank results between identical searches", async () => {
    const fakeReranker = reranker();
    const registry = providers(8);
    const counts = new Map<SearchProviderId, number>();
    for (const id of Object.keys(registry) as SearchProviderId[]) {
      const original = registry[id];
      registry[id] = {
        id,
        async search(input, signal) {
          counts.set(id, (counts.get(id) ?? 0) + 1);
          return original.search(input, signal);
        },
      };
    }
    const service = new SearchService(
      loadConfig({}),
      registry,
      undefined,
      fakeReranker,
    );
    const input = {
      query: "cached query",
      scope: "global" as const,
      maxResults: 5,
      freshness: "any" as const,
      quality: "balanced" as const,
    };

    const first = await service.webSearch(input);
    const second = await service.webSearch(input);

    expect([...counts.values()]).toEqual([1, 1, 1]);
    expect(fakeReranker.calls).toBe(1);
    expect(first.rerank?.cached).toBeUndefined();
    expect(second.rerank?.cached).toBe(true);
    expect(second.attempts.every((attempt) => attempt.cached === true)).toBe(true);
  });

  it("falls back to provider order and does not cache rerank failures", async () => {
    let calls = 0;
    const failingReranker: Reranker = {
      id: "openrouter-rerank",
      async rerank() {
        calls += 1;
        throw new ProviderError("openrouter-rerank", "rate_limited", "rate limited");
      },
      async health() {
        return 0;
      },
    };
    const service = new SearchService(
      loadConfig({}),
      providers(),
      undefined,
      failingReranker,
    );
    const input = {
      query: "DeepSeek search",
      scope: "global" as const,
      maxResults: 2,
      freshness: "any" as const,
      quality: "balanced" as const,
    };

    const first = await service.webSearch(input);
    const second = await service.webSearch(input);

    expect(calls).toBe(2);
    expect(first.rerank?.applied).toBe(false);
    expect(first.rerank?.reason).toContain("rate limited");
    expect(second.sources[0]?.provider).toBe("tavily");
  });
});
