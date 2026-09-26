# Media Analysis MCP 开发交接

> **更名发布（2026-09-26）：** `media-analysis-mcp@2.0.0` 已在官方 npm 发布，展示名为 **Media Analysis MCP**；registry 全新安装与 stdio 握手通过，Trusted Publisher 已绑定新仓库。GitHub tag/Release 的执行状态以发布记录及 GitHub Actions 为准。历史 `analyze-video-mcp@1.0.0` 保留；下文 1.0.0 验收仅为原包基线。进度见 [发布记录](tasks/release-2.0.0.md)。

## 当前基线

截至 2026-09-26，`analyze-video-mcp@1.0.0` 已正式发布，PR #39 已合并到 main。只正式支持 Node 24.x；Node 24 远程 CI、Secret Scan、官方 npm 全新安装及 stdio 握手已通过。发布提交、tag、工作流和安装证据见 [发布记录](tasks/release-1.0.0.md)。

产品只有 `analyze_media(media, prompt)`：上传本地 MP4/MOV/MP3 或直连公开 HTTPS 视频，由 Agent 决定要问什么，服务端负责授权、格式检查、上传、模型协议与脱敏。旧 `analyze_video`、证据报告层和可选 FFmpeg 静音核对已退出当前实现。历史 0.6.1 的契约不变，迁移说明见 API 契约。

## 接手顺序

1. [AGENTS.md](AGENTS.md)：安全、授权与工程硬规则。
2. [当前规格](docs/SPEC_MEDIA_GATEWAY.md)、[ADR 0024](docs/decisions/0024-agent-directed-media-gateway.md)、[ADR 0025](docs/decisions/0025-next-major-node24-support.md)：产品边界与运行时策略。
3. [API 契约](docs/API_CONTRACT.md)、[架构](docs/ARCHITECTURE.md)、[安全](docs/SECURITY.md)、[Provider 协议](docs/PROVIDER_PROTOCOL.md)。
4. [测试手册](docs/TESTING_AND_VERIFICATION.md)、[审核关卡](docs/REVIEW_GATES.md)、[当前任务](tasks/README.md)。
5. 按需查 [历史文档](docs/archive/README.md) 与 [历史任务](tasks/archive/README.md)，不要把旧计划重新当作待办。

## 维护与验收

- 实现位于 `src/`，免费测试位于 `test/`，安装/探针脚本位于 `scripts/`，宿主配置示例位于 `examples/`。
- 运行五项质量门：typecheck、lint、format:check、test、build；共享行为变更补最小回归测试并检查 coverage。
- 推送、PR、合并、发布与真实付费调用分别遵守用户授权。发布沿用 tag + Trusted Publishing。
- 不读取 `.env`、`*.key`、`text/` 私人内容；不改只读 `ref/`。本地 `dist/` 可能是已安装 MCP 的运行入口，整理时应保留。
- 当前已声明限制与后续优化集中在 [当前任务](tasks/README.md)，详细证据仍保存在归档中。

## 文档维护

当前说明只记录现在的契约、验证与限制；完成的计划、旧规格、审核过程移入 archive。架构决策保留在 `docs/decisions/`。本轮整理前的完整交接快照见 [20260926 快照](docs/archive/snapshots/20260926-DEVELOPMENT_HANDOFF.md)。
