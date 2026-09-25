import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { SearxngProvider } from "../src/providers/searxng.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SearXNG response normalization", () => {
  it("ignores null optional fields instead of failing normalization", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [{
        url: "https://example.com/result",
        title: null,
        content: null,
        score: null,
        publishedDate: null,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const provider = new SearxngProvider(loadConfig({
      SEARXNG_URL: "https://search.example",
    }));
    const result = await provider.search({
      query: "test",
      scope: "global",
      maxResults: 3,
      freshness: "any",
    });

    expect(result.sources).toEqual([{
      url: "https://example.com/result",
      provider: "searxng",
    }]);
  });
});
