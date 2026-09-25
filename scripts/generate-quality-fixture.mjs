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
const syndicationQueries = [
  "DeepSeek V4 benchmark results",
  "SearXNG 1.0 changes",
  "Tavily pricing tiers",
  "MCP server security guidance",
  "Reranker model comparison",
];
const aggregatorDominanceQueries = [
  "DeepSeek API rate limits",
  "SearXNG rate limit configuration",
  "Tavily search API quotas",
  "MCP protocol transport types",
  "SSE reconnect backoff",
];
const categories = [
  { name: "official", queries: officialQueries, scope: "global" },
  { name: "current", queries: currentQueries, scope: "cn" },
  { name: "ambiguous", queries: ambiguousQueries, scope: "global" },
  { name: "exploratory", queries: exploratoryQueries, scope: "global" },
];

/**
 * Cases that reproduce the real-world citation problems: the same article
 * republished in several languages, mirrored across content-farm hosts, and a
 * missing official page. Only the official URL carries relevance 3.
 */
function makeSyndicationCase(query, index) {
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 36);
  const official = `https://docs-${slug}.example.com/announcement`;
  const title = `${query} full analysis`;
  const languageVariants = ["it", "ar", "en"].map((language) => `https://techsy.io/${language}/${slug}-full-analysis`);
  const mirror = `https://ofox.ai/${slug}-full-analysis`;
  const farm = `https://taskade.com/${slug}-notes`;
  const providers = [
    { provider: "tavily", status: "ok", elapsedMs: 90 + index, sources: [
      source(languageVariants[0], "tavily", title, 0.88),
      source(mirror, "tavily", title, 0.85),
    ] },
    { provider: "searxng", status: "ok", elapsedMs: 130 + index, sources: [
      source(official, "searxng", `${query} official announcement`, 0.8),
      source(languageVariants[1], "searxng", title, 0.7),
    ] },
    { provider: "anysearch", status: "ok", elapsedMs: 170 + index, sources: [
      source(farm, "anysearch", `${query} notes`, 0.66),
      source(languageVariants[2], "anysearch", title, 0.61),
    ] },
    { provider: "deepseek-native", status: "ok", elapsedMs: 480 + index, sources: [
      source(mirror, "deepseek-native", title, 0.59),
      source(farm, "deepseek-native", `${query} notes`, 0.55),
    ] },
  ];
  return {
    id: `syndication-${String(index + 1).padStart(3, "0")}`,
    split: "held-out",
    datasetKind: "synthetic",
    query,
    scope: "global",
    freshness: "any",
    providers,
    rerank: { status: "ok", model: "fixture-reranker", elapsedMs: 70 + index, sources: [] },
    labels: { [official]: 3, [languageVariants[0]]: 1, [mirror]: 1, [farm]: 0, [languageVariants[1]]: 1, [languageVariants[2]]: 1 },
  };
}

/**
 * Cases where a low-quality aggregator outranks the official page in the raw
 * provider order. This is the only fixture shape that can actually measure
 * whether authority reordering helps, so it must not be omitted.
 */
function makeAggregatorDominanceCase(query, index) {
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 36);
  const official = `https://docs-${slug}.example.com/reference`;
  const reddit = `https://www.reddit.com/r/${slug}/comments/1`;
  const medium = `https://medium.com/@writer/${slug}-explained`;
  const video = `https://www.youtube.com/watch?v=${index + 1}`;
  const farm = `https://techsy.io/en/${slug}-complete-guide`;
  const providers = [
    { provider: "tavily", status: "ok", elapsedMs: 100 + index, sources: [
      source(reddit, "tavily", `${query} discussion thread`, 0.95),
      source(official, "tavily", `${query} official reference`, 0.72),
    ] },
    { provider: "searxng", status: "ok", elapsedMs: 150 + index, sources: [
      source(medium, "searxng", `${query} explained simply`, 0.9),
      source(farm, "searxng", `${query} complete guide`, 0.68),
    ] },
    { provider: "anysearch", status: "ok", elapsedMs: 190 + index, sources: [
      source(video, "anysearch", `${query} video walkthrough`, 0.86),
    ] },
    { provider: "deepseek-native", status: "ok", elapsedMs: 520 + index, sources: [
      source(farm, "deepseek-native", `${query} complete guide`, 0.6),
    ] },
  ];
  return {
    id: `aggregator-dominance-${String(index + 1).padStart(3, "0")}`,
    category: "aggregator-dominance",
    split: "held-out",
    datasetKind: "synthetic",
    query,
    scope: "global",
    freshness: "any",
    providers,
    rerank: {
      status: "ok",
      model: "fixture-reranker",
      elapsedMs: 80 + index,
      // The reranker has the same weakness the real nemotron model showed: it
      // scores the tutorial-shaped aggregator above the official reference.
      sources: [
        { ...providers[1].sources[0], rerankScore: 0.98 },
        { ...providers[0].sources[1], rerankScore: 0.037 },
        { ...providers[0].sources[0], rerankScore: 0.006 },
        { ...providers[2].sources[0], rerankScore: 0.4 },
        { ...providers[1].sources[1], rerankScore: 0.2 },
      ],
    },
    labels: { [official]: 3, [reddit]: 1, [medium]: 1, [video]: 0, [farm]: 1 },
  };
}

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
  // Distinct registrable domains: putting every host under example.com would
  // make domainCap=2 look like a diversity failure when it is not one.
  const news = `https://news-${slug}.example.org/latest`;
  const community = `https://community-${slug}.example.net/thread`;
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
    category: category.name,
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
      category: item.category ?? item.id.split("-")[0],
      query: repeat === 0 ? item.query : `${item.query} variant ${repeat + 1}`,
      split: expanded.length < 30 ? "development" : "held-out",
    });
  }
}
// Syndication cases are appended after the split so they are always held-out
// and never influence any development-set decision.
for (const [index, query] of syndicationQueries.entries()) {
  const item = makeSyndicationCase(query, index);
  expanded.push({ ...item, id: `${item.id}-h${index + 1}`, category: "syndication" });
}
for (const [index, query] of aggregatorDominanceQueries.entries()) {
  const item = makeAggregatorDominanceCase(query, index);
  expanded.push({ ...item, id: `${item.id}-h${index + 1}` });
}
const output = new URL("../work/quality/replay-fixture.json", import.meta.url);
await writeFile(output, `${JSON.stringify(expanded, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ cases: expanded.length, output: "work/quality/replay-fixture.json", datasetKind: "synthetic" })}\n`);
