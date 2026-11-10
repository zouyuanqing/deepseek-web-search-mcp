# Security

## Secrets

Never commit API keys, `.env` files, deployment credentials, or private
infrastructure addresses. The server reads all credentials from environment
variables.

Use `.env.example` as the list of supported variables. Real values should be
stored in the operating system's user environment or a secret manager.

## Network boundaries

The bundled SearXNG deployment binds to `127.0.0.1` by default. If it is exposed
to a LAN, set `SEARXNG_BIND_IP`, `SEARXNG_BASE_URL`, and
`SEARXNG_LAN_CIDR` explicitly. Do not expose SearXNG directly to the public
internet.

## Data handling

Search queries are sent to the configured search providers. `web_search` with
`backend: "deepseek-search"`, `"hybrid"`, or `"auto"` (when `DEEPSEEK_API_KEY`
is set) sends the query to the DeepSeek official Search API at
`DEEPSEEK_SEARCH_API_BASE_URL` (default `https://api.deepseek.com/v1`, endpoint
`/tools/search`). `web_research`, `research_start` / `research_followup`, and
`web_search` with `backend: "deepseek-native"` send the query to the DeepSeek
Anthropic-compatible Messages API at `DEEPSEEK_SEARCH_BASE_URL` (default
`https://api.deepseek.com/anthropic`, endpoint `/v1/messages`). With
`DEEPSEEK_SEARCH_NEED_CONTENT=on`, Search API responses also include page
content. Rank fusion sends candidate titles, URLs, and snippets to OpenRouter.
Do not enable `quality: "balanced"` or `quality: "deep"` for queries that must
remain local. Search and rerank caches are in memory only and are discarded
when the MCP process exits.

## Reporting

Open a private security advisory in the GitHub repository for suspected
credential leaks or vulnerabilities.
