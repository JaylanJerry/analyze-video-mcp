# Media Analysis MCP 文档索引

> **更名发布（2026-09-26）：** `media-analysis-mcp@2.0.0` 已在官方 npm 发布，展示名为 **Media Analysis MCP**；registry 全新安装与 stdio 握手通过，Trusted Publisher 已绑定新仓库。GitHub tag/Release 的执行状态以发布记录及 GitHub Actions 为准。历史 `analyze-video-mcp@1.0.0` 保留；下文 1.0.0 验收仅为原包基线。进度见 [发布记录](../tasks/release-2.0.0.md)。

当前正式版本：**1.0.0**，Node **24.x**，唯一工具 `analyze_media(media, prompt)`。正式发布证据见 [发布记录](../tasks/release-1.0.0.md)。

## 当前维护文档

| 文档                                      | 用途                             |
| ----------------------------------------- | -------------------------------- |
| [开发交接](../DEVELOPMENT_HANDOFF.md)     | 接手顺序、当前基线与维护约定     |
| [AGENTS.md](../AGENTS.md)                 | 安全与工程硬规则                 |
| [媒体网关规格](SPEC_MEDIA_GATEWAY.md)     | 1.0 产品范围、非目标与验收标准   |
| [API 契约](API_CONTRACT.md)               | Tool 输入输出、错误及旧版本迁移  |
| [架构](ARCHITECTURE.md)                   | 模块边界、资源所有权与数据流     |
| [Provider 协议](PROVIDER_PROTOCOL.md)     | 上传、Omni、SSE 与真实调用证据   |
| [安全](SECURITY.md)                       | 授权、脱敏、缓存与残余风险       |
| [测试与验证](TESTING_AND_VERIFICATION.md) | 免费门禁、安装验证与付费边界     |
| [审核关卡](REVIEW_GATES.md)               | 规格、安全、宿主与发布检查       |
| [当前任务](../tasks/README.md)            | 已完成状态、已接受限制与后续事项 |

## 决策与历史

[架构决策目录](decisions/) 保留完整 ADR；当前产品和运行时方向由 [0024](decisions/0024-agent-directed-media-gateway.md) 与 [0025](decisions/0025-next-major-node24-support.md) 确定。

旧版规格、未采用提案和整理前快照见 [历史文档索引](archive/README.md)。已完成计划、审核和宿主验收见 [历史任务索引](../tasks/archive/README.md)。归档中的“未发布”“待验”等描述属于当时的状态。
