# ADR 0013：进程内复用临时上传，安装名可配

- Status: Accepted
- Date: 2026-08-17

## Context

同一本地大视频连问几次会按次全量上传（临时 `oss://` 约 48 小时有效）。协议层写过「v1 不缓存 credential」，被理解成每次都必须重传文件。Host 示例把配置键写死成 `analyze-video`；部分客户端（如 DSH）再拼出 `mcp__<server>__<tool>`。用户要：少重传、人能换百炼同协议模型、示例键 `mcp_analyze_video`、协议名不要写死。Agent 仍不得选模型。Tool 名保持 `analyze_video`。

## Decision

批准 [`SPEC_V052.md`](../SPEC_V052.md)：

1. 进程内缓存已上传的 `oss://`，键为文件身份（realpath + size + mtimeMs）+ `QWEN_MODEL`，TTL 47 小时。不缓存 policy credential，不缓存模型回答。
2. `QWEN_MODEL` 作为人配环境变量公开；默认仍 `qwen3.5-omni-flash`；无模型白名单；不进 Tool schema。
3. 示例 Host 键改为 `mcp_analyze_video`。`initialize.name` 默认 `analyze-video-mcp`，可用 `QWEN_MCP_SERVER_NAME` 覆盖。不改 Tool 名，不实现 DSH alias。
4. 文档与 provider 约束写清抽样理解、实测/推断、禁止倒序时间戳。不因此承诺帧级精度。

## Alternatives

1. 整文件 SHA-256 做缓存键：拒绝本轮；查缓存就要再读一遍大文件。mtime+size 的脏命中列为残余。
2. 磁盘缓存 / 跨进程共享 oss URL：拒绝；密钥与路径残留面更大，且 48 小时对象会过期。
3. 缓存分析正文：拒绝；`question` 变了必须重跑。
4. Tool 增加 `model` 或改名为 `mcp_analyze_video`：拒绝；破坏 ADR 0001 与公开契约。
5. 百炼模型白名单：拒绝；名单过期。文档约束「须支持画面 + 内嵌音轨」。
6. 在本仓库伪造 DSH 公开名 `mcp_analyze_video`：拒绝；那是客户端 alias 问题。

## Consequences

- 连问同一本地文件时少传流量；换模型或过期仍上传。
- 同大小、mtime 不变的原地覆盖可能复用旧对象。
- Cursor 示例键变更后，已装 `analyze-video` 的用户不必改；新复制模板会看到 `mcp_analyze_video`。
- DSH 的 `mcp__…__…` 不会变成 `mcp_analyze_video`，除非上游做 alias。
