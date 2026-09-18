import { tavily } from "@tavily/core";
import type { AppConfig } from "../config.js";
import { ProviderError, errorText, normalizeProviderError } from "../errors.js";
import type {
  Freshness,
  ProviderResult,
  SearchInput,
  SearchProvider,
  SearchSource,
} from "../types.js";
import { dedupeSources, normalizeWhitespace, withTimeout } from "../utils.js";

function timeRange(freshness: Freshness): "day" | "week" | "month" | "year" | undefined {
  return freshness === "any" ? undefined : freshness;
}

export class TavilySearchProvider implements SearchProvider {
  readonly id = "tavily" as const;

  constructor(private readonly config: AppConfig) {}

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderResult> {
    if (this.config.tavilyApiKey === undefined) {
      throw new ProviderError(this.id, "missing_credential", "TAVILY_API_KEY is not configured");
    }
    const client = tavily({ apiKey: this.config.tavilyApiKey });
    try {
      return await withTimeout(
        async () => {
          const response = await client.search(input.query, {
            maxResults: input.maxResults,
            searchDepth: "basic",
            includeAnswer: true,
            topic: input.freshness === "day" ? "news" : "general",
            ...(timeRange(input.freshness) === undefined
              ? {}
              : { timeRange: timeRange(input.freshness) }),
          } as never);
          const sources: SearchSource[] = (response.results ?? []).map((item) => ({
            url: item.url,
            provider: this.id,
            ...(item.title === undefined ? {} : { title: item.title }),
            ...(item.content === undefined ? {} : { snippet: normalizeWhitespace(item.content) }),
            ...(item.publishedDate === undefined ? {} : { publishedAt: item.publishedDate }),
            ...(item.score === undefined ? {} : { score: item.score }),
          }));
          const answer =
            typeof response.answer === "string" && response.answer.trim().length > 0
              ? response.answer.trim()
              : undefined;
          return {
            provider: this.id,
            sources: dedupeSources(sources),
            ...(answer === undefined ? {} : { answer }),
            warnings: [],
          };
        },
        this.config.tavilyTimeoutMs,
        "Tavily request",
        signal,
      );
    } catch (error) {
      throw normalizeProviderError(this.id, new Error(errorText(error)));
    }
  }
}
