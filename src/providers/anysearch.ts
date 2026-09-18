import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AppConfig } from "../config.js";
import { ProviderError, errorText, normalizeProviderError } from "../errors.js";
import type { ProviderResult, SearchInput, SearchProvider, SearchSource } from "../types.js";
import { dedupeSources, normalizeWhitespace, withTimeout } from "../utils.js";

export function parseAnySearchMarkdown(markdown: string): SearchSource[] {
  const lines = markdown.split(/\r?\n/);
  const sources: SearchSource[] = [];
  let title: string | undefined;
  let url: string | undefined;
  let snippetLines: string[] = [];

  const flush = (): void => {
    if (url !== undefined && url.length > 0) {
      const snippet = normalizeWhitespace(snippetLines.join(" "));
      sources.push({
        url,
        provider: "anysearch",
        ...(title === undefined || title.length === 0 ? {} : { title }),
        ...(snippet.length === 0 ? {} : { snippet }),
      });
    }
    title = undefined;
    url = undefined;
    snippetLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = /^###\s+\d+\.\s+(.+)$/u.exec(line);
    if (heading !== null) {
      flush();
      title = normalizeWhitespace(heading[1] ?? "");
      continue;
    }
    const urlLine = /^-\s+\*\*URL\*\*:\s*(https?:\/\/\S+)$/iu.exec(line);
    if (urlLine !== null) {
      url = urlLine[1];
      continue;
    }
    if (url !== undefined && line.length > 0 && !line.startsWith("## ")) {
      snippetLines.push(line);
    }
  }
  flush();
  return dedupeSources(sources);
}

export class AnySearchProvider implements SearchProvider {
  readonly id = "anysearch" as const;

  constructor(private readonly config: AppConfig) {}

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderResult> {
    const headers: Record<string, string> = {
      "X-Anysearch-Client": "deepseek-web-search-mcp/1.0.0",
    };
    if (this.config.anySearchApiKey !== undefined) {
      headers.Authorization = `Bearer ${this.config.anySearchApiKey}`;
    }

    try {
      return await withTimeout(
        async (requestSignal) => {
          const transport = new StreamableHTTPClientTransport(new URL(this.config.anySearchMcpUrl), {
            requestInit: { headers },
          });
          const client = new Client({
            name: "deepseek-web-search-mcp",
            version: "1.0.0",
          });
          try {
            await client.connect(transport as never);
            const response = await client.callTool(
              {
                name: "search",
                arguments: {
                  query: input.query,
                  max_results: input.maxResults,
                },
              },
              undefined,
              { signal: requestSignal, timeout: this.config.anySearchTimeoutMs },
            ) as {
              isError?: boolean;
              content?: Array<{ type: string; text?: string }>;
            };
            if (response.isError === true) {
              throw new ProviderError(this.id, "invalid_response", "AnySearch returned an MCP tool error");
            }
            const text = (response.content ?? [])
              .filter((item) => item.type === "text")
              .map((item) => item.text ?? "")
              .join("\n");
            const sources = parseAnySearchMarkdown(text);
            return {
              provider: this.id,
              sources,
              warnings: [],
            };
          } finally {
            await client.close().catch(() => undefined);
          }
        },
        this.config.anySearchTimeoutMs,
        "AnySearch request",
        signal,
      );
    } catch (error) {
      throw normalizeProviderError(this.id, new Error(errorText(error)));
    }
  }
}
