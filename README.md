# DeepSeek Web Search MCP

一个独立的 stdio MCP 服务器，向 Codex 等客户端暴露两个工具：

- `web_search`：AnySearch、SearXNG、Tavily 的统一原始检索接口。
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

## 配置

复制 `.env.example` 中的变量到进程环境或 Windows 用户环境。至少需要：

- `DEEPSEEK_API_KEY`：`web_research`
- `ANYSEARCH_API_KEY`：可选，匿名模式限额更低
- `TAVILY_API_KEY`：全球搜索
- `OPENROUTER_API_KEY`：`web_search(rerank=true)` 使用的可选重排
- `SEARXNG_URL`：自建实例地址

`DEEPSEEK_SEARCH_BASE_URL` 是 Anthropic SDK 的 base URL，SDK 会自动追加
`/v1/messages`。默认值是 `https://api.deepseek.com/anthropic`。

## 本地运行

```powershell
npm run doctor -- --json
node dist/index.js
```

`--doctor` 只在终端输出各 provider 的健康状态，不会把健康检查注册成第三个
MCP 工具。

搜索查询会发送给用户配置的搜索提供商；启用重排后，候选结果摘要还会发送给
OpenRouter。项目本身不包含遥测。

## 质量控制与融合重排

`web_search` 默认使用 `quality: "fast"`，保持快速的单 provider 降级模式，不把
查询或来源发送给 OpenRouter。

| quality | provider 候选 | 候选目标 | 行为 |
| --- | ---: | ---: | --- |
| `fast` | 每路 10 | 10 | 按 provider 顺序降级，不重排 |
| `balanced` | 每路 10 | 20 | 并行检索、重排并做 50/50 rank fusion |
| `deep` | 每路 15 | 30 | 更大候选集、重排并做 50/50 rank fusion |

重排使用 OpenRouter 的
`nvidia/llama-nemotron-rerank-vl-1b-v2:free`。融合同时保留原始排名和重排排名，
对官方域名给予有限先验，并保护原本可靠的第一名不被轻易降级。

```json
{
  "query": "DeepSeek Responses API web_search 是否已经失效",
  "scope": "global",
  "max_results": 8,
  "quality": "balanced"
}
```

OpenRouter 缺 key、限流、超时或返回异常时，`web_search` 会回退到多 provider
原始顺序，并在结果中设置 `rerank.applied=false` 和 warning，不会让整次搜索失败。
旧的 `rerank: true` 仍作为兼容别名映射到 `balanced`；显式 `quality` 优先。

provider 搜索结果在进程内缓存 10 分钟，重排结果缓存 30 分钟，均采用有上限的
TTL/LRU，不写入磁盘。MCP 进程重启后缓存清空。嵌入模型不参与该链路。
