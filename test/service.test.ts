import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ProviderError } from "../src/errors.js";
import { SearchService, providerOrder } from "../src/service.js";
import type {
  DeepSeekNativeProvider,
  ResearchResult,
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

  it("falls back to external providers in auto mode when native search fails", async () => {
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
      maxResults: 3,
      freshness: "any",
      backend: "auto",
    });

    expect(result.backend).toBe("external");
    expect(result.provider).toBe("tavily");
    expect(result.fallbackUsed).toBe(true);
    expect(result.nativeSearchDegraded).toBe(true);
    expect(result.warnings[0]).toContain("native timeout");
  });
});
