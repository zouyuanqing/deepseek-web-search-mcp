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
const freshnessModeSchema = z.enum(["soft", "strict"]).default("soft");
const qualitySchema = z.enum(["fast", "balanced", "deep"]);
const backendSchema = z.enum(["auto", "external", "deepseek-native", "hybrid"]);

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
  if (result.freshness !== undefined) {
    lines.push(`Freshness: ${result.freshness.status} (${result.freshness.mode})`);
  }
  if (result.fastCleaning !== undefined) {
    lines.push(`Fast cleaning: ${result.fastCleaning.mode} (${result.fastCleaning.applied ? "applied" : "shadow"})`);
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
  if (result.freshness !== undefined) {
    lines.push(`Freshness: ${result.freshness.status} (${result.freshness.mode})`);
  }
  if (result.sourceQuality !== undefined) {
    lines.push(`Primary/official sources: ${result.sourceQuality.officialSources}/${result.sourceQuality.totalSources}`);
  }
  if (result.warnings.length > 0) {
    lines.push("", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}

export function createMcpServer(config: AppConfig): McpServer {
  const service = new SearchService(config);
  const server = new McpServer({
    name: "deepseek-web-search-mcp",
    version: "1.4.0",
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
        freshness_mode: freshnessModeSchema.optional().describe(
          "Freshness policy. soft preserves provider results with a warning; strict requires verifiable published dates.",
        ),
        quality: qualitySchema.optional().describe(
          "Search quality. Defaults to fast; balanced/deep enable rank fusion.",
        ),
        rerank: z.boolean().optional().describe(
          "Deprecated compatibility alias: true maps to balanced when quality is omitted.",
        ),
        backend: backendSchema.optional().describe(
          "Search backend. Defaults to WEB_SEARCH_BACKEND (auto by default); hybrid includes DeepSeek native search as one provider, deepseek-native uses it exclusively, and auto uses hybrid when DEEPSEEK_API_KEY is configured.",
        ),
      },
    },
    async ({ query, scope, max_results, freshness, freshness_mode, quality, rerank, backend }) => {
      try {
        const result = await service.webSearch({
          query,
          scope,
          maxResults: max_results,
          freshness,
          ...(freshness_mode === undefined ? {} : { freshnessMode: freshness_mode }),
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
        freshness_mode: freshnessModeSchema.optional().describe(
          "Freshness policy for the research request.",
        ),
      },
    },
    async ({ query, max_sources, freshness, freshness_mode }) => {
      try {
        const result = await service.webResearch({
          query,
          maxSources: max_sources,
          freshness,
          ...(freshness_mode === undefined ? {} : { freshnessMode: freshness_mode }),
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

  server.registerTool(
    "research_start",
    {
      title: "Start Research Session",
      description: "Start a stateful research session and return a cited first-turn result.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        query: z.string().min(1).max(400),
        max_sources: z.number().int().min(1).max(20).default(5),
        freshness: freshnessSchema,
        freshness_mode: freshnessModeSchema.optional(),
      },
    },
    async ({ query, max_sources, freshness, freshness_mode }) => {
      try {
        const result = await service.researchStart({
          query,
          maxSources: max_sources,
          freshness,
          ...(freshness_mode === undefined ? {} : { freshnessMode: freshness_mode }),
        });
        return {
          content: [{ type: "text", text: researchMarkdown(result.result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: errorText(error) }] };
      }
    },
  );

  server.registerTool(
    "research_followup",
    {
      title: "Follow Up Research",
      description: "Continue an existing research session with a focused follow-up question.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        session_id: z.string().uuid(),
        question: z.string().min(1).max(400),
        max_sources: z.number().int().min(1).max(20).default(5),
        freshness: freshnessSchema,
        freshness_mode: freshnessModeSchema.optional(),
      },
    },
    async ({ session_id, question, max_sources, freshness, freshness_mode }) => {
      try {
        const result = await service.researchFollowup({
          sessionId: session_id,
          question,
          maxSources: max_sources,
          freshness,
          ...(freshness_mode === undefined ? {} : { freshnessMode: freshness_mode }),
        });
        return {
          content: [{ type: "text", text: researchMarkdown(result.result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: errorText(error) }] };
      }
    },
  );

  server.registerTool(
    "research_close",
    {
      title: "Close Research Session",
      description: "Close a research session and release its in-memory state.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        session_id: z.string().uuid(),
      },
    },
    async ({ session_id }) => {
      try {
        const result = service.researchClose(session_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: errorText(error) }] };
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
