import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { ProviderError } from "../src/errors.js";
import { OpenRouterReranker } from "../src/providers/openrouter-rerank.js";
import { SearchService } from "../src/service.js";
import type {
  Reranker,
  SearchProvider,
  SearchProviderId,
  SearchSource,
} from "../src/types.js";

function provider(id: SearchProviderId, url: string): SearchProvider {
  return {
    id,
    async search() {
      return {
        provider: id,
        sources: [{ url, provider: id, title: id }],
        warnings: [],
      };
    },
  };
}

const providers = {
  anysearch: provider("anysearch", "https://anysearch.example.com/result"),
  tavily: provider("tavily", "https://tavily.example.com/result"),
  searxng: provider("searxng", "https://searxng.example.com/result"),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouter reranker", () => {
  it("reorders documents by relevance score", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model: "nvidia/llama-nemotron-rerank-vl-1b-v2",
      results: [
        { index: 1, relevance_score: 0.95 },
        { index: 0, relevance_score: 0.1 },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const reranker = new OpenRouterReranker(loadConfig({ OPENROUTER_API_KEY: "test-key" }));
    const sources: SearchSource[] = [
      { url: "https://example.com/a", provider: "tavily", snippet: "A" },
      { url: "https://example.com/b", provider: "searxng", snippet: "B" },
    ];
    const result = await reranker.rerank("query", sources, 2);
    expect(result.sources[0]?.url).toBe("https://example.com/b");
    expect(result.sources[0]?.rerankScore).toBe(0.95);
  });
});

describe("optional rerank mode", () => {
  it("fans out across providers and applies reranking", async () => {
    const reranker: Reranker = {
      id: "openrouter-rerank",
      async rerank(_query, sources, maxResults) {
        return {
          sources: [
            { ...sources[2]!, rerankScore: 0.99 },
            { ...sources[0]!, rerankScore: 0.5 },
          ].slice(0, maxResults),
          model: "test-reranker",
          elapsedMs: 10,
          inputCount: sources.length,
        };
      },
      async health() {
        return 2;
      },
    };
    const service = new SearchService(loadConfig({}), providers, undefined, reranker);
    const result = await service.webSearch({
      query: "DeepSeek search",
      scope: "global",
      maxResults: 2,
      freshness: "any",
      rerank: true,
    });

    expect(result.provider).toBe("multiple");
    expect(result.mode).toBe("reranked");
    expect(result.rerank?.applied).toBe(true);
    expect(result.sources[0]?.url).toBe("https://anysearch.example.com/result");
  });

  it("falls back to provider order when reranking fails", async () => {
    const reranker: Reranker = {
      id: "openrouter-rerank",
      async rerank() {
        throw new ProviderError("openrouter-rerank", "rate_limited", "rate limited");
      },
      async health() {
        return 0;
      },
    };
    const service = new SearchService(loadConfig({}), providers, undefined, reranker);
    const result = await service.webSearch({
      query: "DeepSeek search",
      scope: "global",
      maxResults: 2,
      freshness: "any",
      rerank: true,
    });

    expect(result.rerank?.applied).toBe(false);
    expect(result.rerank?.reason).toContain("rate limited");
    expect(result.sources[0]?.provider).toBe("tavily");
  });
});
