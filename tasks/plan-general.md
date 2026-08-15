# Implementation Plan: 通用视频 MCP

## Overview

在 v1 单 Tool、流式上传、默认拒绝本地路径的基础上，把产品改成可换机器安装：用户自填 Host `env`，本地上限默认 1024 MiB 且不超过当场政策。不改 `analyze_video` 字段，不加依赖，不发布。

批准文档：[`../docs/SPEC_GENERAL.md`](../docs/SPEC_GENERAL.md)、[`../docs/decisions/0009-general-host-config-and-1gib.md`](../docs/decisions/0009-general-host-config-and-1gib.md)。

## Architecture Decisions

- Agent 表面不变；变化只在 `config.ts`、错误提示、Host 模板和文档。
- 实际上传上限 = `min(QWEN_MAX_LOCAL_VIDEO_MB, policy.max_file_size_mb)`。
- 标准安装是 Host `env`，不是读仓库 `*.key`。
- 回答长度不给 Agent 旋钮；内部按模型最大输出。
- 进度通知独立成阶段；没有它，1 GiB 配置仍然可用。

## Task List

### Phase 1: 上限与可安装配置

- [x] G01：把本地硬顶和默认值改为 1024，政策仍优先。
- [x] G02：补测试与 `.env.example`。
- [x] G03：三份无密钥 Host 模板 + README 主安装路径。

### Checkpoint: Foundation

- [ ] typecheck / lint / test / build 通过。
- [ ] 用户按模板能看懂要填哪些 `env`。
- [ ] 500 MiB 仍可作为用户自填上限。

### Phase 2: 长视频回答

- [x] G04：去掉 Agent 侧 `max_tokens`，内部按模型最大输出。

### Checkpoint: Core Features

- [ ] 契约字段未改。
- [ ] 文档不再把 500 MiB 写成不可配置的产品上限。

### Phase 3: 进度通知（可选增强）

- [x] G05：上传与推理发 MCP progress。本阶段失败不得回退 Phase 1。

### Phase 4: 真机确认

- [x] G06：564 MiB 原片已用新上限跑通。G05 进度通知已补。

### Checkpoint: Complete

- [x] [`../docs/SPEC_GENERAL.md`](../docs/SPEC_GENERAL.md) 完成标准满足。
- [x] ADR 0009 改为 Accepted。
- [x] 未 commit / push / publish。

## Risks and Mitigations

| Risk                     | Impact | Mitigation                                               |
| ------------------------ | ------ | -------------------------------------------------------- |
| 1 GiB 超过 300 秒凭证    | High   | 上传前不放宽凭证；失败给明确错误；建议 HTTPS 或压缩      |
| 本机 `mcp.json` 被误提交 | High   | 模板无密钥；`.cursor/` 已 gitignore；文档写明            |
| Host 仍 60 秒超时        | Med    | Cursor 桌面已跑通 100 秒级；文档继续写明超时；G05 再增强 |
| 政策降到 1024 以下       | Med    | 动态 `min()`，不把 1024 写进上传器常量                   |

## Open Questions

无阻塞项。正式 OSS 与 npm 发布明确推迟，不在本计划回答。
