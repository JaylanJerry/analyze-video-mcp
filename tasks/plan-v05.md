# Implementation Plan: v0.5.0 工程收口

## Overview

把已落地的产品收成可安装的 `v0.5.0`：停 Node 20、版本与两阶段 Release 对齐、1 小时时长边界、移除 dotenv、删 Bailian 遗留 API、SSE UTF-8 字节硬顶、补跨平台安装验证。不改 `analyze_video` 字段，不加生产依赖，不发 npm。

批准文档：[`../docs/SPEC_V05.md`](../docs/SPEC_V05.md)、[`../docs/decisions/0012-v050-runtime-and-hygiene.md`](../docs/decisions/0012-v050-runtime-and-hygiene.md)。一次只做 `todo-v05.md` 中的下一项。

## Architecture Decisions

- Breaking 运行时用 `0.5.0`，不用 `0.4.1`。breaking 是停 Node 20；`VIDEO_TOO_LONG` 是加性错误码。
- 生产不加载 `.env`；`.env` 可选，不是启动前置。
- 时长 probe：box header + seek；>3600 拒绝、=3600 允许、unknown 放行。
- SSE 硬顶是 UTF-8 字节，不是 `string.length`。
- 工具链拆四项：SDK manifest ≠ Vitest 4 ≠ Zod 4 ≠ lint-staged。
- 发版两阶段：tag/Release 不改安装钉；Release 存在后另 commit 再钉 `#v0.5.0`。
- TypeScript 留 5.9.x。
- Ruleset 只要求聚合检查 `required-ci`。
- 打 `v0.5.0` 必须用户明确授权，且绑定 exact SHA 的 CI / audit / E2E / Live Smoke。

## Task List

### Phase 0: 人在 GitHub Settings（可与代码并行，打 tag 前完成）

- [ ] 开启 immutable releases。
- [ ] `main` / `v*` ruleset，required check 仅为 `required-ci`。
- [ ] 编辑 `v0.4.0` Release 文案，去掉「不可变」。

### Phase 1: 运行时与版本源

- [x] V01：Node 22+ 与 `required-ci`。
- [x] V02：源码版本 `0.5.0`（安装钉仍 `#v0.4.0`）。
- [x] V03：移除 dotenv。

### Checkpoint: Foundation

- [x] typecheck / lint / test / build 通过。
- [x] CI 不再测 Node 20。
- [x] initialize 前 stdout 无杂字节。

### Phase 2: 产品边界与稳健性（V04–V07 互不阻塞）

- [x] V04：1 小时时长 + SECURITY 残余。
- [x] V05：SSE UTF-8 4 MiB 硬顶（含单 event）。
- [x] V06：删除 `analyze()`。
- [x] V07：IPv6 / requestId / persist-credentials。

### Checkpoint: Core Features

- [x] Tool 字段未改。
- [x] 本地 >3600s 不上传；=3600s 允许。
- [x] SSE 两份硬顶有测试。

### Phase 3: 工具链与安装（拆开；V12 只依赖 V01）

- [x] V08：MCP SDK manifest baseline。
- [x] V09：Vitest 4。
- [x] V10：Zod 4。
- [x] V11：lint-staged 17。
- [x] V12：Ubuntu + Windows 安装 E2E，加 macOS smoke。

### Phase 4: 两阶段 Release

- [x] V13：`release.yml` 已加（不改安装钉）。打 tag 仍需用户授权与 exact-SHA 核对。
- [ ] V14：确认 Release 存在后，新 commit 把钉改为 `#v0.5.0`。

### Checkpoint: Complete

- [ ] SPEC_V05 完成标准满足。
- [ ] ADR 0012 改为 Accepted，填写 Date。
- [ ] 未另说则不 push、不发 npm。

## Risks and Mitigations

| Risk                                   | Impact | Mitigation                                         |
| -------------------------------------- | ------ | -------------------------------------------------- |
| 无 `mvhd` 的超长 MP4 漏检              | Med    | unknown 放行写进 SECURITY；HTTPS 同样只靠 Provider |
| `#main` 用户仍在 Node 20               | Med    | V01 起 engines 失败；README 分轨道                 |
| 打 tag 后又改 README 导致 tag 漂移冲动 | High   | V13 禁止改钉；V14 另 commit；禁止移动 tag          |
| Live Smoke 用错 SHA                    | High   | 前置表绑定 exact SHA 与 run URL                    |
| Vitest 4 覆盖率配置不兼容              | Med    | 单独 V09，失败不回滚 V01–V07                       |
| dotenv 删除后 `npm start` 无 `.env`    | Low    | 产品路径本就不靠它；`dev` 在文件存在时才加载       |

## Open Questions

无规格阻塞项。打 `v0.5.0` 仍需用户在 V13 单独授权。`qwen-omni-mcp/` 残留本计划不删。
