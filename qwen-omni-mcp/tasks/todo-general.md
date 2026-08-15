# 通用视频 MCP 任务

规格已批准。一次只做一项；G01–G04 已在本轮实施。

## G01：本地上限对齐政策

**Description:** 把 `QWEN_MAX_LOCAL_VIDEO_MB` 的默认值和硬顶从 500 改为 1024。上传前继续与当场 `max_file_size_mb` 取较小值。不改 Tool schema。

**Acceptance criteria:**

- [x] `DEFAULT_MAX_LOCAL_VIDEO_MB` 与 `ABSOLUTE_MAX_LOCAL_VIDEO_MB` 均为 1024。
- [x] 未设置环境变量时，501 MiB 本地文件不再被产品硬顶拒绝（仍受 policy 约束）。
- [x] 上传超时/凭证过期的 Agent 文本建议改用公开 HTTPS，且不自动重传整文件。
- [x] `QWEN_MAX_LOCAL_VIDEO_MB=500` 时，501 MiB 仍被拒绝。
- [x] `QWEN_MAX_LOCAL_VIDEO_MB=1025` 启动失败。
- [x] ADR 0009 已在 G06 后改为 Accepted。

**Verification:**

- [ ] `npx vitest run test/config.test.ts test/media.test.ts`
- [ ] `npm run typecheck`

**Dependencies:** 用户批准 SPEC_GENERAL

**Files likely touched:**

- `src/config.ts`
- `test/config.test.ts`
- `test/media.test.ts`
- `docs/SPEC.md`（指向通用规格，不改 v1 历史数字的叙事）

**Estimated scope:** Small

## G02：配置测试与示例环境

**Description:** 同步 `.env.example`、配置测试和安全文档中的 1–1024 范围。

**Acceptance criteria:**

- [x] `.env.example` 写明 1–1024，默认 1024。
- [x] 配置单测覆盖默认 1024、用户收紧到 500、越界失败。
- [x] 文档不再写“不可大于 500”。

**Verification:**

- [ ] `npx vitest run test/config.test.ts`
- [ ] `npm run lint`

**Dependencies:** G01

**Files likely touched:**

- `.env.example`
- `test/config.test.ts`
- `docs/SPEC.md`
- `docs/SECURITY.md`
- `docs/ARCHITECTURE.md`

**Estimated scope:** Small

## G03：用户自填 Host 模板

**Description:** 为 Cursor、Claude Code、Codex 各写一份无密钥模板。README 主安装路径改为用户自己填 `DASHSCOPE_API_KEY` 与 `QWEN_ALLOWED_ROOTS`。本机 `text/*.key` 脚本降为开发附录。

**Acceptance criteria:**

- [x] 模板含 key、允许根、可选 Base/Upload URL、可选 `QWEN_MAX_LOCAL_VIDEO_MB`。
- [x] 模板没有真实密钥、没有 `text/` 绝对路径作为唯一安装方式。
- [x] README 写明：本机 Host 配置不要提交。
- [x] Cursor / Claude Code / Codex 各有可复制片段。

**Verification:**

- [ ] 人工读 README：新机器只靠文档能配起来。
- [ ] `npm run build`

**Dependencies:** G02

**Files likely touched:**

- `README.md`
- `docs/ARCHITECTURE.md`
- 新建 `examples/mcp.cursor.json`、`examples/mcp.claude-code.json`、`examples/mcp.codex.toml`

**Estimated scope:** Medium

## Checkpoint: Foundation

- [ ] `npm run typecheck && npm run lint && npm test && npm run build`
- [ ] 不读取、不打印、不提交密钥。

## G04：去掉 Agent 侧 max_tokens

**Description:** 从 Tool schema 删除 `max_tokens`。内部不传该字段，或传到当前模型文档的最大输出。问句仍要求写到结尾。401/403 的 Agent 文本改为检查 Key 和接口地址。不做测试连接 Tool。

**Acceptance criteria:**

- [x] `listTools()` 的 schema 只有 `video` 和 `question`。
- [x] 发给百炼的请求不再使用 1024/8192 产品上限。
- [x] `API_CONTRACT.md` 与测试同步。
- [x] 鉴权失败文本不含密钥，并提示检查 Key 和地址。

**Verification:**

- [ ] `npx vitest run test/tools.test.ts`
- [ ] `npm run typecheck`

**Dependencies:** G03

**Files likely touched:**

- `src/server.ts`
- `README.md`
- `docs/API_CONTRACT.md`
- `test/tools.test.ts`

**Estimated scope:** Small

## Checkpoint: Core Features

- [ ] Tool 名为 `analyze_video`，公开字段为 `video`、`question`。
- [ ] 文档把 1024 MiB 写成默认本地上限。

## G05：MCP 进度通知

**Description:** 上传与推理阶段向 Host 发送 progress，降低长任务被当成卡死的概率。不改 Tool 输入输出。

实现（2026-08-15）：本地路径发「正在上传视频 / 上传完成 / 正在分析视频」；HTTPS 只发推理开始。无 `progressToken` 或通知失败时 no-op，成功仍只回纯文本。未改 `upload.ts`（不做字节级进度）。

**Acceptance criteria:**

- [x] 上传开始、上传结束、推理开始至少各有一次 progress。
- [x] 成功输出仍是纯文本。
- [x] 无 progress 的旧 Host 仍能完成调用。

**Verification:**

- [x] `npx vitest run test/tools.test.ts`（16 通过）
- [x] `npm run typecheck` 通过；`src/server.ts` / `test/tools.test.ts` eslint 通过。`npm run lint` 仍被既有 `scripts/t09-e2e.ts` 项目服务报错挡住，不在本任务改。

**Dependencies:** G04

**Files likely touched:**

- `src/server.ts`
- `src/upload.ts`
- `test/tools.test.ts`

**Estimated scope:** Medium

## G06：大于 500 MiB 的 Cursor 真机确认

**Description:** 用户明确授权后，用大于 500 MiB 且不超过 1024 MiB 的本地 MP4 在 Cursor 调用 `analyze_video`。优先用现有仓库外素材，不把视频拷进仓库。

**Acceptance criteria:**

- [x] 上传未被产品 500 MiB 硬顶拒绝。
- [x] 返回画面与音频文本。
- [x] 记录脱敏耗时与结果摘要到本文件。
- [x] ADR 0009 改为 Accepted。

验证记录（2026-08-15，Windows Node 24，`scripts/t09-e2e.ts` + 新 `dist`，已授权付费）：

- 原 `2.mp4`（约 564 MiB / 7:04）不再被产品硬顶拒绝。
- 122s，RSS 约 127 MiB，708 events，`chatcmpl-00d2a085-…9caa9`。
- 回答约 1075 字，含古风城市、教室画图、对白与环境声。
- Cursor 进程需重载后才会用上新 schema（已去掉 `max_tokens`）。

**Verification:**

- [x] 真实 MCP stdio `analyze_video` 成功。
- [x] `npm test` 140 通过 2 skipped。

**Dependencies:** G01–G04；G05 非必须

**Files likely touched:**

- `tasks/todo-general.md`（验证记录）
- `docs/decisions/0009-general-host-config-and-1gib.md`

**Estimated scope:** Small

## Checkpoint: Complete

- [ ] SPEC_GENERAL 完成标准满足。
- [ ] 未 push、未发布。
