import type { AppConfig } from "../config.js";
import { ProviderError, classifyHttpStatus, errorText, normalizeProviderError } from "../errors.js";
import type {
  Freshness,
  ProviderResult,
  SearchInput,
  SearchProvider,
  SearchSource,
} from "../types.js";
import { dedupeSources, normalizeWhitespace, withTimeout } from "../utils.js";

interface SearxngResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
    publishedDate?: string;
    engine?: string;
  }>;
}

function timeRange(freshness: Freshness): string | undefined {
  return freshness === "any" ? undefined : freshness;
}

export class SearxngProvider implements SearchProvider {
  readonly id = "searxng" as const;

  constructor(private readonly config: AppConfig) {}

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderResult> {
    if (this.config.searxngUrl === undefined) {
      throw new ProviderError(this.id, "missing_credential", "SEARXNG_URL is not configured");
    }
    const url = new URL("/search", this.config.searxngUrl);
    url.searchParams.set("q", input.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", this.config.searxngLanguage);
    url.searchParams.set("safesearch", "1");
    const range = timeRange(input.freshness);
    if (range !== undefined) url.searchParams.set("time_range", range);

    try {
      return await withTimeout(
        async (requestSignal) => {
          const response = await fetch(url, {
            headers: { accept: "application/json" },
            signal: requestSignal,
          });
          if (!response.ok) {
            throw new ProviderError(
              this.id,
              classifyHttpStatus(response.status),
              `SearXNG returned HTTP ${response.status}`,
              { status: response.status, retryable: response.status === 429 || response.status >= 500 },
            );
          }
          const payload = (await response.json()) as SearxngResponse;
          const sources: SearchSource[] = (payload.results ?? [])
            .filter((item): item is typeof item & { url: string } => typeof item.url === "string")
            .map((item) => ({
              url: item.url,
              provider: this.id,
              ...(item.title === undefined ? {} : { title: item.title }),
              ...(item.content === undefined
                ? {}
                : { snippet: normalizeWhitespace(item.content) }),
              ...(item.score === undefined ? {} : { score: item.score }),
              ...(item.publishedDate === undefined ? {} : { publishedAt: item.publishedDate }),
            }));
          return {
            provider: this.id,
            sources: dedupeSources(sources),
            warnings: [],
          };
        },
        this.config.searxngTimeoutMs,
        "SearXNG request",
        signal,
      );
    } catch (error) {
      throw normalizeProviderError(this.id, new Error(errorText(error)));
    }
  }
}
