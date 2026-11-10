import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  buildDeepSeekSearchQuery,
  DeepSeekSearchProvider,
  mapDeepSeekSearchResults,
} from "../src/providers/deepseek-search.js";

const NOW = new Date("2026-11-10T00:00:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function searchConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_SEARCH_API_BASE_URL: "https://api.deepseek.com/v1",
    DEEPSEEK_SEARCH_API_TIMEOUT_MS: "5000",
    ...overrides,
  });
}

const input = {
  query: "DeepSeek V4 release",
  scope: "global" as const,
  maxResults: 7,
  freshness: "any" as const,
  quality: "fast" as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("official DeepSeek Search API query building", () => {
  it("passes an unfiltered query through unchanged", () => {
    expect(buildDeepSeekSearchQuery("DeepSeek V4", "any", NOW)).toEqual({
      query: "DeepSeek V4",
      warnings: [],
    });
  });

  it("maps freshness to the server-side after: operator", () => {
    const built = buildDeepSeekSearchQuery("DeepSeek V4", "week", NOW);
    expect(built.query).toBe("DeepSeek V4 after:2026-11-03");
    expect(built.warnings).toEqual([]);
  });

  it("truncates by Unicode code points without splitting surrogate pairs", () => {
    const emojiQuery = "😀".repeat(200);
    const unfiltered = buildDeepSeekSearchQuery(emojiQuery, "any", NOW);
    expect(Array.from(unfiltered.query)).toHaveLength(128);
    expect(unfiltered.query.isWellFormed()).toBe(true);

    const filtered = buildDeepSeekSearchQuery(emojiQuery, "week", NOW);
    expect(Array.from(filtered.query).length).toBeLessThanOrEqual(128);
    expect(filtered.query.isWellFormed()).toBe(true);
    expect(filtered.query.endsWith("after:2026-11-03")).toBe(true);
  });

  it("truncates a query to the 128-character API limit and reports it", () => {
    const longQuery = "a".repeat(200);
    const built = buildDeepSeekSearchQuery(longQuery, "any", NOW);
    expect(built.query).toHaveLength(128);
    expect(built.warnings[0]).toContain("truncated");

    const filtered = buildDeepSeekSearchQuery(longQuery, "month", NOW);
    expect(filtered.query.length).toBeLessThanOrEqual(128);
    expect(filtered.query.endsWith("after:2026-10-11")).toBe(true);
    expect(filtered.warnings[0]).toContain("freshness operator");
  });
});

describe("official DeepSeek Search API result mapping", () => {
  it("maps structured results, snippet fallbacks, dates, scores, and authority", () => {
    const sources = mapDeepSeekSearchResults([
      {
        rerank_score: 2.4,
        title: "DeepSeek V4 released",
        url: "https://example.com/deepseek-v4",
        snippet: "A short snippet.",
        summary: "A long summary.",
        content: "# Heading\n\nFull page body.",
        date: "2026-06-01T00:00:00+00:00",
        authority: 3,
      },
      {
        title: "",
        url: "https://example.com/fallback",
        snippet: "",
        summary: "Fallback summary.",
        date: null,
        authority: -1,
      },
      { title: "missing url" },
      "not an object",
    ]);

    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      url: "https://example.com/deepseek-v4",
      provider: "deepseek-search",
      title: "DeepSeek V4 released",
      snippet: "A short snippet.",
      publishedAt: "2026-06-01T00:00:00+00:00",
      score: 2.4,
      authorityTier: 3,
      content: "# Heading\n\nFull page body.",
    });
    expect(sources[1]).toMatchObject({
      url: "https://example.com/fallback",
      snippet: "Fallback summary.",
      authorityTier: -1,
    });
    expect(sources[1]?.title).toBeUndefined();
    expect(sources[1]?.publishedAt).toBeUndefined();
  });
});

describe("official DeepSeek Search API provider", () => {
  it("calls POST /v1/tools/search with bearer auth and the mapped result count", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      results: [{
        title: "Result",
        url: "https://example.com/result",
        snippet: "Snippet",
        date: "2026-06-01T00:00:00+00:00",
        authority: 3,
        rerank_score: 1.9,
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new DeepSeekSearchProvider(searchConfig());
    const result = await provider.search(input);

    expect(result.provider).toBe("deepseek-search");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      url: "https://example.com/result",
      provider: "deepseek-search",
      publishedAt: "2026-06-01T00:00:00+00:00",
    });

    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe("https://api.deepseek.com/v1/tools/search");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(init.body))).toEqual({
      query: "DeepSeek V4 release",
      count: 7,
      need_content: false,
    });
  });

  it("omits need_content unless enabled in configuration", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DeepSeekSearchProvider(searchConfig({ DEEPSEEK_SEARCH_NEED_CONTENT: "on" }));
    await provider.search(input);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body)).need_content).toBe(true);
  });

  it("reports an empty result array as empty rather than failing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ results: [] })));
    const provider = new DeepSeekSearchProvider(searchConfig());
    const result = await provider.search(input);
    expect(result.sources).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects a whitespace-only query before calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DeepSeekSearchProvider(searchConfig());
    await expect(provider.search({ ...input, query: "   " })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps HTTP 504 to a retryable timeout error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(
      { error: { message: "downstream request timed out" } },
      504,
    )));
    const provider = new DeepSeekSearchProvider(searchConfig());
    await expect(provider.search(input)).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
      status: 504,
    });
  });

  it("requires DEEPSEEK_API_KEY", async () => {
    const provider = new DeepSeekSearchProvider(loadConfig({}));
    await expect(provider.search(input)).rejects.toMatchObject({
      code: "missing_credential",
      provider: "deepseek-search",
    });
  });

  it("maps HTTP 429 to a retryable rate_limited error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(
      { error: { message: "Search QPS limit exceeded", type: "rate_limit_error" } },
      429,
    )));
    const provider = new DeepSeekSearchProvider(searchConfig());
    await expect(provider.search(input)).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
      status: 429,
    });
  });

  it("maps HTTP 402 to insufficient_balance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(
      { error: { message: "Insufficient balance" } },
      402,
    )));
    const provider = new DeepSeekSearchProvider(searchConfig());
    await expect(provider.search(input)).rejects.toMatchObject({
      code: "insufficient_balance",
      status: 402,
    });
  });

  it("maps HTTP 400 to invalid_request without retrying", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(
      { error: { message: "'count' must be between 1 and 50" } },
      400,
    )));
    const provider = new DeepSeekSearchProvider(searchConfig());
    await expect(provider.search(input)).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
    });
  });

  it("rejects a non-JSON response body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    const provider = new DeepSeekSearchProvider(searchConfig());
    await expect(provider.search(input)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects a response without a results array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
    const provider = new DeepSeekSearchProvider(searchConfig());
    await expect(provider.search(input)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("maps a network failure to network_error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const provider = new DeepSeekSearchProvider(searchConfig());
    await expect(provider.search(input)).rejects.toMatchObject({
      code: "network_error",
      retryable: true,
    });
  });
});
