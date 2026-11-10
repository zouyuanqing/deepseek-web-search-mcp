# DeepSeek Web Search MCP

[![M8ven Verified](https://m8ven.ai/badge/mcp/zouyuanqing/deepseek-web-search-mcp?variant=verified)](https://m8ven.ai/mcp/zouyuanqing/deepseek-web-search-mcp)

一个独立的 stdio MCP 服务器，向 Codex 等客户端暴露搜索、研究和多轮研究工具：

- `web_search`：原生检索调用 DeepSeek 官方 Search API
  （`POST /v1/tools/search`），返回结构化来源、不含模型回答；也可与 AnySearch、
  SearXNG、Tavily 外部源合并为同一候选池，再统一去重、融合和排序。旧的
  Anthropic Messages 原生搜索路径（`deepseek-native`）保留兼容。
- `web_research`：通过 DeepSeek 官方 Anthropic 兼容 Messages API 调用
  `web_search_20250305`，返回回答、结构化来源和引用摘要（legacy 研究路径）。
- `research_start` / `research_followup` / `research_close`：带 TTL 和最大轮数的
  内存研究 session，用于多轮追问。

## DeepSeek 协议

DeepSeek 自 2026-10-17 起开放官方 Search & Fetch API。v1.6.0 起，`web_search`
新增官方 Search API 后端（`deepseek-search`），并成为默认 `auto` / `hybrid` 中
唯一的 DeepSeek 原生检索来源；旧的模型搜索保留为 legacy `deepseek-native`。

官方 Search API 直接返回结构化结果，不经过模型、不产生模型轮次：

```text
POST https://api.deepseek.com/v1/tools/search
```

需要模型撰写回答的场景仍走 Anthropic 兼容 Messages API：

```text
POST https://api.deepseek.com/anthropic/v1/messages
```

请求使用 `web_search_20250305` 服务端工具，返回模型回答、
`web_search_tool_result` 块和 citations。只有响应中存在
`web_search_tool_result` 才视为搜索成功；DSML、模型自述或普通文本都不能作为
搜索成功证据。`web_research` 与 `research_start` / `research_followup` 继续
使用这条路径；显式 `backend: "deepseek-native"` 也仍走它，用于兼容旧客户端。
Fetch 端点本项目不调用，也不注册为 MCP 工具。

| 路径 | 端点 | 使用场景 |
| --- | --- | --- |
| 官方 Search API（推荐） | `POST https://api.deepseek.com/v1/tools/search` | `web_search(backend="deepseek-search")`、`hybrid` 候选池、默认 `auto` |
| Anthropic 兼容 Messages API（legacy） | `POST https://api.deepseek.com/anthropic/v1/messages` | `web_research`、`research_*`、显式 `deepseek-native` |

Responses API 现已支持 `deepseek-v4-pro` 的服务端 `web_search_call`，但本项目不
使用 Responses API；旧版 README 中"Responses API 会静默忽略 `web_search`"的说法
只描述当时状态，不再是当前事实。

Messages 路径的实现契约参考 DeepSeek 官方 Harness 的
`@deepseek-ai/dsh-web-search-deepseek` 包。

仓库不包含 API Key、服务器地址、用户名或私钥。所有凭据均从进程环境读取。

## DeepSeek 官方 Search API

`web_search(backend="deepseek-search")` 直接调用官方 Search API，只做检索和结果
归一化，不产生模型回答。

### 请求与响应

端点：`POST https://api.deepseek.com/v1/tools/search`

请求头：

```text
Authorization: Bearer <DEEPSEEK_API_KEY>
Content-Type: application/json
```

请求示例：

```json
{
  "query": "site:api-docs.deepseek.com after:2026-01-01 DeepSeek search API",
  "count": 5,
  "need_content": false
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `query` | string，必填 | 1–128 个 Unicode 字符，不能全为空白，支持查询运算符 |
| `count` | integer | 返回条数，1–50，默认 10；不影响计费 |
| `ori_question` | string | 可选，原始问题，1–128 个字符 |
| `localization` | string | 可选，IP 形式的地域提示 |
| `need_content` | boolean | 默认 `false`；为 `false` 时结果中的 `content` 始终为空 |

本项目当前只发送 `query`、`count`（由 `max_results` 与 `quality` 的每路候选
上限共同决定）和 `need_content`；
`ori_question` 与 `localization` 是官方 API 的可用字段，尚未暴露为工具参数。

当 `DEEPSEEK_SEARCH_NEED_CONTENT=on` 时，响应中的页面正文 `content`（Markdown，
保留换行）会原样映射为来源的 `content` 字段；响应体积可能明显变大，单价不变。

query 超过 128 字符时会被截断到上限；需要附加 freshness 的 `after:` 运算符时，
按包含运算符的总长度 128 字符截断。发生截断时返回的 `warnings` 会说明。

响应示例：

```json
{
  "results": [
    {
      "rerank_score": 2.31,
      "title": "DeepSeek Search API",
      "url": "https://api-docs.deepseek.com/guides/search",
      "snippet": "…100–200 字符摘要…",
      "summary": "…600–800 字符摘要…",
      "content": "",
      "site_name": "DeepSeek API Docs",
      "site_icon": "https://api-docs.deepseek.com/favicon.ico",
      "date": "2026-10-17T00:00:00Z",
      "authority": 4
    }
  ]
}
```

- `rerank_score`：0–3，`>= 1.5` 视为高质量
- `snippet` 约 100–200 字符，`summary` 约 600–800 字符
- `date`：RFC3339 UTC 或 `null`
- `authority`：0–4 的权威性分级；`-1` 表示未知，`>= 3` 视为高权威，该分级会
  作为来源权威性信号参与 fast 清洗与 rank fusion；它只在聚合站/内容农场显式
  名单之后生效，不会把名单内域名重新提升为权威来源
- `results` 为空数组表示正常无匹配，不是错误

### 查询运算符

- `site:` / `-site:`：限定 / 排除站点
- `-term`：排除包含该词的页面
- `"exact phrase"` / `-"exact phrase"`：精确短语及其排除
- `lang:zh,en`：限定语言
- `after:2025` / `after:2025-01-01`：起始时间
- `before:2026` / `before:2026-06-01`：结束时间

`freshness` 的 `day` / `week` / `month` / `year` 会翻译为服务端
`after:YYYY-MM-DD` 运算符。

### 计费

- Search 与 Fetch 分别按 **$0.75 / 1,000 次成功请求** 计费。
- 只有 HTTP 200 且返回结果的请求计费；失败请求、空搜索结果和超时不计费。
- `count` 不影响单价。
- 通过 DeepSeek Harness、Claude Code、Codex 等服务端工具发起的请求同样按成功
  请求计费。

### 限流

账号级配额：Search 100 QPS、Fetch 25 QPS，两者额度独立；超限返回 429。

### 错误处理

错误响应使用 OpenAI 兼容格式。HTTP 状态码与建议处理：

| 状态 | 含义 | 处理 |
| --- | --- | --- |
| 400 | 请求非法 | 修正请求，不重试 |
| 401 | API Key 缺失或无效 | 修正凭据，不重试 |
| 402 | 余额不足 | 充值后重试 |
| 403 | Fetch 安全策略拒绝 | 不重试 |
| 404 | Fetch 无法获取目标 | 不重试 |
| 408 | 读取请求体超时 | 等待后重试 |
| 413 | 响应体过大 | 不重试 |
| 429 | QPS 超限 | 等待后重试 |
| 500 | 内部错误 | 等待后重试 |
| 504 | 下游超时 | 等待后重试 |

处理原则：408 / 429 / 5xx 等待并退避重试；402 充值；其他 4xx 不要重试。本项目
不自动重试：单独使用 `deepseek-search` 时会直接返回该 provider 的错误，并保留
`code`、HTTP `status` 与 `retryable` 元数据；在 `hybrid` / `auto` 中单个
provider 失败不会丢掉其他 provider 的结果。成功但无匹配时返回 `no_results`，提示
`No search results`，而不是误报"所有 provider 失败"。本项目只集成 Search；403、
404、413 是 Fetch 端点的状态码，此处按官方统一错误码表列出，供参考。

## 构建

```powershell
npm install
npm run build
npm test
```

质量计划的离线 replay 使用无密钥 fixture，不会调用线上 provider：

```powershell
npm run quality:fixture
npm run quality:replay
```

fixture 生成 70 个分层 synthetic query（30 development / 40 held-out）；结果写入
`work/quality/baseline-report.json`。
fixture 保存各 provider 的原始顺序、
状态、延迟、来源和可选 rerank 结果，用于比较当前 baseline 与 provider-aware RRF
shadow challenger；synthetic 数据只用于工程回归，不替代人工 relevance 标注，
shadow 结果不会改变 MCP 生产返回。

`npm run quality:summary` 打印各方法聚合指标和分类明细；`npm run quality:diff`
列出清洗后 nDCG@5 下降的具体 case；`node scripts/quality-inspect.mjs <caseId>`
打印单个 case 的输入、保留和被丢弃的来源。

除 `official` / `current` / `ambiguous` / `exploratory` 四类外，fixture 还包含两类
专门复现实测反馈的 held-out case：

- `syndication`：同一篇文章的 `/it/`、`/ar/`、`/en/` 多语言副本 + 跨域转载
- `aggregator-dominance`：聚合站排在官方文档页之前，且 rerank 给出与线上实测
  一致的低分（官方页 0.037 / 0.006）

需要采集真实四路原始运行时数据时执行：

```powershell
npm run quality:capture -- "your query"
```

结果写入被 `.gitignore` 排除的 `work/quality/runtime/latest.json`，不会把真实
provider 响应或凭据提交到仓库。

## 配置

复制 `.env.example` 中的变量到进程环境或 Windows 用户环境。至少需要：

- `DEEPSEEK_API_KEY`：`web_search(backend="deepseek-search")`、
  `web_search(backend="hybrid")` 的 DeepSeek 部分、`web_search(backend="deepseek-native")`、
  `web_research` 和 `research_*`。显式 `hybrid` 但未配置 key 时仍会返回外部
  provider 结果，并给出 `deepseek-search` 缺少凭据的 warning
- `WEB_SEARCH_BACKEND`：`web_search` 的默认后端，可选 `auto`（默认）、
  `external`、`deepseek-search`、`hybrid` 或 `deepseek-native`
- `FAST_CLEANING_MODE`：fast 清洗模式，可选 `shadow`（默认，只计算不改变结果）、
  `on` 或 `off`
- `FAST_DOMAIN_CAP`：fast 清洗的同域名保留上限，默认 `2`
- `DOCUMENTATION_QUERY_MODE`：官方文档/API/source code 类 query 的质量路由，
  默认 `fast`，避免低分第三方页面被 deep rerank 压过；可设为 `deep` opt-in
- `SOURCE_IDENTITY_MODE`：同一篇文章的重复来源折叠，默认 `on`；设为 `off` 恢复
  仅按精确 URL 去重的旧行为
- `SOURCE_IDENTITY_CROSS_HOST`：跨域转载检测，默认 `on`；设为 `off` 时只折叠
  同域的重复 URL 和多语言副本
- `SOURCE_IDENTITY_VERBOSE`：默认 `off`；设为 `on` 时在 `sourceIdentity.groups`
  中返回每个合并组的保留 URL、被合并 URL 和冲突标记
- `FRESHNESS_INTENT_WARNING`：默认 `on`。检测到时效性 query 但调用方没有主动
  使用 `strict` 时，返回一条建议性 warning（不改变本次请求行为）
- `RESEARCH_SESSION_TTL_MS`、`RESEARCH_SESSION_MAX_SESSIONS`、
  `RESEARCH_SESSION_MAX_TURNS`：研究 session 生命周期和容量
- `ANYSEARCH_API_KEY`：可选，匿名模式限额更低
- `TAVILY_API_KEY`：全球搜索
- `OPENROUTER_API_KEY`：`web_search(rerank=true)` 使用的可选重排
- `SEARXNG_URL`：自建实例地址

DeepSeek 官方 Search API 相关变量：

- `DEEPSEEK_SEARCH_API_BASE_URL`：官方 Search API 的 base URL，默认
  `https://api.deepseek.com/v1`；provider 会自动追加 `/tools/search`。
- `DEEPSEEK_SEARCH_API_TIMEOUT_MS`：Search API 请求超时，默认 `15000`。
- `DEEPSEEK_SEARCH_NEED_CONTENT`：默认 `off`。设为 `on` 时请求
  `need_content: true`，Search API 响应会包含页面正文（`content`），并原样映射为
  来源的 `content` 字段（Markdown，保留换行），响应体更大，但单价不变（仍按成功
  请求计费）。

legacy Anthropic Messages 路径相关变量，仅用于 `web_research`、`research_*` 和
显式 `backend: "deepseek-native"`：

- `DEEPSEEK_SEARCH_BASE_URL`：Anthropic SDK 的 base URL，SDK 会自动追加
  `/v1/messages`。默认值是 `https://api.deepseek.com/anthropic`。
- `DEEPSEEK_SEARCH_MODEL`：默认 `deepseek-flash`。`deepseek-flash` 是当前
  V4.1-Flash 的别名；`deepseek-v4-flash` 目前临时路由到同一模型。
- `DEEPSEEK_SEARCH_MAX_USES`：服务端搜索工具的最大调用次数，默认 `5`。
- `DEEPSEEK_SEARCH_MAX_TOKENS`：回答最大 token 数，默认 `4096`。
- `DEEPSEEK_SEARCH_TIMEOUT_MS`：Messages 请求超时，默认 `150000`，仅 legacy
  路径使用。

`freshness` 继续支持 `any/day/week/month/year`。`freshness_mode` 默认是 `soft`：
支持原生时间过滤的 provider 会传递时间范围，其他 provider 只提供查询提示并返回
未严格验证 warning。`strict` 模式只保留有可解析 `publishedAt` 且满足 cutoff 的来源。

调研快速演变的题目（模型版本、定价、发布说明、今天的状态）时建议显式传
`freshness_mode: "strict"`。`soft` 只给 warning，不会把无法证明时间的新来源剔除。

### 时效性建议

`web_search`、`web_research`、`research_start` 和 `research_followup` 都会检测
query 的时效性信号（`latest`、`current`、`changelog`、`version`、`最新`、`当前`、
`版本`、`实时` 等）。检测到信号但调用方没有使用 `strict` 时，返回一条明确的
建议 warning，并在 `freshness.intent` 中给出 `recommendedFreshness`。

本项目不会静默切换模式：warning 只提示应该传什么，本次请求仍按调用方传入的参数
执行。`FRESHNESS_INTENT_WARNING=off` 可关闭该提示。

## `web_search` 后端兼容

`web_search` 保留原有的 `SearchResult` 形状：始终返回 `query`、`scope`、
`provider`、`sources` 和 `warnings`。新增的 `backend` 只决定结果从哪里来：

```json
{
  "query": "DeepSeek web search API",
  "backend": "hybrid",
  "max_results": 5,
  "freshness": "week"
}
```

可选值：

- `external`：旧行为，按 provider 顺序使用 AnySearch、SearXNG、Tavily。
- `deepseek-search`（新）：只调用 DeepSeek 官方 Search API，返回结构化来源，
  没有模型回答、不产生模型轮次，速度更快；`quality: "balanced"` / `"deep"`
  时与外部 provider 一样进入 OpenRouter rank fusion；`freshness` 的
  `day` / `week` / `month` / `year` 会翻译为服务端 `after:YYYY-MM-DD` 查询
  运算符。
- `hybrid`：并行查询 AnySearch、SearXNG、Tavily 和 `deepseek-search`，把四路
  结果合并为同一个候选池；`quality: "balanced"` / `"deep"` 时四路一起进入
  rank fusion。`hybrid` 不再包含 legacy `deepseek-native` 模型路径，需要模型回答
  时请显式使用 `backend: "deepseek-native"`。
- `deepseek-native`（legacy）：调用与 `web_research` 相同的 Anthropic Messages
  原生搜索，返回 `mode: "native"`、模型回答和带 `provider: "deepseek-native"`
  的来源；为兼容旧客户端保留。
- `auto`：有 `DEEPSEEK_API_KEY` 时等价于 `hybrid`；没有 key 时等价于
  `external`。单个 provider 失败不会丢掉其他 provider 的结果。

不传 `backend` 时使用 `WEB_SEARCH_BACKEND`；未设置该变量时使用 `auto`，有
DeepSeek key 的客户端默认会把 DeepSeek 官方 Search 纳入四源候选池。完全保持旧
的外部-only 行为时设置 `WEB_SEARCH_BACKEND=external` 或传 `backend:
"external"`。示例环境默认设为 `hybrid`，方便直接体验四源融合。
`deepseek-native` 不执行 OpenRouter rank fusion；`hybrid` / `deepseek-search`
只有在 `quality: "balanced"` / `"deep"` 或旧 `rerank: true` 时才执行外部重排。

`scope` 仍按查询语言解析并原样返回。`deepseek-search` 会把 `freshness` 翻译成
Search API 的 `after:YYYY-MM-DD` 查询运算符（原生服务端过滤）；legacy
`deepseek-native` 只把 `freshness` 作为查询提示传给 Messages 原生搜索，不应被
理解为严格的服务端时间过滤。需要完全排除 DeepSeek 时使用 `external`；需要
DeepSeek 官方 Search 参与统一融合时使用 `hybrid` 或默认 `auto`；需要旧的模型
回答路径时显式使用 `deepseek-native`。

`deep` 仍表示多 provider 召回加一次 rerank，不表示多轮对话。多轮研究请使用
`research_start` 开启 session，再用 `research_followup` 继续，最后用
`research_close` 释放内存状态；MCP 进程重启会清空 session。

默认情况下，识别为官方文档/API/source code 的 query 会自动从 deep 路由到 fast，
并在 warnings 中说明。研究 follow-up 不再把上一轮模型答案原文拼回下一次搜索，
只保留来源 URL 作为检索提示；legacy `deepseek-native`（Messages 路径）会被要求
优先引用 primary/official source。

## 引用质量与来源独立性

合成答案里最常见的两个问题不是"排错了"，而是"同一篇文章被当成多个来源"和
"多源数字一致其实是互相抄"。1.5.0 起针对这两点做了显式处理。

### 同一篇文章只算一个来源

`SOURCE_IDENTITY_MODE=on`（默认）会在重排和 rerank **之前**折叠重复来源：

- 规范化 URL：去 tracking 参数、`/amp`、`index.html`、尾斜杠
- 折叠语言前缀：`/it/…`、`/ar/…`、`/en/…` 指向同一篇文章时合并为一条
- 折叠 `?lang=` / `?locale=` / `?hl=` 之类的语言参数
- 跨域转载检测：不同域名下 slug 相同且标题高度相似时合并

合并时保留低权威风险的一方（官方/文档站优先于未知域名，未知域名优先于聚合站和
内容农场），并只回填缺失字段，不会覆盖已保留来源自己的标题或日期。日期冲突会
计入 `sourceIdentity.conflictingDateCount` 并产生 warning，而不是静默选一个。

返回结构新增：

```json
{
  "sourceIdentity": {
    "applied": true,
    "inputCount": 5,
    "mergedCount": 2,
    "languageVariantCount": 1,
    "crossHostCopyCount": 1,
    "conflictingDateCount": 0,
    "independence": {
      "independentDomains": 2,
      "dominantDomainShare": 0.6,
      "lowAuthorityShare": 0.4,
      "level": "low"
    }
  }
}
```

`research_*` 系列的 `sourceQuality` 同时返回 `independentDomains` 和
`independence`，用于判断这个答案是"多源印证"还是"单一来源改写"。

### 聚合站和内容农场

`src/hosts.ts` 维护显式名单，包含实测中反复出现的内容农场
（`ofox.ai`、`techsy.io`、`taskade.com` 等）。名单内的域名：

- 永远不获得权威性加分
- fast 清洗中被乘性降权（系数 `0.35`）

乘性而非加性是有原因的：实测中排名第 1 的 Reddit 结果得分为
`1/1 + 0 − 0.12 = 0.88`，而排名第 2 的官方文档页只有
`1/2 + 0.7×0.4 = 0.78`——有界的加性惩罚**永远无法**把第一名挤下去。乘性降权
才可以让明确的低质信号压过更好的原始位置。

未知域名保持中立，不做猜测性惩罚。

## 隐私

本项目不收集也不上传任何遥测数据。查询只会发送给你自己配置的检索/重排提供商，
凭据仅从进程环境读取，缓存只存在于内存。详见 [PRIVACY.md](./PRIVACY.md)。

## 本地运行

```powershell
npm run doctor -- --json
node dist/index.js
```

`--doctor` 只在终端输出各 provider 的健康状态，不会把健康检查注册成额外的
MCP 工具。健康检查会真实调用各 provider（包括一次 DeepSeek Search API 请求；
成功请求按官方价格计费）。

搜索查询会发送给用户配置的搜索提供商；选择 `deepseek-search`、`hybrid`、
`deepseek-native`，或使用 `auto` 且配置了 `DEEPSEEK_API_KEY` 时，查询会发送给
DeepSeek：`deepseek-search` / `hybrid` 走官方 Search API
（`api.deepseek.com/v1/tools/search`），
`deepseek-native` 与 `web_research` 走 Anthropic 兼容 Messages API
（`api.deepseek.com/anthropic/v1/messages`）。设置
`DEEPSEEK_SEARCH_NEED_CONTENT=on` 时，Search API 请求会带 `need_content:
true`，响应中会附带页面正文。启用外部重排后，候选结果摘要还会发送给 OpenRouter。
项目本身不包含遥测。

## 质量控制与融合重排

`web_search` 未配置后端时默认使用 `quality: "fast"` 和 `backend: "auto"`；有
DeepSeek key 时会把 `deepseek-search` 加入多源候选池，没有 key 时退回 external。
启用外部重排后，候选结果摘要才会发送给 OpenRouter。

fast 默认使用 `FAST_CLEANING_MODE=shadow`：会计算权威性、聚合站降权、同域名
上限和 provider coverage，但不改变旧客户端的返回顺序。完成 held-out 评估后可
切换为 `on`；`off` 完全关闭清洗。

offline replay（`npm run quality:replay`，70 个 synthetic case）当前测得：

| 方法 | mean nDCG@5 | officialInTop1 | 重复来源占比 | 独立来源数 |
| --- | ---: | ---: | ---: | ---: |
| `current`（清洗前） | 0.9383 | 0.857 | 0.029 | 3.73 |
| `productionFast`（清洗+去重） | 0.9552 | 0.929 | 0.000 | 3.66 |

收益集中在实测反馈对应的两类 query：

- `aggregator-dominance`（聚合站排在官方页之前）：nDCG@5 0.7414 → 0.9949，
  `officialInTop1` 0 → 1
- `official` / `current` / `ambiguous` / `exploratory`：0.9811 → 0.9811，无回退
- `syndication`（同一文章多语言 + 跨域转载）：重复槽位占比降到 0，
  低权威来源占比 0.80 → 0.67

这些数字全部来自 **synthetic fixture**，只作为工程回归信号，不构成真实相关性
证明，因此 `FAST_CLEANING_MODE` 默认仍是 `shadow`；确认真实标注数据后可切到 `on`。
与之相对，`SOURCE_IDENTITY_MODE` 默认是 `on`，因为折叠"同一篇文章的重复 URL"是
正确性修复而不是排序偏好，不存在此消彼长的取舍。

| quality | provider 候选 | 候选目标 | 行为 |
| --- | ---: | ---: | --- |
| `fast` | 每路 10 | 10 | 按 provider 顺序降级，不重排 |
| `balanced` | 每路 10 | 20 | 并行检索、重排并做 50/50 rank fusion |
| `deep` | 每路 15 | 30 | 更大候选集、重排并做 50/50 rank fusion |

在 `backend: "hybrid"` / 默认 `auto` 且存在 DeepSeek key 时，上表中的“每路”包含
`deepseek-search`；候选源采用轮询合并，避免某一 provider 填满前 `max_results`
而把 DeepSeek 源挤掉。每路实际请求上限为 `min(20, max(max_results, 10/10/15))`，
因此 `max_results` 较大时 `count` 会高于表中数值。

重排使用 OpenRouter 的
`nvidia/llama-nemotron-rerank-vl-1b-v2:free`。融合同时保留原始排名和重排排名，
并按重排置信度缩放重排贡献：低于 `0.35` 的结果不获得重排分，`0.35` 到 `1`
之间线性缩放，避免“噪声但排名靠前”压过可靠候选。原始第一名只有达到
`0.50` 的重排相关性才会触发 top-1 保护；重排胜者若要凭权威性替换第一名，也
必须达到同一相关性下限。官方域名只获得有限先验，不能凭 URL 形态绕过重排置信度。

```json
{
  "query": "DeepSeek 官方 Search API 如何计费",
  "scope": "global",
  "max_results": 8,
  "quality": "balanced",
  "backend": "external"
}
```

OpenRouter 缺 key、限流、超时或返回异常时，`web_search` 会回退到多 provider
原始顺序，并在结果中设置 `rerank.applied=false` 和 warning，不会让整次搜索失败。
旧的 `rerank: true` 仍作为兼容别名映射到 `balanced`；显式 `quality` 优先。

provider 搜索结果在进程内缓存 10 分钟，重排结果缓存 30 分钟，均采用有上限的
TTL/LRU，不写入磁盘。MCP 进程重启后缓存清空。嵌入模型不参与该链路。
