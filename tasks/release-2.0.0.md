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
- 提交/推送、远程 CI、新 npm 包首次建立和 Trusted Publisher、tag 发布、registry 安装：待执行。当前不能把新安装命令当作已发布可用入口。

## 验收要求

本地五项门禁 + coverage + 独立打包安装/stdio 握手；远程 Node 24 required-ci/Secret Scan；新包发布权限匹配实际仓库与 release.yml；正式 registry 全新安装验证名称、版本、唯一 Tool 和 media/prompt 字段。历史 1.0.0 与旧安装包不覆盖、不移动 tag；无新付费媒体调用。

## 本地验收

Windows Node 24：typecheck / lint / format:check / test / build 全通过，306 passed / 1 skipped（19 文件）。coverage 为 88.81% statements / 82.56% branches / 91.62% functions / 90.29% lines。独立打包安装与 install e2e 均通过：38 项，初始化 server name 为 Media Analysis MCP、version 为 2.0.0，唯一工具 analyze_media，字段 media/prompt。84 份 Markdown 相对文件链接无缺失，Cursor 按钮解码与 JSON 示例一致。此次无真实媒体上传。
