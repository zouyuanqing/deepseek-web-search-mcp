import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const env = Object.fromEntries(
  Object.entries(process.env).filter((entry) => entry[1] !== undefined),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env,
  stderr: "pipe",
});
const client = new Client({ name: "deepseek-web-search-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  if (JSON.stringify(toolNames) !== JSON.stringify(["web_research", "web_search"])) {
    throw new Error(`Unexpected tools: ${toolNames.join(", ")}`);
  }

  const search = await client.callTool({
    name: "web_search",
    arguments: {
      query: "2026年9月17日上海天气",
      scope: "cn",
      max_results: 8,
      freshness: "day",
      rerank: true,
    },
  });
  if (search.isError === true) {
    throw new Error(`web_search failed: ${JSON.stringify(search.content)}`);
  }

  const research = await client.callTool({
    name: "web_research",
    arguments: {
      query: "2026年9月17日上海天气",
      max_sources: 3,
      freshness: "day",
    },
  });
  if (research.isError === true) {
    throw new Error(`web_research failed: ${JSON.stringify(research.content)}`);
  }

  const searchResult = search.structuredContent;
  const researchResult = research.structuredContent;
  process.stdout.write(`${JSON.stringify({
    tools: toolNames,
    search: {
      provider: searchResult?.provider,
      sources: Array.isArray(searchResult?.sources) ? searchResult.sources.length : 0,
      fallbackUsed: searchResult?.fallbackUsed,
      mode: searchResult?.mode,
      rerankApplied: searchResult?.rerank?.applied,
    },
    research: {
      provider: researchResult?.provider,
      sources: Array.isArray(researchResult?.sources) ? researchResult.sources.length : 0,
      nativeSearchRequests: researchResult?.nativeSearchRequests,
      degraded: researchResult?.degraded,
    },
  }, null, 2)}\n`);
} finally {
  await client.close();
}
