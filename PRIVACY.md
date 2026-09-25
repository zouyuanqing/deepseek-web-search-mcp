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
| `web_search` (`fast`, auto/hybrid) | the query string | all selected external providers and, when configured, DeepSeek |
| `web_search` via AnySearch | the query string | `ANYSEARCH_MCP_URL` (default `api.anysearch.com`) |
| `web_search` via SearXNG | the query string | `SEARXNG_URL` (your own instance by default) |
| `web_search` via Tavily | the query string | `api.tavily.com` |
| `web_search` (`backend: "hybrid"`) | the query | the selected external providers and `DEEPSEEK_SEARCH_BASE_URL` |
| `web_search` (`balanced`, `deep`) | the query plus candidate titles, URLs, and snippets | `openrouter.ai` for reranking |
| `web_search` (`backend: "deepseek-native"`) | the query | `DEEPSEEK_SEARCH_BASE_URL` (default `api.deepseek.com`) |
| `web_search` (`backend: "auto"`) | the query to DeepSeek and/or the selected external providers depending on configuration | DeepSeek and/or the selected external provider |
| `web_research` | the query | `DEEPSEEK_SEARCH_BASE_URL` (default `api.deepseek.com`) |
| `research_start` / `research_followup` | the research question or follow-up question | `DEEPSEEK_SEARCH_BASE_URL` and, on fallback, configured external providers |

No other network calls are made. In particular there is no analytics, no crash
reporting, and no update check.

## Credentials

API keys are read from environment variables at run time (see `.env.example`).
They are never hardcoded, never written to disk by this project, and never sent
anywhere except the provider they belong to.

## Local storage and retention

Search, rerank, and research-session state are held in memory only and are discarded when the MCP
process exits. The server does not write query data to disk. Retention on the
provider side is governed by each provider's own policy:

- DeepSeek: https://platform.deepseek.com/ (privacy policy linked from the site)
- AnySearch: https://api.anysearch.com
- Tavily: https://tavily.com/privacy
- OpenRouter: https://openrouter.ai/privacy
- SearXNG: your own deployment, your own policy

## Your controls

- Disable reranking by keeping `quality: "fast"` (the default) so candidates are
  never sent to OpenRouter.
- Keep `WEB_SEARCH_BACKEND=external`, or pass `backend: "external"`, to keep
  `web_search` queries away from DeepSeek. The default `auto` mode uses the
  native source when `DEEPSEEK_API_KEY` is configured.
- Use `backend: "hybrid"` when you want DeepSeek native search to participate
  alongside AnySearch, SearXNG, and Tavily in the same candidate pool.
- Use `backend: "deepseek-native"` only when you intend to send `web_search`
  queries to DeepSeek's native search endpoint.
- Point `SEARXNG_URL` at a self-hosted instance to keep queries inside your own
  infrastructure.
- Unset a provider's API key to remove that provider from the fallback chain.
- Run the server offline: without any provider credentials configured, no
  outbound requests succeed and no query data leaves the machine.

## Contact

Questions or corrections: open an issue in the GitHub repository. Suspected
credential leaks or vulnerabilities should go through a private security
advisory as described in `SECURITY.md`.
