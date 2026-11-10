#!/usr/bin/env node
/**
 * scripts/eval/capture.mjs - record live OpenRouter model outputs for the v1.7.0 eval harness.
 *
 * Writes ONLY test/fixtures/*.json (never outside that directory):
 *   - rerank-cases.json          old vs new rerank relevance scores on labelled candidate sets
 *   - decisions-docs-intent.json docs-intent probabilities (2 repeats/query) + annotation/latency stats;
 *     the request is built from the built dist production prompt (DOCS_INTENT_QUESTION) and
 *     state { query } so the recorded probabilities validate the shipped veto, not a variant.
 *   - semantic-capture.json        recorded 8b cosines for labelled duplicate / distinct text pairs
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node scripts/eval/capture.mjs              # all sections
 *   node scripts/eval/capture.mjs --dry-run                           # plan + counts, no network
 *   OPENROUTER_API_KEY=... node scripts/eval/capture.mjs --only=rerank
 *   OPENROUTER_API_KEY=... node scripts/eval/capture.mjs --refresh    # recapture existing ok cases too
 *
 * Budget: 120 live requests total (EVAL_MAX_REQUESTS), retries capped, 502 => skip model/section.
 * Existing successful records are reused unless --refresh, so re-runs top up instead of re-billing.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const BASE_URL = "https://openrouter.ai";
const OUT_DIR = new URL("../../test/fixtures/", import.meta.url);

const MODELS = {
  rerankOld: "nvidia/llama-nemotron-rerank-vl-1b-v2:free",
  rerankNew: "nvidia/nemotron-3.5-rerank-8b:free",
  embed: "nvidia/nemotron-3.5-embed-8b:free",
  decisions: "parallel/decisions-fast:free",
};

const MAX_REQUESTS = positiveInt(process.env.EVAL_MAX_REQUESTS, 120);
const REQUEST_TIMEOUT_MS = positiveInt(process.env.EVAL_REQUEST_TIMEOUT_MS, 60000);
const MIN_REQUEST_GAP_MS = positiveInt(process.env.EVAL_MIN_GAP_MS, 1000);
const DECISION_REPEATS = 2;
const RERANK_INPUT_CHARS = 800;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const parsed = { only: undefined, dryRun: false, refresh: false };
  for (const raw of argv.slice(2)) {
    if (raw === "--dry-run") parsed.dryRun = true;
    else if (raw === "--refresh") parsed.refresh = true;
    else if (raw.startsWith("--only=")) {
      parsed.only = raw.slice("--only=".length).split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  return parsed;
}

const args = parseArgs(process.argv);
const sections = args.only ?? ["rerank", "decisions", "semantic"];
for (const section of sections) {
  if (!["rerank", "decisions", "semantic"].includes(section)) {
    console.error("unknown section; use --only=rerank,decisions,semantic");
    process.exit(2);
  }
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (args.dryRun !== true && (apiKey === undefined || apiKey.trim().length === 0)) {
  console.error("OPENROUTER_API_KEY is not set; live capture requires it (use --dry-run to validate data without network).");
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// HTTP: single request budget, retries with backoff, 502 reported as { status: 502 } for skipping.
// ---------------------------------------------------------------------------------------------
let requests = 0;
let retries = 0;
let lastRequestAt = 0;
let minGapMs = MIN_REQUEST_GAP_MS;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class BudgetExceededError extends Error {}
class HttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function postJson(path, body, label) {
  const retryDelays = [1000, 4000, 10000];
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (requests >= MAX_REQUESTS) throw new BudgetExceededError("request budget " + MAX_REQUESTS + " exhausted at " + label);
    const gap = lastRequestAt + minGapMs - Date.now();
    if (gap > 0) await sleep(gap);
    if (requests > 0 && attempt > 0) retries += 1;
    lastRequestAt = Date.now();
    requests += 1;
    try {
      const response = await fetch(BASE_URL + path, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
          "X-OpenRouter-Title": "deepseek-web-search-mcp eval harness",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      if (!response.ok) {
        if (response.status === 502 || response.status === 503) return { status: response.status, body: text };
        if ((response.status === 429 || response.status >= 500) && attempt < retryDelays.length) {
          if (response.status === 429) minGapMs = Math.max(minGapMs, 3000);
          await sleep(retryDelays[attempt]);
          continue;
        }
        throw new HttpError(response.status, "HTTP " + response.status + ": " + text.slice(0, 300), text);
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new HttpError(response.status, "invalid JSON response", text);
      }
      return { status: response.status, body: parsed };
    } catch (error) {
      if (error instanceof HttpError || error instanceof BudgetExceededError) throw error;
      if (attempt < retryDelays.length) {
        minGapMs = Math.max(minGapMs, 2000);
        await sleep(retryDelays[attempt]);
        continue;
      }
      throw new HttpError(0, "fetch failed: " + (error && error.message ? error.message : String(error)));
    }
  }
  throw new HttpError(0, "unreachable retry state for " + label);
}

// ---------------------------------------------------------------------------------------------
// Data set A - rerank calibration: 20 cases x 5-6 candidates, deliberately mixed provider order,
// graded labels (3 official/primary, 2 useful secondary, 1 tangential, 0 farm/irrelevant).
// ---------------------------------------------------------------------------------------------
function candidate(provider, url, title, snippet, label) {
  return { provider, url, title, snippet, label };
}

const RERANK_CASES = [
  { id: "official-001", category: "official", query: "DeepSeek official API documentation",
    candidates: [
      candidate("searxng", "https://github.com/deepseek-ai/DeepSeek-V4", "deepseek-ai/DeepSeek-V4", "Model repository with weights and technical report.", 2),
      candidate("tavily", "https://api-docs.deepseek.com/", "DeepSeek API Documentation", "Official reference for chat completions, models, pricing and rate limits.", 3),
      candidate("anysearch", "https://www.reddit.com/r/LocalLLaMA/comments/1deepseekapi/", "Is the DeepSeek API worth it? - r/LocalLLaMA", "Community discussion about pricing and quality.", 1),
      candidate("deepseek-search", "https://techsy.io/en/deepseek-api-complete-guide", "DeepSeek API complete guide 2026", "Aggregated tips and tricks from multiple blogs.", 0),
      candidate("tavily", "https://api-docs.deepseek.com/pricing", "DeepSeek API Pricing", "Official pricing table for the DeepSeek API.", 3),
      candidate("searxng", "https://blog.thirdparty.dev/call-deepseek-api-python", "How to call the DeepSeek API with Python in 5 minutes", "Third-party tutorial with screenshots.", 1),
    ] },
  { id: "official-002", category: "official", query: "OpenAI official MCP documentation",
    candidates: [
      candidate("anysearch", "https://medium.com/@writer/mcp-explained-simply", "MCP explained simply", "Blog post explaining MCP in plain language.", 1),
      candidate("tavily", "https://platform.openai.com/docs/mcp", "MCP - OpenAI Platform docs", "Official OpenAI documentation for Model Context Protocol support.", 3),
      candidate("searxng", "https://modelcontextprotocol.io/specification/transports", "MCP transports specification", "Official MCP specification page for transports.", 3),
      candidate("deepseek-search", "https://ofox.ai/mcp-complete-guide", "MCP complete guide", "Mirrored aggregator page.", 0),
      candidate("tavily", "https://www.youtube.com/watch?v=mcp-video", "MCP video walkthrough", "Conference talk recording.", 0),
    ] },
  { id: "official-003", category: "official", query: "SearXNG official Docker installation guide",
    candidates: [
      candidate("searxng", "https://docs.searxng.org/admin/installation-docker.html", "SearXNG Docker installation", "Official docs: run SearXNG with Docker Compose.", 3),
      candidate("tavily", "https://github.com/searxng/searxng", "searxng/searxng", "Source repository and README.", 2),
      candidate("deepseek-search", "https://taskade.com/searxng-notes", "SearXNG notes and tips", "Content-farm notes page.", 0),
      candidate("anysearch", "https://www.reddit.com/r/searxng/comments/1docker/", "Docker setup questions", "Community thread about docker networking.", 1),
      candidate("tavily", "https://docs.searxng.org/admin/settings/index.html", "SearXNG settings reference", "Official settings reference.", 3),
    ] },
  { id: "official-004", category: "official", query: "Anthropic Messages API reference",
    candidates: [
      candidate("tavily", "https://docs.anthropic.com/en/api/messages", "Messages API reference - Anthropic", "Official API reference for the Messages endpoint.", 3),
      candidate("anysearch", "https://stackoverflow.com/questions/1/anthropic-messages", "Anthropic Messages API error - Stack Overflow", "Question about a 400 error.", 1),
      candidate("searxng", "https://github.com/anthropics/anthropic-sdk-typescript", "anthropic-sdk-typescript", "Official TypeScript SDK repository.", 2),
      candidate("deepseek-search", "https://aitoolly.com/anthropic-api-guide", "Anthropic API guide", "Aggregator repost.", 0),
      candidate("tavily", "https://docs.anthropic.com/en/api/rate-limits", "Rate limits - Anthropic docs", "Official rate limit reference.", 3),
    ] },
  { id: "official-005", category: "official", query: "Tavily search API reference",
    candidates: [
      candidate("anysearch", "https://www.reddit.com/r/webdev/comments/1tavily/", "Tavily API experience?", "Community opinions.", 1),
      candidate("searxng", "https://docs.tavily.com/documentation/api-reference/endpoint/search", "Search endpoint - Tavily API reference", "Official API reference for the search endpoint.", 3),
      candidate("tavily", "https://docs.tavily.com/documentation/api-reference/endpoint/extract", "Extract endpoint - Tavily API reference", "Official API reference for extract.", 3),
      candidate("deepseek-search", "https://techstackexplorer.com/tavily-guide", "Tavily guide", "Aggregator page.", 0),
      candidate("anysearch", "https://blog.thirdparty.dev/tavily-vs-serpapi", "Tavily vs SerpAPI", "Comparison blog.", 1),
    ] },
  { id: "current-001", category: "current", query: "DeepSeek latest model release",
    candidates: [
      candidate("tavily", "https://api-docs.deepseek.com/news/2026/deepseek-v41", "DeepSeek V4.1 release notes", "Official announcement of the V4.1 release.", 3),
      candidate("searxng", "https://techcrunch.com/2026/09/deepseek-v41-release", "DeepSeek releases V4.1 with 1M context", "News coverage of the release.", 2),
      candidate("deepseek-search", "https://ofox.ai/deepseek-v41-analysis", "DeepSeek V4.1 analysis", "Mirrored aggregator analysis.", 0),
      candidate("anysearch", "https://www.reddit.com/r/LocalLLaMA/comments/1v41/", "V4.1 first impressions", "Community thread.", 1),
      candidate("tavily", "https://blog.oldnews.dev/deepseek-v3-review", "DeepSeek V3 review (2025)", "Outdated review of the previous generation.", 0),
    ] },
  { id: "current-002", category: "current", query: "OpenAI latest API changelog",
    candidates: [
      candidate("anysearch", "https://community.openai.com/t/changelog-discussion/1", "Changelog discussion thread", "Community discussion.", 1),
      candidate("tavily", "https://platform.openai.com/docs/changelog", "API changelog - OpenAI Platform", "Official changelog of API changes.", 3),
      candidate("searxng", "https://news.ycombinator.com/item?id=1", "OpenAI API changes - Hacker News", "Discussion thread.", 1),
      candidate("deepseek-search", "https://aitoolmall.com/openai-changelog-summary", "OpenAI changelog summary", "Auto-generated summary site.", 0),
      candidate("tavily", "https://platform.openai.com/docs/deprecations", "Deprecations - OpenAI Platform", "Official deprecation schedule.", 3),
    ] },
  { id: "current-003", category: "current", query: "SearXNG latest release notes",
    candidates: [
      candidate("searxng", "https://github.com/searxng/searxng/releases", "Releases - searxng/searxng", "Official GitHub release notes.", 3),
      candidate("tavily", "https://news.ycombinator.com/item?id=2", "SearXNG release discussion", "Hacker News thread.", 1),
      candidate("anysearch", "https://www.reddit.com/r/searxng/comments/1release/", "Release thread", "Subreddit thread.", 1),
      candidate("deepseek-search", "https://genuineai.com/searxng-release-summary", "SearXNG release summary", "Content-farm summary.", 0),
      candidate("tavily", "https://docs.searxng.org/dev/releases.html", "SearXNG release history", "Official release history page.", 2),
    ] },
  { id: "current-004", category: "current", query: "MCP security guidance 2026",
    candidates: [
      candidate("anysearch", "https://modelcontextprotocol.io/specification/security", "MCP security best practices", "Official security guidance for MCP.", 3),
      candidate("tavily", "https://www.reddit.com/r/mcp/comments/1security/", "MCP security concerns", "Community thread.", 1),
      candidate("searxng", "https://blog.thirdparty.dev/mcp-security-checklist", "MCP security checklist", "Third-party checklist blog.", 2),
      candidate("deepseek-search", "https://pdf.ai/mcp-security-guide", "MCP security guide PDF", "Gated PDF landing page.", 0),
      candidate("tavily", "https://github.com/modelcontextprotocol/security-advisories", "MCP security advisories", "Official advisories repository.", 2),
    ] },
  { id: "current-005", category: "current", query: "web search API pricing changes",
    candidates: [
      candidate("tavily", "https://docs.tavily.com/documentation/pricing", "Tavily pricing", "Official pricing page.", 3),
      candidate("searxng", "https://techcrunch.com/2026/08/search-api-pricing", "Search API pricing shifts", "News article on pricing changes.", 2),
      candidate("anysearch", "https://www.reddit.com/r/webdev/comments/1pricing/", "Search API pricing thread", "Community discussion.", 1),
      candidate("deepseek-search", "https://productbard.com/search-api-pricing-comparison", "Search API pricing comparison", "Affiliate comparison page.", 0),
      candidate("tavily", "https://docs.tavily.com/documentation/api-reference/endpoint/search", "Tavily search API reference", "Official API reference.", 2),
    ] },
  { id: "comparison-001", category: "comparison", query: "SearXNG vs Tavily",
    candidates: [
      candidate("anysearch", "https://www.reddit.com/r/searxng/comments/1vst/", "SearXNG vs Tavily - r/searxng", "Community comparison thread.", 1),
      candidate("searxng", "https://docs.searxng.org/", "SearXNG documentation", "Official docs landing page.", 2),
      candidate("tavily", "https://blog.thirdparty.dev/searxng-vs-tavily-2026", "SearXNG vs Tavily in 2026", "Detailed comparison with benchmarks.", 2),
      candidate("deepseek-search", "https://techsy.io/en/searxng-vs-tavily", "SearXNG vs Tavily - what is better?", "Content-farm comparison.", 0),
      candidate("anysearch", "https://docs.tavily.com/documentation/api-reference/endpoint/search", "Tavily search endpoint reference", "Official API reference.", 2),
    ] },
  { id: "comparison-002", category: "comparison", query: "best web search API",
    candidates: [
      candidate("deepseek-search", "https://aitoolplanet.com/best-web-search-api", "Best web search API 2026 (top 12)", "Affiliate listicle.", 0),
      candidate("tavily", "https://www.g2.com/categories/search-apis", "Best Search APIs - G2", "Review portal rankings.", 1),
      candidate("searxng", "https://docs.searxng.org/", "SearXNG docs", "Official docs.", 2),
      candidate("anysearch", "https://news.ycombinator.com/item?id=3", "Ask HN: best search API?", "HN discussion.", 1),
      candidate("tavily", "https://docs.tavily.com/documentation/api-reference/endpoint/search", "Tavily search API reference", "Official API reference.", 2),
    ] },
  { id: "comparison-003", category: "comparison", query: "reranker model comparison",
    candidates: [
      candidate("anysearch", "https://huggingface.co/spaces/reranker-leaderboard", "Reranker leaderboard", "Community leaderboard on Hugging Face.", 2),
      candidate("searxng", "https://arxiv.org/abs/2404.00000", "A survey of reranking models", "Academic survey paper.", 2),
      candidate("tavily", "https://blog.thirdparty.dev/nemotron-rerank-vs-cohere", "Nemotron rerank vs Cohere rerank", "Hands-on comparison blog.", 2),
      candidate("deepseek-search", "https://thequantumgadget.com/reranker-comparison", "Reranker comparison 2026", "Aggregator listicle.", 0),
      candidate("anysearch", "https://www.reddit.com/r/MachineLearning/comments/1rerank/", "Reranker experiences", "Community thread.", 1),
    ] },
  { id: "comparison-004", category: "comparison", query: "vector database comparison for RAG",
    candidates: [
      candidate("tavily", "https://www.reddit.com/r/Rag/comments/1vdb/", "Vector DB choices for RAG", "Community thread.", 1),
      candidate("searxng", "https://blog.thirdparty.dev/vector-db-benchmarks-2026", "Vector DB benchmarks 2026", "Benchmark blog with methodology.", 2),
      candidate("anysearch", "https://news.ycombinator.com/item?id=4", "Vector database discussion", "HN thread.", 1),
      candidate("deepseek-search", "https://itoolszone.com/vector-database-guide", "Vector database guide", "Aggregator page.", 0),
      candidate("tavily", "https://docs.pinecone.io/guides/overview", "Pinecone documentation", "Official docs for one compared product.", 2),
    ] },
  { id: "chinese-001", category: "chinese", query: "DeepSeek 官方 API 文档",
    candidates: [
      candidate("searxng", "https://api-docs.deepseek.com/zh-cn/", "DeepSeek API 文档", "官方 API 参考文档（中文）。", 3),
      candidate("anysearch", "https://zhuanlan.zhihu.com/p/123456", "DeepSeek API 使用指南 - 知乎", "第三方知乎专栏教程。", 1),
      candidate("deepseek-search", "https://blog.csdn.net/x/article/details/1", "DeepSeek API 接入教程", "CSDN 博客转载。", 1),
      candidate("tavily", "https://github.com/deepseek-ai/DeepSeek-V4", "deepseek-ai/DeepSeek-V4", "官方模型仓库。", 2),
      candidate("searxng", "https://techsy.io/zh/deepseek-api", "DeepSeek API 完整指南", "内容农场聚合页。", 0),
    ] },
  { id: "chinese-002", category: "chinese", query: "MCP 协议 传输类型",
    candidates: [
      candidate("tavily", "https://modelcontextprotocol.io/specification/transports", "MCP transports specification", "官方传输层规范（英文）。", 3),
      candidate("anysearch", "https://juejin.cn/post/123456", "MCP 传输类型详解 - 掘金", "社区技术文章。", 1),
      candidate("deepseek-search", "https://www.cnblogs.com/x/p/1.html", "MCP 协议学习笔记", "博客学习笔记。", 1),
      candidate("searxng", "https://docs.searxng.org/", "SearXNG 文档", "无关的官方文档。", 0),
      candidate("tavily", "https://github.com/modelcontextprotocol/typescript-sdk", "modelcontextprotocol/typescript-sdk", "官方 TypeScript SDK 仓库。", 2),
    ] },
  { id: "chinese-003", category: "chinese", query: "Tavily 定价 套餐",
    candidates: [
      candidate("searxng", "https://docs.tavily.com/documentation/pricing", "Tavily pricing", "Official pricing page.", 3),
      candidate("anysearch", "https://zhuanlan.zhihu.com/p/654321", "Tavily 定价分析 - 知乎", "知乎分析文章。", 1),
      candidate("deepseek-search", "https://aitoolmall.com/tavily-pricing", "Tavily 价格汇总", "聚合站价格汇总。", 0),
      candidate("tavily", "https://www.reddit.com/r/webdev/comments/1tavilypricing/", "Tavily pricing?", "Reddit 讨论。", 1),
      candidate("searxng", "https://docs.tavily.com/documentation/api-reference/endpoint/search", "Tavily search API reference", "官方 API 参考。", 2),
    ] },
  { id: "aggregator-001", category: "aggregator-dominance", query: "DeepSeek API rate limits",
    candidates: [
      candidate("tavily", "https://www.reddit.com/r/LocalLLaMA/comments/1ratelimit/", "DeepSeek rate limits discussion", "Community thread with anecdotal limits.", 1),
      candidate("searxng", "https://techsy.io/en/deepseek-api-rate-limits", "DeepSeek API rate limits complete guide", "Content-farm guide that scrapes the docs.", 0),
      candidate("anysearch", "https://api-docs.deepseek.com/quick_start/rate_limit", "Rate limits - DeepSeek API Docs", "Official rate limit documentation.", 3),
      candidate("deepseek-search", "https://medium.com/@writer/deepseek-rate-limits-explained", "DeepSeek rate limits explained", "Medium blog post repeating the docs.", 1),
      candidate("tavily", "https://www.youtube.com/watch?v=ratelimits", "DeepSeek rate limits video", "Video overview.", 0),
    ] },
  { id: "aggregator-002", category: "aggregator-dominance", query: "SSE reconnect backoff",
    candidates: [
      candidate("anysearch", "https://medium.com/@writer/sse-reconnect-backoff-explained", "SSE reconnect backoff explained", "Medium blog post about backoff strategies.", 1),
      candidate("deepseek-search", "https://taskade.com/sse-notes", "SSE notes", "Content-farm notes page.", 0),
      candidate("searxng", "https://html.spec.whatwg.org/multipage/server-sent-events.html", "Server-sent events - WHATWG HTML spec", "Official specification for SSE.", 3),
      candidate("tavily", "https://github.com/modelcontextprotocol/typescript-sdk/issues/1", "SSE reconnect issue - MCP SDK", "GitHub issue thread.", 2),
      candidate("anysearch", "https://www.reddit.com/r/webdev/comments/1sse/", "SSE reconnect experiences", "Community thread.", 1),
    ] },
  { id: "aggregator-003", category: "aggregator-dominance", query: "MCP transport types",
    candidates: [
      candidate("tavily", "https://techsy.io/en/mcp-transport-types", "MCP transport types complete guide", "Content-farm guide.", 0),
      candidate("anysearch", "https://modelcontextprotocol.io/specification/transports", "MCP transports specification", "Official specification.", 3),
      candidate("searxng", "https://blog.thirdparty.dev/mcp-stdio-vs-http", "MCP stdio vs HTTP transports", "Third-party explainer.", 2),
      candidate("deepseek-search", "https://www.reddit.com/r/mcp/comments/1transport/", "MCP transport discussion", "Community thread.", 1),
      candidate("tavily", "https://github.com/modelcontextprotocol/typescript-sdk", "typescript-sdk", "Official SDK repository.", 2),
    ] },
];

// ---------------------------------------------------------------------------------------------
// Data set B - docs-intent veto: 20 labelled queries, 2 recorded probabilities each.
// gold.isDocumentation = should the docs routing apply (official/reference seeking).
// ---------------------------------------------------------------------------------------------
const DECISION_CASES = [
  { id: "docs-intent-001", category: "official-docs", query: "DeepSeek official API documentation", gold: true, note: "explicit official docs" },
  { id: "docs-intent-002", category: "fn-prone", query: "MCP transport types", gold: true, note: "concept page in the official spec; regex has no docs keyword" },
  { id: "docs-intent-003", category: "fn-prone", query: "OpenAI pricing per million tokens", gold: true, note: "pricing reference page; may look like commercial research" },
  { id: "docs-intent-004", category: "official-docs", query: "Anthropic Messages API reference", gold: true, note: "explicit API reference" },
  { id: "docs-intent-005", category: "fn-prone", query: "SSE reconnection behavior in MCP clients", gold: true, note: "behaviour detail documented in the spec" },
  { id: "docs-intent-006", category: "official-docs", query: "DeepSeek context caching documentation", gold: true, note: "explicit docs" },
  { id: "docs-intent-007", category: "official-docs", query: "SearXNG docker installation guide", gold: true, note: "official admin docs" },
  { id: "docs-intent-008", category: "fn-prone", query: "Tavily API rate limit headers", gold: true, note: "reference detail table" },
  { id: "docs-intent-009", category: "official-docs", query: "Python requests library reference", gold: true, note: "library reference docs" },
  { id: "docs-intent-010", category: "official-docs", query: "MCP TypeScript SDK server example", gold: true, note: "official SDK docs example" },
  { id: "docs-intent-011", category: "fn-prone", query: "webhook retry semantics documentation", gold: true, note: "explicit docs, product unspecified" },
  { id: "docs-intent-012", category: "fp-prone", query: "best search API", gold: false, note: "comparison/buying intent; regex sees api" },
  { id: "docs-intent-013", category: "fp-prone", query: "release management", gold: false, note: "process intent; regex sees release" },
  { id: "docs-intent-014", category: "fp-prone", query: "REST API design", gold: false, note: "craft/practices intent; regex sees api" },
  { id: "docs-intent-015", category: "fp-prone", query: "how to choose an embedding model", gold: false, note: "advice intent" },
  { id: "docs-intent-016", category: "fp-prone", query: "API gateway cost calculator", gold: false, note: "tool intent; regex sees api" },
  { id: "docs-intent-017", category: "neg-control", query: "how do I release a version", gold: false, note: "process question; regex sees release" },
  { id: "docs-intent-018", category: "neg-control", query: "compare search providers", gold: false, note: "comparison intent" },
  { id: "docs-intent-019", category: "neg-control", query: "what is a reranker", gold: false, note: "concept/opinion intent" },
  { id: "docs-intent-020", category: "neg-control", query: "search API market share", gold: false, note: "market data intent" },
];

/**
 * The decisions fixture must mirror the exact production request, otherwise the recorded
 * probabilities cannot validate the shipped veto. Both the question copy and the policy
 * constants are imported from the built dist (run "npm run build" first):
 *   - DOCS_INTENT_QUESTION  -> dist/providers/openrouter-decisions.js
 *   - PROMPT_VERSION / DECISIONS_VETO_BELOW / DECISIONS_KEEP_ABOVE -> dist/docs-intent.js
 * The fixture records promptVersion + questionHash so replay/accept can detect drift.
 */
