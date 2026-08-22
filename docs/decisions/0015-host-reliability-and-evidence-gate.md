# ADR 0015：宿主稳定挂载、证据门禁与安全默认

- Status: Accepted
- Date: 2026-08-22

## Context

v0.5.2 的上传、SSE 与脱敏已经能跑通：`npx → initialize → tools/list → 本地上传 → 百炼 → 文本`。实战失败集中在三处：

1. Codex 冷启动 `npx` 超过约 30 秒且未设 `startup_timeout_sec` 时，工具从当前任务消失。缺 Key 时 `createServer()` 在注册 Tool 前退出，宿主同样看不到 `analyze_video`。
2. 证据约束只拼在 user 文本里。`qwen3.5-omni-flash` 仍把视觉先验写成事实，并把「可能存在」写进实测声音。
3. 未设 `QWEN_ALLOWED_ROOTS` 时任意绝对 MP4 可上传；进程内上传缓存随 MCP 重启丢失；Agent 只能看到「视频分析失败。」

批准 [`SPEC_V06.md`](../SPEC_V06.md)。

## Decision

1. 安装模板钉 `analyze-video-mcp@0.6.0`，Codex 加 `startup_timeout_sec = 120`、`tool_timeout_sec = 1200`、`--prefer-offline`，并填写 `QWEN_ALLOWED_ROOTS`。
2. MCP 进程在配置错误时仍握手并注册 `analyze_video`。Key / 端点 / 允许根在 tool 调用时验证，返回 `CONFIG_MISSING`。提供 `--doctor --json`。
3. 默认模型改为 `qwen3.5-omni-plus`；`qwen3.5-omni-flash` 作为 `QWEN_MODEL` 省钱档。证据政策进 system message。要求 JSON 观察结构；`heard`/`seen` 不得带推测用语；违规纠错一次后降级。成功 text 仍是 `answer`。
4. 不增加 `start_seconds` / `end_seconds`，不引入 FFmpeg。文档要求短片段；本地时长大于 120 秒时追加宏观分析提示。
5. 成功的 `oss://` 按文件身份 + 模型 + 上传端点持久化 47 小时；`QWEN_UPLOAD_CACHE=off` 关闭。仍不缓存 credential。本条取代 [ADR 0013](0013-upload-cache-and-host-server-name.md) 中「拒绝磁盘缓存」。
6. 错误同时返回安全 `structuredContent`（code / stage / retryable / http_status）。
7. 未设 `QWEN_ALLOWED_ROOTS` 时拒绝本地文件，只允许 HTTPS。本条恢复 [ADR 0004](0004-default-deny-local-media-access.md) 的默认拒绝，并取代 [ADR 0010](0010-npx-install-and-optional-roots.md) §2。

## Alternatives

1. 保持启动时 `loadConfig()` 硬退出：拒绝；宿主把这显示成「没有这个工具」。
2. 给 Tool 增加 `start_seconds`/`end_seconds` 并切段：拒绝本轮；需要 FFmpeg 或自研 demux，违反无新生产依赖，且 [API_CONTRACT.md](../API_CONTRACT.md) 把新字段视为公开 API 变更。
3. 强制模型 JSON，散文即失败：拒绝；会把现有纯文本回答打成错误，且 mock/部分模型会误杀。
4. 默认仍允许任意绝对 MP4：拒绝；prompt injection 可诱导上传私人视频。
5. 在本机补打 `v0.5.1`/`v0.5.2`：拒绝本轮；已发 npm 的版本不要重发，且未授权不得推 tag。

## Consequences

- 只填 Key、不填允许根的旧安装将无法分析本地文件，必须改模板。默认模型更贵。
- Codex 冷启动仍可能受 npm 注册表影响；`--prefer-offline` 不是保证。
- 证据门禁在模型不返回 JSON 时是残余空窗。
- 磁盘缓存在同大小、mtime 不变的原地覆盖时仍可能脏命中（与 0013 相同残余）。
- 0.6.0 须另授权 tag 才会出现在 npm；在此之前钉版本的模板不能安装。
