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
const client = new Client({ name: "quality-probe", version: "1.5.0" });

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

try {
  await client.connect(transport);

  const soft = await call("web_research", {
    query: "DeepSeek latest model version and pricing",
    max_sources: 8,
    freshness: "any",
  });
  const strict = await call("web_research", {
    query: "DeepSeek latest model version and pricing",
    max_sources: 8,
    freshness: "month",
    freshness_mode: "strict",
  });
  const docs = await call("web_search", {
    query: "Next.js official API documentation",
    scope: "global",
    max_results: 8,
    freshness: "any",
  });
  const synthesis = await call("web_research", {
    query: "what are the current differences between RAG and long context models",
    max_sources: 8,
    freshness: "any",
  });

  const interesting = /independent|copied|content farm|Collapsed|primary or official/iu;
  process.stdout.write(`${JSON.stringify({
    softFreshness: {
      status: soft.freshness?.status,
      mode: soft.freshness?.mode,
      intent: soft.freshness?.intent,
      warning: soft.warnings?.find((warning) => /time-sensitive/u.test(warning)),
    },
    strictFreshness: {
      status: strict.freshness?.status,
      mode: strict.freshness?.mode,
      filteredCount: strict.freshness?.filteredCount,
      stillRecommends: strict.warnings?.some((warning) => /time-sensitive/u.test(warning)) ?? false,
      sources: strict.sources?.length,
    },
    documentationSearch: {
      quality: docs.quality,
      mode: docs.mode,
      sourceIdentity: docs.sourceIdentity,
      top3: docs.sources?.slice(0, 3).map((item) => item.url),
    },
    synthesisResearch: {
      sourceIdentity: synthesis.sourceIdentity,
      sourceQuality: synthesis.sourceQuality,
      independenceWarnings: synthesis.warnings?.filter((warning) => interesting.test(warning)),
      hosts: [...new Set((synthesis.sources ?? []).map((item) => hostOf(item.url)))],
    },
  }, null, 2)}\n`);
} finally {
  await client.close();
}
