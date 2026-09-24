import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { errorText } from "./errors.js";
import { SearchService } from "./service.js";
import type { ResearchResult, SearchResult } from "./types.js";
import { safeJson } from "./utils.js";

const scopeSchema = z.enum(["auto", "cn", "global"]).default("auto");
const freshnessSchema = z.enum(["any", "day", "week", "month", "year"]).default("any");
const qualitySchema = z.enum(["fast", "balanced", "deep"]);
const backendSchema = z.enum(["auto", "external", "deepseek-native"]);

export function searchMarkdown(result: SearchResult): string {
  const lines = [
    `Search provider: ${result.provider ?? "none"}`,
    `Search backend: ${result.backend}`,
    `Scope: ${result.scope}`,
    `Mode: ${result.mode}`,
    `Quality: ${result.quality}`,
    `Fallback used: ${result.fallbackUsed ? "yes" : "no"}`,
    "",
  ];
  if (result.rerank?.requested === true) {
    lines.push(
      `Rerank: ${result.rerank.applied ? "applied" : "not applied"}`
      + `${result.rerank.model === undefined ? "" : ` (${result.rerank.model})`}`,
      ...(result.rerank.strategy === undefined
        ? []
        : [`Rank fusion: ${result.rerank.strategy}`]),
      ...(result.rerank.reason === undefined ? [] : [`Rerank detail: ${result.rerank.reason}`]),
      "",
    );
  }
  if (result.answer !== undefined && result.answer.length > 0) {
    lines.push(result.answer, "");
  }
  result.sources.forEach((source, index) => {
    const title = source.title ?? source.url;
    lines.push(`${index + 1}. [${title}](${source.url})`);
    if (source.snippet !== undefined && source.snippet.length > 0) {
      lines.push(`   ${source.snippet}`);
    }
    if (source.publishedAt !== undefined) lines.push(`   Published: ${source.publishedAt}`);
  });
  if (result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }
  if (result.nativeSearchRequests !== undefined) {
    lines.push(
      `Native search requests: ${result.nativeSearchRequests}`,
      `Native search degraded: ${result.nativeSearchDegraded === true ? "yes" : "no"}`,
    );
  }
  return lines.join("\n");
}

export function researchMarkdown(result: ResearchResult): string {
  const lines: string[] = [];
  if (result.answerMarkdown.length > 0) lines.push(result.answerMarkdown, "");
  lines.push("## Sources");
  result.sources.forEach((source, index) => {
    lines.push(`${index + 1}. [${source.title ?? source.url}](${source.url})`);
    if (source.snippet !== undefined && source.snippet.length > 0) {
      lines.push(`   ${source.snippet}`);
    }
  });
  if (result.degraded) lines.push("", "> DeepSeek native search was unavailable; these are fallback sources.");
  if (result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}

export function createMcpServer(config: AppConfig): McpServer {
  const service = new SearchService(config);
  const server = new McpServer({
    name: "deepseek-web-search-mcp",
    version: "1.2.0",
  });

  server.registerTool(
    "web_search",
    {
      title: "Web Search",
      description:
        "Search the live web and return normalized, citeable sources with optional rank fusion.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        query: z.string().min(1).max(400),
        scope: scopeSchema,
        max_results: z.number().int().min(1).max(20).default(8),
        freshness: freshnessSchema,
        quality: qualitySchema.optional().describe(
          "Search quality. Defaults to fast; balanced/deep enable rank fusion.",
        ),
        rerank: z.boolean().optional().describe(
          "Deprecated compatibility alias: true maps to balanced when quality is omitted.",
        ),
        backend: backendSchema.optional().describe(
          "Search backend. Defaults to WEB_SEARCH_BACKEND (external by default); deepseek-native uses DeepSeek's native search and auto falls back to external providers.",
        ),
      },
    },
    async ({ query, scope, max_results, freshness, quality, rerank, backend }) => {
      try {
        const result = await service.webSearch({
          query,
          scope,
          maxResults: max_results,
          freshness,
          ...(quality === undefined ? {} : { quality }),
          ...(rerank === undefined ? {} : { rerank }),
          ...(backend === undefined ? {} : { backend }),
        });
        return {
          content: [{ type: "text", text: searchMarkdown(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: errorText(error) }],
        };
      }
    },
  );

  server.registerTool(
    "web_research",
    {
      title: "Web Research",
      description: "Use DeepSeek native web search to research a question and return citeable sources.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        query: z.string().min(1).max(400),
        max_sources: z.number().int().min(1).max(20).default(5),
        freshness: freshnessSchema,
      },
    },
    async ({ query, max_sources, freshness }) => {
      try {
        const result = await service.webResearch({
          query,
          maxSources: max_sources,
          freshness,
        });
        return {
          content: [{ type: "text", text: researchMarkdown(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: errorText(error) }],
        };
      }
    },
  );

  return server;
}

export async function runStdioServer(config: AppConfig): Promise<void> {
  const server = createMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (config.deepseekApiKey === undefined) {
    process.stderr.write("Warning: DEEPSEEK_API_KEY is not configured for web_research.\\n");
  }
}

export async function printHealth(config: AppConfig): Promise<void> {
  const service = new SearchService(config);
  const report = await service.health();
  process.stdout.write(`${safeJson(report)}\n`);
}
