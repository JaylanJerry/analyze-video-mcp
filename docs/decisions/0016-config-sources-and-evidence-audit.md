# ADR 0016：配置源层叠、doctor 同源与审核证据门禁

- Status: Accepted
- Date: 2026-08-22

## Context

v0.6.0 让缺 Key 时工具仍挂载，并加了 `heard`/`seen` 门禁。实战仍有三类 P0：

1. 系统或用户环境里已有 `DASHSCOPE_API_KEY`，壳里 `--doctor` 通过，但 Codex 等宿主用干净 env 表启动 MCP 子进程，运行时仍 `CONFIG_MISSING`。`doctor` 当时直接读 `process.env.DASHSCOPE_API_KEY`，与 `loadConfig()` 不是同一函数，也无法读用户文件或 Windows 用户级环境。
2. 模型把「人群 / 相似服饰」写成「士兵」这类身份事实。
3. 在没有 OCR、字幕轨或覆盖率的情况下输出「所有字幕完全同步」。

批准 [`SPEC_V061.md`](../SPEC_V061.md)。0.7 的 `analyze_audio` / FFmpeg / `audit_media` 见 [`SPEC_V07.md`](../SPEC_V07.md)，本 ADR 明确推迟。

## Decision

1. 抽出唯一配置解析器。优先级：`--config` / `QWEN_CONFIG_FILE` → `process.env`（含 MCP `env`）→ `~/.analyze-video-mcp/config.env` → Windows 用户级环境变量。不把 Key 做成 Tool 字段或 `--api-key`。不自动加载 cwd `.env`。
2. `inspectConfig()` 供 doctor、启动日志和 `loadConfig()` 共用。只记录 `configured` + `source`，不记录值。
3. `CONFIG_MISSING` 带 `missing` 变量名和 `suggestion`。Agent 文本与 `structuredContent` 同步；值、路径、Key 仍脱敏。
4. 证据种类扩展为 `seen` / `heard` / `measured` / `inferred` / `cross_validated` / `uncertain`。身份与关系默认不得留在 `seen`/`heard`。本版无测量器，`measured` 降级。成功结果附带 `coverage` 与 sampled `subtitle_audit`；未完整验证时改写绝对结论。
5. 不新增 Tool，不引入 FFmpeg。本条维持 [ADR 0001](0001-specialized-single-tool-surface.md) 至 0.7 另批。

## Alternatives

1. 在 Tool 参数里传 API Key：拒绝；会进对话日志，且违反单 Tool 契约。
2. CLI `--api-key`：拒绝；出现在进程命令行。
3. doctor 继续只读 `process.env`：拒绝；正是 Codex 误报「已配置」的原因。
4. 本轮同时加 `analyze_audio` 与 FFmpeg：拒绝；新功能不能建立在未修好的配置与证据门禁上，且 FFmpeg 是新生产依赖。

## Consequences

- Codex 仍须在 MCP `env` 里写 Key，或改用 `--config` / 用户配置文件；层叠只降低「系统有 Key、子进程没有」的失败面。
- 测试默认关闭静默回退（`QWEN_DISABLE_CONFIG_FALLBACKS=1`），避免开发者本机用户环境里的真实 Key 让「缺 Key」用例变绿。
- 无 JSON 的散文回答仍是残余空窗；绝对结论改写对散文也会做。
- `structuredContent` 增加 `coverage` / `subtitle_audit` / `missing`；旧 Host 忽略未知字段。
