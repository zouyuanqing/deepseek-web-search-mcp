# Privacy

This MCP server runs as a local stdio process that you configure and control.
The project itself has no backend, no accounts, and no telemetry.

## Data we collect

None. The maintainers do not receive queries, results, logs, credentials, or
usage statistics from your installation.

## What leaves your machine

Outbound traffic only happens when a tool is invoked, and only to endpoints you
configure:

| Tool / mode | Data sent | Destination |
| --- | --- | --- |
| `web_search` (`fast`, external-only) | the query string | the first working external provider below |
| `web_search` (`fast`, `auto` without `DEEPSEEK_API_KEY`) | the query string | the selected external providers |
| `web_search` via AnySearch | the query string | `ANYSEARCH_MCP_URL` (default `api.anysearch.com`) |
| `web_search` via SearXNG | the query string | `SEARXNG_URL` (your own instance by default) |
| `web_search` via Tavily | the query string | `api.tavily.com` |
| `web_search` (`backend: "deepseek-search"`) | the query string | the DeepSeek official Search API: `DEEPSEEK_SEARCH_API_BASE_URL` + `/tools/search` (default `https://api.deepseek.com/v1/tools/search`) |
| `web_search` (`backend: "hybrid"`) | the query string | the selected external providers and the DeepSeek official Search API |
| `web_search` (`backend: "deepseek-native"`) | the query string | the DeepSeek Anthropic-compatible Messages API: `DEEPSEEK_SEARCH_BASE_URL` + `/v1/messages` (default `https://api.deepseek.com/anthropic`) |
| `web_search` (`backend: "auto"`) | the query, to DeepSeek and/or the selected external providers depending on whether `DEEPSEEK_API_KEY` is set | the DeepSeek official Search API and/or the selected external providers |
| `web_search` (`balanced`, `deep`) | the query plus candidate titles, URLs, and snippets; in `hybrid` mode these candidates can include DeepSeek Search results | `openrouter.ai` for reranking |
| `web_research` | the query | the DeepSeek Messages API at `DEEPSEEK_SEARCH_BASE_URL` |
| `research_start` / `research_followup` | the research question or follow-up question | the DeepSeek Messages API and, on fallback, the configured external providers |

With `DEEPSEEK_SEARCH_NEED_CONTENT=on`, the Search API request sets
`need_content: true`, so the response includes page content. No additional user
data is sent; the response is simply larger.

No other network calls are made. In particular there is no analytics, no crash
reporting, and no update check.

## Credentials

API keys are read from environment variables at run time (see `.env.example`).
They are never hardcoded, never written to disk by this project, and never sent
anywhere except the provider they belong to.

## Local storage and retention

Search, rerank, and research-session state are held in memory only and are
discarded when the MCP process exits. The server does not write query data to
disk. Retention on the provider side is governed by each provider's own policy:

- DeepSeek (official Search API and Messages API): https://platform.deepseek.com/ (privacy policy linked from the site)
- AnySearch: https://api.anysearch.com
- Tavily: https://tavily.com/privacy
- OpenRouter: https://openrouter.ai/privacy
- SearXNG: your own deployment, your own policy

## Your controls

- Disable reranking by keeping `quality: "fast"` (the default) so candidates,
  including any DeepSeek Search results, are never sent to OpenRouter.
- Keep `WEB_SEARCH_BACKEND=external`, or pass `backend: "external"`, to keep
  `web_search` queries away from DeepSeek. The default `auto` mode uses the
  DeepSeek official Search API whenever `DEEPSEEK_API_KEY` is configured.
- Use `backend: "deepseek-search"` when you want only the DeepSeek official
  Search API (fast, structured sources, no model answer), and
  `backend: "hybrid"` when it should join AnySearch, SearXNG, and Tavily in the
  same candidate pool.
- Use `backend: "deepseek-native"` only when you intend to send `web_search`
  queries to the legacy DeepSeek Messages API model-search path.
- Keep `DEEPSEEK_SEARCH_NEED_CONTENT=off` (the default) so Search API responses
  do not include page content; `on` only makes responses larger and does not
  change the per-request price.
- Point `SEARXNG_URL` at a self-hosted instance to keep queries inside your own
  infrastructure.
- Unset a provider's API key to remove that provider from the fallback chain.
- Run the server offline: without any provider credentials configured, no
  outbound requests succeed and no query data leaves the machine.

## Contact

Questions or corrections: open an issue in the GitHub repository. Suspected
credential leaks or vulnerabilities should go through a private security
advisory as described in `SECURITY.md`.
