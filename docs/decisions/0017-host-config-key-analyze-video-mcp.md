# ADR 0017：示例 Host 配置键改为 `analyze_video_mcp`

- Status: Accepted
- Date: 2026-08-22
- Supersedes: [ADR 0013](0013-upload-cache-and-host-server-name.md) 中的示例 Host 键（其余条款仍有效）

## Context

名称层目前混用：仓库 / npm / CLI / `initialize.name` 是 `analyze-video-mcp`，Tool 是 `analyze_video`，示例 Host 键却是 `mcp_analyze_video`。部分客户端还会再拼 `mcp__<server>__<tool>`。用户要求示例键与 Tool 同族、把 `mcp` 放到末尾：`analyze_video_mcp`。不改 Tool 名，不改默认 `initialize.name`。

## Decision

公开名称固定为：

| 层                                                         | 名称                |
| ---------------------------------------------------------- | ------------------- |
| 仓库、npm 包、CLI 命令、MCP `initialize.name` 默认值       | `analyze-video-mcp` |
| 示例 Host 配置键（Cursor / Claude / Codex / VS Code 模板） | `analyze_video_mcp` |
| Tool                                                       | `analyze_video`     |

`initialize.name` 仍可用 `QWEN_MCP_SERVER_NAME` 覆盖。已安装的旧键（`analyze-video`、`mcp_analyze_video`）不必改；新复制的模板用 `analyze_video_mcp`。

## Alternatives

1. 把 `initialize.name` 也改成 `analyze_video_mcp`：拒绝；协议名继续跟 npm 包名，避免 Host 键和握手名绑死。
2. 把 Tool 改成 `analyze_video_mcp`：拒绝；破坏 ADR 0001。
3. 继续用 `mcp_analyze_video`：拒绝；与 Tool 名不同族，且前缀 `mcp_` 容易和客户端自动加的 `mcp__` 叠在一起。

## Consequences

- 文档、deeplink、示例配置键一并改。旧 Host 配置仍能工作。
- DSH 一类 `mcp__…__…` 公开名仍由客户端决定，本仓库不伪造 alias。
