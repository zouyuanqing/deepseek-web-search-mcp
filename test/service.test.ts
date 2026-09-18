import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ProviderError } from "../src/errors.js";
import { SearchService, providerOrder } from "../src/service.js";
import type {
  DeepSeekNativeProvider,
  SearchProvider,
  SearchProviderId,
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

describe("provider routing", () => {
  it("uses the Chinese-first order", () => {
    expect(providerOrder("cn")).toEqual(["anysearch", "searxng", "tavily"]);
  });

  it("uses the global-first order", () => {
    expect(providerOrder("global")).toEqual(["tavily", "searxng", "anysearch"]);
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
