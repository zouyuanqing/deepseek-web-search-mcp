import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { ProviderError } from "../src/errors.js";
import { OpenRouterClient } from "../src/providers/openrouter-client.js";
import { OpenRouterReranker } from "../src/providers/openrouter-rerank.js";
import { SearchService, type ProviderRegistry } from "../src/service.js";
import type {
  Reranker,
  SearchProvider,
  SearchProviderId,
  SearchSource,
} from "../src/types.js";

const API_KEY = "test-key";
const NEW_MODEL = "nvidia/nemotron-3.5-rerank-8b:free";
const OLD_MODEL = "nvidia/llama-nemotron-rerank-vl-1b-v2:free";

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
          rerankScore: reverse ? 0.9 : 1 - index / Math.max(sources.length, 1),
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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function probeSources(): SearchSource[] {
  return [
    { url: "https://example.com/a", provider: "tavily", title: "A", snippet: "alpha" },
    { url: "https://example.com/b", provider: "searxng", title: "B", snippet: "beta" },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OpenRouter reranker", () => {
  it("posts model, query, documents and top_n and returns ranked sources with usage", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return jsonResponse({
        model: "nvidia/nemotron-3.5-rerank-8b",
        results: [
          { index: 0, relevance_score: 0.1 },
          { index: 1, relevance_score: 0.95 },
        ],
        usage: { total_tokens: 42 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const rerankerClient = new OpenRouterReranker(
      loadConfig({ OPENROUTER_API_KEY: API_KEY }),
    );
    const result = await rerankerClient.rerank("a query", probeSources());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/rerank");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      `Bearer ${API_KEY}`,
    );
    const body = JSON.parse(String(requests[0]?.init?.body)) as {
      model?: string;
      query?: string;
      top_n?: number;
      documents?: Array<{ text: string }>;
    };
    expect(body.model).toBe(NEW_MODEL);
    expect(body.query).toBe("a query");
    expect(body.top_n).toBe(2);
    expect(body.documents).toHaveLength(2);
    expect(body.documents?.[0]?.text).toContain("https://example.com/a");

    expect(result.sources.map((source) => source.url)).toEqual([
      "https://example.com/b",
      "https://example.com/a",
    ]);
    expect(result.sources[0]?.rerankScore).toBe(0.95);
    expect(result.model).toBe("nvidia/nemotron-3.5-rerank-8b");
    expect(result.inputCount).toBe(2);
    expect(result.usage).toEqual({ total_tokens: 42 });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("accepts a per-call model override", async () => {
    const models: Array<string | undefined> = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model?: string };
      models.push(body.model);
      return jsonResponse({
        model: body.model,
        results: [
          { index: 0, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.1 },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rerankerClient = new OpenRouterReranker(
      loadConfig({ OPENROUTER_API_KEY: API_KEY }),
    );

    const result = await rerankerClient.rerank("query", probeSources(), undefined, {
      model: OLD_MODEL,
    });

    expect(models).toEqual([OLD_MODEL]);
    expect(result.model).toBe(OLD_MODEL);
    expect(result.usage).toBeUndefined();
  });

  it("passes the model profile timeout and circuit options to the shared client", async () => {
    const config = loadConfig({ OPENROUTER_API_KEY: API_KEY });
    const client = new OpenRouterClient(config);
    const postSpy = vi.spyOn(client, "post").mockImplementation(async (
      _provider,
      _path,
      body,
    ) => ({
      data: {
        model: (body as { model?: string }).model,
        results: [
          { index: 0, relevance_score: 0.2 },
          { index: 1, relevance_score: 0.8 },
        ],
      },
      status: 200,
      elapsedMs: 1,
    }));
    const rerankerClient = new OpenRouterReranker(config, client);

    await rerankerClient.rerank("query", probeSources());
    const newModelOptions = postSpy.mock.calls[0]?.[3];
    expect(newModelOptions?.timeoutMs).toBe(12_000);
    expect(newModelOptions?.circuitFailures).toBe(3);
    expect(newModelOptions?.circuitCooldownMs).toBe(60_000);

    await rerankerClient.rerank("query", probeSources(), undefined, { model: OLD_MODEL });
    expect(postSpy.mock.calls[1]?.[3]?.timeoutMs).toBe(5_000);
  });

  it("retries once with the fallback model when the primary model is unavailable", async () => {
    const models: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model?: string };
      models.push(body.model ?? "");
      if (models.length === 1) {
        return jsonResponse({ error: { message: "No endpoints found for model" } }, 404);
      }
      return jsonResponse({
        model: OLD_MODEL,
        results: [
          { index: 1, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.1 },
        ],
        usage: { total_tokens: 7 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rerankerClient = new OpenRouterReranker(loadConfig({
      OPENROUTER_API_KEY: API_KEY,
      OPENROUTER_RERANK_FALLBACK_MODEL: OLD_MODEL,
    }));

    const result = await rerankerClient.rerank("query", probeSources());

    expect(models).toEqual([NEW_MODEL, OLD_MODEL]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.sources[0]?.url).toBe("https://example.com/b");
    expect(result.model).toBe(OLD_MODEL);
    expect(result.usage).toEqual({ total_tokens: 7 });
  });

  it("propagates other provider errors without falling back", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { message: "rate limited" } }, 429));
    vi.stubGlobal("fetch", fetchMock);
    const rerankerClient = new OpenRouterReranker(loadConfig({
      OPENROUTER_API_KEY: API_KEY,
      OPENROUTER_RERANK_FALLBACK_MODEL: OLD_MODEL,
    }));

    await expect(rerankerClient.rerank("query", probeSources())).rejects.toMatchObject({
      provider: "openrouter-rerank",
      code: "rate_limited",
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a call after the configured timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rerankerClient = new OpenRouterReranker(loadConfig({
      OPENROUTER_API_KEY: API_KEY,
      OPENROUTER_RERANK_TIMEOUT_MS: "1234",
    }));

    const pending = rerankerClient.rerank("query", probeSources());
    const rejection = expect(pending).rejects.toMatchObject({
      provider: "openrouter-rerank",
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1234);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call the API when there are no documents", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const rerankerClient = new OpenRouterReranker(
      loadConfig({ OPENROUTER_API_KEY: API_KEY }),
    );

    const result = await rerankerClient.rerank("query", []);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.sources).toEqual([]);
    expect(result.model).toBe(NEW_MODEL);
    expect(result.inputCount).toBe(0);
    expect(result.elapsedMs).toBe(0);
  });

  it("rejects without an API key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const rerankerClient = new OpenRouterReranker(loadConfig({}));

    await expect(rerankerClient.rerank("query", probeSources())).rejects.toMatchObject({
      provider: "openrouter-rerank",
      code: "missing_credential",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps health() returning the number of ranked candidates", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { top_n?: number };
      const count = body.top_n ?? 0;
      return jsonResponse({
        results: Array.from({ length: count }, (_value, index) => ({
          index,
          relevance_score: index === 0 ? 0.9 : 0.1,
        })),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rerankerClient = new OpenRouterReranker(
      loadConfig({ OPENROUTER_API_KEY: API_KEY }),
    );

    expect(await rerankerClient.health()).toBe(2);
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
    // The reversed reranker pushed the original top to rank 3, beyond the
    // recalibrated rank-2 protection window, so it is not protected.
    expect(result.rerank?.top1Protected).toBe(false);
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
