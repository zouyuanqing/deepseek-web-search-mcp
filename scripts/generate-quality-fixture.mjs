import { writeFile } from "node:fs/promises";

const officialQueries = [
  "DeepSeek official API documentation",
  "OpenAI official MCP documentation",
  "SearXNG official Docker documentation",
  "Tavily official search API documentation",
  "Anthropic official Messages API reference",
];
const currentQueries = [
  "上海天气 2026年9月25日",
  "DeepSeek latest model release",
  "OpenAI latest API changelog",
  "SearXNG latest release notes",
  "Tavily latest product update",
];
const ambiguousQueries = [
  "MCP documentation",
  "best web search API",
  "DeepSeek research tools",
  "OpenAI agents framework",
  "SearXNG vs Tavily",
];
const exploratoryQueries = [
  "how to compare web search providers",
  "multi source search research workflow",
  "freshness aware web search",
  "provider aware rank fusion",
  "DeepSeek web search integration",
];
const categories = [
  { name: "official", queries: officialQueries, scope: "global" },
  { name: "current", queries: currentQueries, scope: "cn" },
  { name: "ambiguous", queries: ambiguousQueries, scope: "global" },
  { name: "exploratory", queries: exploratoryQueries, scope: "global" },
];

function source(url, provider, title, score, publishedAt) {
  return {
    url,
    provider,
    title,
    score,
    ...(publishedAt === undefined ? {} : { publishedAt }),
  };
}

function makeCase(category, query, index) {
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 36);
  const official = `https://docs-${slug}.example.com/reference`;
  const repository = `https://github.com/example/${slug}`;
  const news = `https://news-${slug}.example.com/latest`;
  const community = `https://community-${slug}.example.com/thread`;
  const freshness = category === "current" ? "day" : "any";
  const currentDate = "2026-09-24T12:00:00.000Z";
  const providers = [
    { provider: "tavily", status: "ok", elapsedMs: 100 + index, sources: [source(official, "tavily", `${query} official reference`, 0.91 - (index % 5) * 0.03, category === "current" ? currentDate : undefined)] },
    { provider: "searxng", status: "ok", elapsedMs: 140 + index, sources: [source(repository, "searxng", `${query} source repository`, 0.76 - (index % 4) * 0.02)] },
    { provider: "anysearch", status: index % 9 === 0 ? "empty" : "ok", elapsedMs: 180 + index, sources: index % 9 === 0 ? [] : [source(news, "anysearch", `${query} recent result`, 0.63, category === "current" ? currentDate : undefined)] },
    { provider: "deepseek-native", status: index % 13 === 0 ? "error" : "ok", elapsedMs: 500 + index, sources: index % 13 === 0 ? [] : [source(community, "deepseek-native", `${query} native research`, 0.58, category === "current" ? currentDate : undefined)], ...(index % 13 === 0 ? { errorCode: "timeout", errorMessage: "synthetic timeout" } : {}) },
  ];
  const labels = {
    [official]: 3,
    [repository]: category === "official" ? 3 : 2,
    [news]: category === "current" ? 3 : 1,
    [community]: 1,
  };
  const rerankSources = providers
    .flatMap((provider) => provider.sources)
    .slice(0, 4)
    .map((item, rank) => ({ ...item, rerankScore: Math.max(0.05, 0.92 - rank * 0.17) }));
  return {
    id: `${category.name}-${String(index + 1).padStart(3, "0")}`,
    split: index < 30 ? "development" : "held-out",
    datasetKind: "synthetic",
    query,
    scope: category.scope,
    freshness,
    providers,
    rerank: { status: "ok", model: "fixture-reranker", elapsedMs: 80 + index, sources: rerankSources },
    labels,
  };
}

const cases = categories.flatMap((category) =>
  category.queries.flatMap((query, index) => [makeCase(category, query, index)]));
const expanded = [];
for (let repeat = 0; repeat < 3; repeat += 1) {
  for (const item of cases) {
    expanded.push({
      ...item,
      id: `${item.id}-r${repeat + 1}`,
      query: repeat === 0 ? item.query : `${item.query} variant ${repeat + 1}`,
      split: expanded.length < 30 ? "development" : "held-out",
    });
  }
}
const output = new URL("../work/quality/replay-fixture.json", import.meta.url);
await writeFile(output, `${JSON.stringify(expanded, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ cases: expanded.length, output: "work/quality/replay-fixture.json", datasetKind: "synthetic" })}\n`);