async function optionalDistImport(relative) {
  try {
    return await import(new URL("../../dist/" + relative, import.meta.url));
  } catch {
    return null;
  }
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function loadProductionDecisionsPrompt() {
  const questionModule = await optionalDistImport("providers/openrouter-decisions.js");
  const policyModule = await optionalDistImport("docs-intent.js");
  const question = questionModule?.DOCS_INTENT_QUESTION;
  const promptVersion = policyModule?.PROMPT_VERSION;
  const vetoBelow = policyModule?.DECISIONS_VETO_BELOW;
  const keepAbove = policyModule?.DECISIONS_KEEP_ABOVE;
  if (
    question === null || typeof question !== "object"
    || typeof promptVersion !== "string"
    || typeof vetoBelow !== "number" || typeof keepAbove !== "number"
  ) {
    return null;
  }
  return {
    question,
    promptVersion,
    vetoBelow,
    keepAbove,
    questionHash: sha256Json(question),
    source: "dist/providers/openrouter-decisions.js + dist/docs-intent.js",
  };
}

// ---------------------------------------------------------------------------------------------
// Data set C - semantic pairs: 16 unique texts, 24 labelled pairs (duplicate / distinct).
// The embedding model is only reliable at n=1, so every text is embedded individually.
// ---------------------------------------------------------------------------------------------
const SEMANTIC_TEXTS = [
  { id: "t1", text: "DeepSeek has released DeepSeek-V4.1 with a one-million-token context window, stronger tool use, and lower API pricing. The model is available today through the DeepSeek API and as open weights." },
  { id: "t2", text: "DeepSeek 发布 DeepSeek-V4.1，支持一百万 token 上下文窗口、更强的工具调用能力和更低的 API 价格。该模型今天已通过 DeepSeek API 与开放权重提供。" },
  { id: "t3", text: "DeepSeek ha rilasciato DeepSeek-V4.1 con una finestra di contesto di un milione di token, uso degli strumenti più avanzato e prezzi API più bassi. Il modello è disponibile oggi tramite l'API DeepSeek e come open weights." },
  { id: "t4", text: "DeepSeek's new V4.1 offers a 1M-token context, better tool calling, and cheaper API access; it ships today via the API and as open-weight models." },
  { id: "t5", text: "DeepSeek V4.1 launch: 1 million token context, improved agentic tool use, reduced API prices. Available now on the DeepSeek API and as open-weight models. (Republished from the official announcement.)" },
  { id: "t6", text: "DeepSeek V4.1 benchmarks: the new model scores higher on SWE-bench and reduces latency, but reviewers note the API pricing change is the bigger story." },
  { id: "t7", text: "MCP transport types - official specification: stdio and Streamable HTTP are the two standard transports; the older HTTP+SSE transport is deprecated in favour of Streamable HTTP." },
  { id: "t8", text: "MCP transport types explained: a community blog walks through stdio versus HTTP transports with server examples and migration advice for existing SSE deployments." },
  { id: "t9", text: "SSE reconnection and backoff in MCP clients: how clients should handle disconnects, replay semantics and exponential backoff from the spec's transport section." },
  { id: "t10", text: "MCP server security guidance 2026: tool poisoning, prompt injection and trust boundaries when connecting third-party MCP servers." },
  { id: "t11", text: "OpenAI pricing per million tokens: gpt-4.1 input $2.00, cached input $0.50, output $8.00; gpt-4.1-mini input $0.40, output $1.60." },
  { id: "t12", text: "DeepSeek API rate limits: concurrency and requests-per-second limits for the DeepSeek API, including how 429 responses and retry-after headers behave." },
  { id: "t13", text: "Shanghai weather forecast for 25 September 2026: sunny, high 26 degrees Celsius, light north wind, no rain expected." },
  { id: "t14", text: "The Riemann hypothesis remains unproven; the Clay Mathematics Institute offers one million dollars for a correct proof." },
  { id: "t15", text: "How to bake sourdough bread: a starter schedule, hydration ratios, folding technique and oven temperatures for a reliable loaf." },
  { id: "t16", text: "Formula 1 Singapore Grand Prix 2026 qualifying results: pole position lap time and the top ten grid positions." },
];

const SEMANTIC_PAIRS = [
  { pairId: "pair-001", left: "t1", right: "t1", label: "duplicate", variant: "identical", note: "sanity check: same text must score 1.0" },
  { pairId: "pair-002", left: "t1", right: "t2", label: "duplicate", variant: "translation", note: "EN <-> ZH translation of the same announcement" },
  { pairId: "pair-003", left: "t1", right: "t3", label: "duplicate", variant: "translation", note: "EN <-> IT translation of the same announcement" },
  { pairId: "pair-004", left: "t1", right: "t4", label: "duplicate", variant: "paraphrase", note: "reworded copy of the same announcement" },
  { pairId: "pair-005", left: "t1", right: "t5", label: "duplicate", variant: "syndication", note: "syndicated copy with boilerplate suffix" },
  { pairId: "pair-006", left: "t2", right: "t3", label: "duplicate", variant: "translation", note: "ZH <-> IT translation of the same announcement" },
  { pairId: "pair-007", left: "t3", right: "t4", label: "duplicate", variant: "translation", note: "IT translation vs EN paraphrase of the same announcement" },
  { pairId: "pair-008", left: "t1", right: "t6", label: "distinct", variant: "same-topic-different", note: "announcement vs independent benchmark article" },
  { pairId: "pair-009", left: "t5", right: "t6", label: "distinct", variant: "same-topic-different", note: "syndicated copy vs independent benchmark article" },
  { pairId: "pair-010", left: "t2", right: "t6", label: "distinct", variant: "same-topic-different", note: "translation vs independent benchmark article" },
  { pairId: "pair-011", left: "t7", right: "t8", label: "distinct", variant: "same-topic-different", note: "official spec vs community explainer" },
  { pairId: "pair-012", left: "t7", right: "t9", label: "distinct", variant: "same-topic-different", note: "transport spec vs reconnection detail page" },
  { pairId: "pair-013", left: "t8", right: "t9", label: "distinct", variant: "same-topic-different", note: "two different MCP transport articles" },
  { pairId: "pair-014", left: "t7", right: "t10", label: "distinct", variant: "same-topic-different", note: "transport docs vs security guidance" },
  { pairId: "pair-015", left: "t11", right: "t12", label: "distinct", variant: "same-topic-different", note: "pricing page vs rate limit page" },
  { pairId: "pair-016", left: "t10", right: "t11", label: "distinct", variant: "unrelated", note: "security guidance vs pricing" },
  { pairId: "pair-017", left: "t12", right: "t9", label: "distinct", variant: "same-topic-different", note: "rate limits vs SSE reconnection" },
  { pairId: "pair-018", left: "t13", right: "t14", label: "distinct", variant: "unrelated", note: "weather vs mathematics" },
  { pairId: "pair-019", left: "t15", right: "t16", label: "distinct", variant: "unrelated", note: "baking vs motorsport" },
  { pairId: "pair-020", left: "t13", right: "t15", label: "distinct", variant: "unrelated", note: "weather vs baking" },
  { pairId: "pair-021", left: "t14", right: "t16", label: "distinct", variant: "unrelated", note: "mathematics vs motorsport" },
  { pairId: "pair-022", left: "t6", right: "t7", label: "distinct", variant: "unrelated", note: "model benchmarks vs MCP transports" },
  { pairId: "pair-023", left: "t1", right: "t7", label: "distinct", variant: "unrelated", note: "model announcement vs MCP transports" },
  { pairId: "pair-024", left: "t4", right: "t6", label: "distinct", variant: "same-topic-different", note: "paraphrased announcement vs benchmarks article" },
];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
function round(value, digits = 6) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function docText(candidateItem) {
  return [candidateItem.title, candidateItem.snippet, candidateItem.url]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("\n")
    .slice(0, RERANK_INPUT_CHARS);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return null;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

async function readExisting(name) {
  try {
    return JSON.parse(await readFile(new URL(name, OUT_DIR), "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Section 1: rerank calibration
// ---------------------------------------------------------------------------------------------
async function rerankSection() {
  const existing = await readExisting("rerank-cases.json");
  const reuse = new Map();
  if (args.refresh !== true) {
    for (const item of existing?.cases ?? []) {
      const oldOk = item?.recorded?.old?.status === "ok";
      const newOk = item?.recorded?.new?.status === "ok";
      if (oldOk && newOk) reuse.set(item.id, item);
    }
  }
  const callsBefore = requests;
  const cases = [];
  let skipped = 0;
  let errors = 0;
  let budgetHit = false;

  for (const testCase of RERANK_CASES) {
    const reused = reuse.get(testCase.id);
    if (reused !== undefined) {
      cases.push({ ...testCase, recorded: reused.recorded });
      continue;
    }
    const documents = testCase.candidates.map((item) => ({ text: docText(item) }));
    const recorded = {};
    try {
      for (const [slot, model] of [["old", MODELS.rerankOld], ["new", MODELS.rerankNew]]) {
        const started = Date.now();
        let response;
        try {
          response = await postJson("/api/v1/rerank", {
            model,
            query: testCase.query,
            documents,
            top_n: documents.length,
          }, "rerank:" + testCase.id + ":" + slot);
        } catch (error) {
          if (error instanceof BudgetExceededError) throw error;
          recorded[slot] = { model, status: "error", elapsedMs: Date.now() - started, errorCode: error.status ?? 0, errorMessage: error.message };
          errors += 1;
          continue;
        }
        if (response.status !== 200) {
          recorded[slot] = { model, status: "skipped", elapsedMs: Date.now() - started, errorCode: response.status, errorMessage: "HTTP " + response.status };
          skipped += 1;
          continue;
        }
        const scores = {};
        for (const resultItem of response.body.results ?? []) {
          const source = testCase.candidates[resultItem.index];
          if (source !== undefined && typeof resultItem.relevance_score === "number") {
            scores[source.url] = round(resultItem.relevance_score);
          }
        }
        const ok = Object.keys(scores).length > 0;
        recorded[slot] = {
          model: response.body.model ?? model,
          status: ok ? "ok" : "error",
          elapsedMs: Date.now() - started,
          ...(ok ? {} : { errorMessage: "no valid relevance scores" }),
          scores,
        };
        if (!ok) errors += 1;
      }
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      budgetHit = true;
      recorded.old ??= { model: MODELS.rerankOld, status: "pending", elapsedMs: 0, errorMessage: "request budget exhausted" };
      recorded.new ??= { model: MODELS.rerankNew, status: "pending", elapsedMs: 0, errorMessage: "request budget exhausted" };
    }
    cases.push({ ...testCase, recorded });
  }

  for (const testCase of RERANK_CASES) {
    if (cases.some((item) => item.id === testCase.id)) continue;
    cases.push({
      ...testCase,
      recorded: {
        old: { model: MODELS.rerankOld, status: "pending", elapsedMs: 0, errorMessage: "not captured yet" },
        new: { model: MODELS.rerankNew, status: "pending", elapsedMs: 0, errorMessage: "not captured yet" },
      },
    });
  }
  cases.sort((left, right) => RERANK_CASES.findIndex((item) => item.id === left.id) - RERANK_CASES.findIndex((item) => item.id === right.id));

  const fixture = {
    schemaVersion: 1,
    datasetKind: "recorded",
    capturedAt: new Date().toISOString(),
    inputChars: RERANK_INPUT_CHARS,
    models: { old: MODELS.rerankOld, new: MODELS.rerankNew },
    budget: { maxRequests: MAX_REQUESTS },
    cases,
  };
  await writeFile(new URL("rerank-cases.json", OUT_DIR), JSON.stringify(fixture, null, 2) + "\n");
  return {
    file: "test/fixtures/rerank-cases.json",
    cases: cases.length,
    okOld: cases.filter((item) => item.recorded?.old?.status === "ok").length,
    okNew: cases.filter((item) => item.recorded?.new?.status === "ok").length,
    calls: requests - callsBefore,
    skipped,
    errors,
    budgetHit,
  };
}

// ---------------------------------------------------------------------------------------------
// Section 2: docs-intent decisions
// ---------------------------------------------------------------------------------------------
async function decisionsSection(production) {
  const existing = await readExisting("decisions-docs-intent.json");
  const reuse = new Map();
  // Only reuse probabilities recorded against the exact same production prompt copy;
  // a promptVersion or question-hash change invalidates every cached sample.
  const reusableFormat = existing?.promptVersion === production.promptVersion
    && existing?.questionHash === production.questionHash;
  if (args.refresh !== true && reusableFormat) {
    for (const item of existing?.cases ?? []) {
      const okRuns = (item.runs ?? []).filter((run) => run.status === "ok").length;
      if (okRuns >= DECISION_REPEATS) reuse.set(item.id, item);
    }
  }
  const callsBefore = requests;
  const cases = [];
  let skipped = 0;
  let errors = 0;
  let budgetHit = false;

  for (const testCase of DECISION_CASES) {
    const reused = reuse.get(testCase.id);
    if (reused !== undefined) {
      cases.push({ ...testCase, runs: reused.runs });
      continue;
    }
    // Exactly what OpenRouterDecisions.classifyDocsIntent sends: state { query } and
    // questions.is_documentation = DOCS_INTENT_QUESTION (imported from dist).
    const state = { query: testCase.query };
    const runs = [];
    for (let repeat = 0; repeat < DECISION_REPEATS; repeat += 1) {
      const started = Date.now();
      try {
        const response = await postJson("/api/alpha/decisions", {
          model: MODELS.decisions,
          state,
          questions: { is_documentation: production.question },
        }, "decisions:" + testCase.id + ":r" + (repeat + 1));
        if (response.status !== 200) {
          runs.push({ status: "skipped", elapsedMs: Date.now() - started, errorCode: response.status });
          skipped += 1;
          if (response.status === 502) break;
          continue;
        }
        const answer = response.body.answers?.is_documentation;
        const probability = typeof answer?.noul === "number" ? answer.noul : undefined;
        const annotations = Array.isArray(response.body.annotations) ? response.body.annotations.length : 0;
        runs.push({
          status: probability === undefined ? "error" : "ok",
          ...(probability === undefined ? { errorMessage: "missing answers.is_documentation.noul" } : { probability: round(probability) }),
          annotations,
          elapsedMs: Date.now() - started,
          model: response.body.model,
        });
        if (probability === undefined) errors += 1;
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        budgetHit = true;
        runs.push({ status: "pending", elapsedMs: 0, errorMessage: "request budget exhausted" });
        break;
      }
    }
    cases.push({ ...testCase, runs });
    if (budgetHit) break;
  }

  for (const testCase of DECISION_CASES) {
    if (cases.some((item) => item.id === testCase.id)) continue;
    cases.push({ ...testCase, runs: [{ status: "pending", elapsedMs: 0, errorMessage: "not captured yet" }] });
  }
  cases.sort((left, right) => DECISION_CASES.findIndex((item) => item.id === left.id) - DECISION_CASES.findIndex((item) => item.id === right.id));

  const fixture = {
    schemaVersion: 1,
    datasetKind: "recorded",
    capturedAt: new Date().toISOString(),
    model: MODELS.decisions,
    endpoint: "/api/alpha/decisions",
    repeats: DECISION_REPEATS,
    // Drift guards: replay/accept compare these against the current dist build.
    promptVersion: production.promptVersion,
    questionHash: production.questionHash,
    promptSource: production.source,
    requestShape: { state: "object:{query}", questions: "object:{is_documentation:noul}", model: MODELS.decisions },
    deadBand: [production.vetoBelow, production.keepAbove],
    question: production.question,
    cases,
  };
  await writeFile(new URL("decisions-docs-intent.json", OUT_DIR), JSON.stringify(fixture, null, 2) + "\n");
  return {
    file: "test/fixtures/decisions-docs-intent.json",
    capturedCases: cases.filter((item) => (item.runs ?? []).some((run) => run.status === "ok")).length,
    totalCases: cases.length,
    okRuns: cases.reduce((sum, item) => sum + (item.runs ?? []).filter((run) => run.status === "ok").length, 0),
    calls: requests - callsBefore,
    skipped,
    errors,
    budgetHit,
  };
}

// ---------------------------------------------------------------------------------------------
// Section 3: semantic pairs (individual embeddings)
// ---------------------------------------------------------------------------------------------
async function semanticSection() {
  const existing = await readExisting("semantic-capture.json");
  const existingPairs = new Map();
  if (args.refresh !== true) {
    for (const pair of existing?.pairs ?? []) {
      if (pair.status === "ok" && typeof pair.cosine === "number") existingPairs.set(pair.pairId, pair);
    }
  }
  // The fixture only stores cosines, so a complete fixture cannot be topped up without
  // re-embedding. Skip the whole section instead of re-billing an already complete run.
  if (
    args.refresh !== true
    && existing?.model === MODELS.embed
    && SEMANTIC_PAIRS.every((pair) => existingPairs.has(pair.pairId))
  ) {
    return {
      file: "test/fixtures/semantic-capture.json",
      reused: true,
      texts: (existing.texts ?? []).filter((item) => item.status === "ok").length,
      totalTexts: SEMANTIC_TEXTS.length,
      pairs: existingPairs.size,
      totalPairs: SEMANTIC_PAIRS.length,
      calls: 0,
      skipped: 0,
      errors: 0,
      budgetHit: false,
    };
  }
  const callsBefore = requests;
  let skipped = 0;
  let errors = 0;
  let budgetHit = false;
  const vectors = new Map();
  const texts = [];

  for (const textItem of SEMANTIC_TEXTS) {
    const started = Date.now();
    try {
      const response = await postJson("/api/v1/embeddings", {
        model: MODELS.embed,
        input: [textItem.text],
      }, "embeddings:" + textItem.id);
      if (response.status !== 200) {
        texts.push({ id: textItem.id, status: "skipped", errorCode: response.status, elapsedMs: Date.now() - started });
        skipped += 1;
        if (response.status === 502) {
          const index = SEMANTIC_TEXTS.indexOf(textItem);
          for (const remaining of SEMANTIC_TEXTS.slice(index + 1)) {
            texts.push({ id: remaining.id, status: "skipped", errorCode: 502, elapsedMs: 0 });
            skipped += 1;
          }
          break;
        }
        continue;
      }
      const vector = response.body.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        texts.push({ id: textItem.id, status: "error", errorMessage: "missing embedding array", elapsedMs: Date.now() - started });
        errors += 1;
        continue;
      }
      vectors.set(textItem.id, vector);
      texts.push({
        id: textItem.id,
        status: "ok",
        dimension: vector.length,
        sha256: sha256(textItem.text),
        elapsedMs: Date.now() - started,
        model: response.body.model,
      });
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      budgetHit = true;
      const index = SEMANTIC_TEXTS.indexOf(textItem);
      texts.push({ id: textItem.id, status: "pending", elapsedMs: 0 });
      for (const remaining of SEMANTIC_TEXTS.slice(index + 1)) {
        texts.push({ id: remaining.id, status: "pending", elapsedMs: 0 });
      }
      break;
    }
  }

  for (const textItem of SEMANTIC_TEXTS) {
    if (texts.some((item) => item.id === textItem.id)) continue;
    texts.push({ id: textItem.id, status: "pending", elapsedMs: 0, errorMessage: "not captured yet" });
  }
  texts.sort((left, right) => SEMANTIC_TEXTS.findIndex((item) => item.id === left.id) - SEMANTIC_TEXTS.findIndex((item) => item.id === right.id));
  const textById = new Map(SEMANTIC_TEXTS.map((item) => [item.id, item.text]));

  const pairs = SEMANTIC_PAIRS.map((pair) => {
    const left = vectors.get(pair.left);
    const right = vectors.get(pair.right);
    const value = left !== undefined && right !== undefined ? cosine(left, right) : null;
    return {
      ...pair,
      leftText: textById.get(pair.left),
      rightText: textById.get(pair.right),
      status: value === null ? "skipped" : "ok",
      ...(value === null ? {} : { cosine: round(value) }),
      ...(left !== undefined ? { dimension: left.length } : {}),
    };
  });

  const fixture = {
    schemaVersion: 1,
    datasetKind: "recorded",
    capturedAt: new Date().toISOString(),
    model: MODELS.embed,
    embeddingMode: "one-text-per-call",
    texts: texts.map((item) => {
      if (item.status !== "ok") return item;
      return { id: item.id, status: item.status, dimension: item.dimension, sha256: item.sha256, elapsedMs: item.elapsedMs, model: item.model };
    }),
    pairs,
  };
  await writeFile(new URL("semantic-capture.json", OUT_DIR), JSON.stringify(fixture, null, 2) + "\n");
  return {
    file: "test/fixtures/semantic-capture.json",
    texts: texts.filter((item) => item.status === "ok").length,
    totalTexts: texts.length,
    pairs: pairs.filter((item) => item.status === "ok").length,
    totalPairs: pairs.length,
    calls: requests - callsBefore,
    skipped,
    errors,
    budgetHit,
  };
}

// ---------------------------------------------------------------------------------------------
// Plan / dry run
// ---------------------------------------------------------------------------------------------
function plan() {
  return {
    budget: { maxRequests: MAX_REQUESTS, minGapMs: MIN_REQUEST_GAP_MS, timeoutMs: REQUEST_TIMEOUT_MS },
    sections: {
      rerank: { cases: RERANK_CASES.length, calls: RERANK_CASES.length * 2 },
      decisions: {
        cases: DECISION_CASES.length,
        repeats: DECISION_REPEATS,
        calls: DECISION_CASES.length * DECISION_REPEATS,
        requiresBuild: true,
        // Question copy + promptVersion come from dist so the fixture cannot drift from prod.
        promptSource: "dist/providers/openrouter-decisions.js + dist/docs-intent.js",
      },
      semantic: { texts: SEMANTIC_TEXTS.length, pairs: SEMANTIC_PAIRS.length, calls: SEMANTIC_TEXTS.length },
    },
    files: [
      "test/fixtures/rerank-cases.json",
      "test/fixtures/decisions-docs-intent.json",
      "test/fixtures/semantic-capture.json",
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
if (args.dryRun) {
  process.stdout.write(JSON.stringify({ dryRun: true, ...plan() }, null, 2) + "\n");
  process.exit(0);
}

await mkdir(OUT_DIR, { recursive: true });
const summary = { startedAt: new Date().toISOString(), sections: {} };
const startedAll = Date.now();

let productionDecisions = null;
if (sections.includes("decisions")) {
  productionDecisions = await loadProductionDecisionsPrompt();
  if (productionDecisions === null) {
    console.error("decisions capture needs the built dist production prompt; run npm run build first (DOCS_INTENT_QUESTION / PROMPT_VERSION / dead-band constants not found in dist).");
    process.exit(2);
  }
  summary.decisionsPrompt = {
    promptVersion: productionDecisions.promptVersion,
    questionHash: productionDecisions.questionHash,
    source: productionDecisions.source,
  };
}

for (const section of ["rerank", "decisions", "semantic"]) {
  if (!sections.includes(section)) continue;
  const fn = section === "rerank" ? rerankSection : section === "decisions" ? decisionsSection : semanticSection;
  try {
    summary.sections[section] = await fn(section === "decisions" ? productionDecisions : undefined);
  } catch (error) {
    summary.sections[section] = { status: "failed", error: error && error.message ? error.message : String(error) };
    if (error instanceof BudgetExceededError) break;
  }
}

summary.requests = requests;
summary.retries = retries;
summary.budget = MAX_REQUESTS;
summary.elapsedMs = Date.now() - startedAll;
summary.finishedAt = new Date().toISOString();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
if (Object.values(summary.sections).some((section) => section.status === "failed")) process.exit(1);
