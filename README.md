# DeepSeek Web Search MCP

[![M8ven Verified](https://m8ven.ai/badge/mcp/zouyuanqing/deepseek-web-search-mcp?variant=verified)](https://m8ven.ai/mcp/zouyuanqing/deepseek-web-search-mcp)

一个独立的 stdio MCP 服务器，向 Codex 等客户端暴露两个工具：

- `web_search`：保留 AnySearch、SearXNG、Tavily 外部源，也可把 DeepSeek 原生搜索
  作为第四个源加入同一候选池，再统一去重、融合和排序。
- `web_research`：通过 DeepSeek 官方 Anthropic 兼容 Messages API 调用
  `web_search_20250305`，返回回答、结构化来源和引用摘要。

## DeepSeek 协议

DeepSeek Responses API 当前会静默忽略 `web_search`。正确入口是：

```text
https://api.deepseek.com/anthropic/v1/messages
```

请求使用 `web_search_20250305` 服务端工具。只有响应中存在
`web_search_tool_result` 才视为搜索成功；DSML、模型自述或普通文本都不能作为
搜索成功证据。

实现契约参考 DeepSeek 官方 Harness 的
`@deepseek-ai/dsh-web-search-deepseek` 包。

仓库不包含 API Key、服务器地址、用户名或私钥。所有凭据均从进程环境读取。

## 构建

```powershell
npm install
npm run build
npm test
```

质量计划的离线 replay 使用无密钥 fixture，不会调用线上 provider：

```powershell
npm run quality:replay
```

结果写入 `work/quality/baseline-report.json`。fixture 保存各 provider 的原始顺序、
状态、延迟、来源和可选 rerank 结果，用于比较当前 baseline 与 provider-aware RRF
shadow challenger；shadow 结果不会改变 MCP 生产返回。

需要采集真实四路原始运行时数据时执行：

```powershell
npm run quality:capture -- "your query"
```

结果写入被 `.gitignore` 排除的 `work/quality/runtime/latest.json`，不会把真实
provider 响应或凭据提交到仓库。

## 配置

复制 `.env.example` 中的变量到进程环境或 Windows 用户环境。至少需要：

- `DEEPSEEK_API_KEY`：`web_research`、`web_search(backend="hybrid")` 和
  `web_search(backend="deepseek-native")`
- `WEB_SEARCH_BACKEND`：`web_search` 的默认后端，可选 `auto`（默认）、
  `external`、`hybrid` 或 `deepseek-native`
- `ANYSEARCH_API_KEY`：可选，匿名模式限额更低
- `TAVILY_API_KEY`：全球搜索
- `OPENROUTER_API_KEY`：`web_search(rerank=true)` 使用的可选重排
- `SEARXNG_URL`：自建实例地址

`DEEPSEEK_SEARCH_BASE_URL` 是 Anthropic SDK 的 base URL，SDK 会自动追加
`/v1/messages`。默认值是 `https://api.deepseek.com/anthropic`。

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
- `hybrid`：并行查询外部 provider 和 DeepSeek 原生搜索，把四路结果合并为
  同一个候选池；`quality: "balanced"` / `"deep"` 时四路一起进入 rank fusion。
- `deepseek-native`：调用与 `web_research` 相同的 DeepSeek 原生搜索，
  返回 `mode: "native"`、模型回答和带 `provider: "deepseek-native"` 的来源。
- `auto`：有 `DEEPSEEK_API_KEY` 时等价于 `hybrid`；没有 key 时等价于
  `external`。原生一路失败不会丢掉其他 provider 的结果。

不传 `backend` 时使用 `WEB_SEARCH_BACKEND`；未设置该变量时使用 `auto`，有
DeepSeek key 的客户端默认会把 native 纳入四源候选池。完全保持旧的外部-only
行为时设置 `WEB_SEARCH_BACKEND=external` 或传 `backend: "external"`。示例环境
默认设为 `hybrid`，方便直接体验四源融合。
`deepseek-native` 不执行 OpenRouter rank fusion；`hybrid` 只有在
`quality: "balanced"` / `"deep"` 或旧 `rerank: true` 时才执行外部重排。

原生接口没有与本项目 `scope` / `freshness` 完全等价的过滤参数。`scope`
仍按查询语言解析并原样返回；`freshness` 会作为查询提示传给原生搜索，但不应
被理解为严格的服务端时间过滤。需要完全排除 DeepSeek native 时使用 `external`；
需要保留 native 参与统一融合时使用 `hybrid` 或默认 `auto`。

## 隐私

本项目不收集也不上传任何遥测数据。查询只会发送给你自己配置的检索/重排提供商，
凭据仅从进程环境读取，缓存只存在于内存。详见 [PRIVACY.md](./PRIVACY.md)。

## 本地运行

```powershell
npm run doctor -- --json
node dist/index.js
```

`--doctor` 只在终端输出各 provider 的健康状态，不会把健康检查注册成第三个
MCP 工具。

搜索查询会发送给用户配置的搜索提供商；选择 `hybrid`、`deepseek-native` 或
`auto` 时，查询还会发送给 DeepSeek；启用外部重排后，候选结果摘要还会发送给
OpenRouter。项目本身不包含遥测。

## 质量控制与融合重排

`web_search` 未配置后端时默认使用 `quality: "fast"` 和 `backend: "auto"`；有
DeepSeek key 时会把 native 加入多源候选池，没有 key 时退回 external。启用外部
重排后，候选结果摘要才会发送给 OpenRouter。

| quality | provider 候选 | 候选目标 | 行为 |
| --- | ---: | ---: | --- |
| `fast` | 每路 10 | 10 | 按 provider 顺序降级，不重排 |
| `balanced` | 每路 10 | 20 | 并行检索、重排并做 50/50 rank fusion |
| `deep` | 每路 15 | 30 | 更大候选集、重排并做 50/50 rank fusion |

在 `backend: "hybrid"` / 默认 `auto` 且存在 DeepSeek key 时，上表中的“每路”包含
`deepseek-native`；候选源采用轮询合并，避免某一 provider 填满前 `max_results`
而把 native 源挤掉。

重排使用 OpenRouter 的
`nvidia/llama-nemotron-rerank-vl-1b-v2:free`。融合同时保留原始排名和重排排名，
并按重排置信度缩放重排贡献：低于 `0.35` 的结果不获得重排分，`0.35` 到 `1`
之间线性缩放，避免“噪声但排名靠前”压过可靠候选。原始第一名只有达到
`0.50` 的重排相关性才会触发 top-1 保护；重排胜者若要凭权威性替换第一名，也
必须达到同一相关性下限。官方域名只获得有限先验，不能凭 URL 形态绕过重排置信度。

```json
{
  "query": "DeepSeek Responses API web_search 是否已经失效",
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
