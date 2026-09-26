# Media Analysis MCP 2.0.0 更名与仓库整理发布

日期：2026-09-26。用户已授权所有当前名称统一为 Media Analysis MCP，并把仓库整理一起提交、推送和发布。

## 目标

展示名/MCP server：`Media Analysis MCP`；包/CLI/仓库：`media-analysis-mcp`；宿主键：`media_analysis_mcp`。Node 24.x，唯一工具 `analyze_media(media, prompt)`，无新增依赖。迁移决定见 [ADR 0026](../docs/decisions/0026-media-analysis-mcp-rename.md)。

## 当前进度

- 仓库整理已完成：32 份历史文档归档、5 份入口快照、链接修复与当前维护说明合并。
- 源码、包与锁文件、默认配置/缓存路径、示例、安装探针及当前文档的更名已写入，待门禁。
- 新 npm 包和新 GitHub 仓库名查询均为 404（2026-09-26）；不等于名称已经保留。
- 本机 GitHub CLI 登录和 npm CLI 身份查询均失败；GitHub 浏览器仍能访问仓库设置，连接器可用于 PR/工作流查询。
- GitHub 仓库已更名为 `JaylanJerry/media-analysis-mcp`，连接器核对同一仓库 ID `1335018150`，所有权与公开可见性不变；本地 origin 已同步。
- 更名与整理已提交、推送并经 PR #42 合并；远程 CI 与 Secret Scan 全通过。新 npm 包首次建立、Trusted Publisher、tag 发布、registry 安装仍待 npm 登录与发布验证。当前不能把新安装命令当作已发布可用入口。

## 验收要求

本地五项门禁 + coverage + 独立打包安装/stdio 握手；远程 Node 24 required-ci/Secret Scan；新包发布权限匹配实际仓库与 release.yml；正式 registry 全新安装验证名称、版本、唯一 Tool 和 media/prompt 字段。历史 1.0.0 与旧安装包不覆盖、不移动 tag；无新付费媒体调用。

## 本地验收

Windows Node 24：typecheck / lint / format:check / test / build 全通过，306 passed / 1 skipped（19 文件）。coverage 为 88.81% statements / 82.56% branches / 91.62% functions / 90.29% lines。独立打包安装与 install e2e 均通过：38 项，初始化 server name 为 Media Analysis MCP、version 为 2.0.0，唯一工具 analyze_media，字段 media/prompt。84 份 Markdown 相对文件链接无缺失，Cursor 按钮解码与 JSON 示例一致。此次无真实媒体上传。

## 远程验收与合并

- 更名及整理提交：`b39f6f229a909789a3a4330b5ad4889d70a8aaeb`；正常通过提交与推送钩子。
- [PR #42](https://github.com/JaylanJerry/media-analysis-mcp/pull/42) 经用户单独授权，在所有阻塞检查通过后合并，merge SHA `10b9afc97deaabd8f753c241b452ecde25c16c21`。
- [Node 24 CI 36228629312](https://github.com/JaylanJerry/media-analysis-mcp/actions/runs/36228629312) 和 [Secret Scan 36228629411](https://github.com/JaylanJerry/media-analysis-mcp/actions/runs/36228629411) 全通过，含 Windows/Linux 测试、覆盖率、安装与 GitHub npx 冷安装、macOS smoke、生产依赖 audit。
- 本地包：`artifacts/media-analysis-mcp-2.0.0.tgz`，38 项；SHA-256 `15f6c4ed21b403cc91c2406926779a6c0bf287611f9f77b458304e0e153fa2f5`。归档及私人内容未进入包，依赖条目与 1.0.0 一致。
- 发布阻塞：本机 npm 身份查询为 HTTP 401；已请求用户完成 `npm login --registry=https://registry.npmjs.org`，不接收密码、验证码或 Token。尚未创建 `v2.0.0` tag，也未发布或建立新 npm 包。新包认证/首次建立完成后，再配置 Trusted Publisher 并验证正式安装。
