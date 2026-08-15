# v0.5.0 任务

规格：[`../docs/SPEC_V05.md`](../docs/SPEC_V05.md)。ADR：[`../docs/decisions/0012-v050-runtime-and-hygiene.md`](../docs/decisions/0012-v050-runtime-and-hygiene.md)。

一次只做一项。规格与 ADR 已批准。

## 人操作（可与代码并行；打 tag 前必须完成）

- [ ] GitHub Settings → 开启 immutable releases。
- [ ] Ruleset：保护 `main`（禁 force push / 删除，required check **仅** `required-ci`）；限制 `v*` 更新与删除。
- [ ] 编辑 `v0.4.0` Release 说明，去掉「不可变」，改为「已发布标签，不要移动」。

## V01：停止支持 Node 20

**Description:** `engines.node` 改为 `>=22`。CI 测试矩阵删除 Node 20，保留 Ubuntu/Windows × 22/24。增加聚合 job `required-ci`（`needs` 全部 blocking jobs；不含 Node 26）。`@types/node` 升到 22。README 用双轨道文案：跟 `#main` / 即将发布的 v0.5.0 需要 Node 22+；稳定安装 `#v0.4.0` 以该标签当时说明为准。可选非阻断 Node 26 job，不进入 `required-ci`。

**Acceptance criteria:**

- [x] `package.json` engines 为 `>=22`。
- [x] `.github/workflows/ci.yml` 不再测 Node 20。
- [x] 存在 `required-ci`，且 Node 26 不在其 `needs` 中。
- [x] README 没有把 Node 22+ 写成 `#v0.4.0` 的安装前提。
- [x] ADR 0005 标注被 0012 取代的 Node >=20 条款。
- [x] Node 26 job：已加且 `continue-on-error` / 等价非阻断，或本项明确不做并在 PR 说明。

**Verification:**

- [x] `npm run typecheck`
- [x] 读 CI：无 Node 20；有 `required-ci`。

**Dependencies:** 用户批准 SPEC_V05 与 ADR 0012

**Files likely touched:** `package.json`、`package-lock.json`、`.github/workflows/ci.yml`、`README.md`、`docs/SPEC_INSTALL.md`、`docs/decisions/0005-node-first-runtime.md`

**Estimated scope:** Medium

## V02：版本源改为 0.5.0

**Description:** 仓库根 `package.json` 与 `src/version.ts` 改为 `0.5.0`。测试只断言二者相等。脚本里的 MCP client version 读 `PACKAGE_VERSION`。扫描范围不含 `qwen-omni-mcp/`。README / examples 的 npx 钉仍是 `#v0.4.0`。

**Acceptance criteria:**

- [x] initialize 报告 `0.5.0`。
- [x] 仓库根无第三处与 package 不一致的产品版本常量。
- [x] `qwen-omni-mcp/` 未被修改。
- [x] 安装模板仍钉 `v0.4.0`。

**Verification:**

- [x] `npx vitest run test/version.test.ts`
- [x] `npm run test:install`

**Dependencies:** V01

**Files likely touched:** `package.json`、`src/version.ts`、`test/version.test.ts`、`scripts/*.ts`

**Estimated scope:** Small

## V03：生产移除 dotenv

**Description:** 删除 `dotenv` 依赖和 `import "dotenv/config"`。`npm run dev` 仅在 `.env` 存在时加载它；文件不存在仍须能启动。stdout 验收：spawn 后写入 initialize，第一条 stdout record 必须是合法 JSON-RPC，其前无其它字节。

**Acceptance criteria:**

- [x] `package.json` dependencies 无 dotenv。
- [x] `src/` 无 dotenv import。
- [x] `.env` 缺失时 `npm run dev` 仍能拉起（随后可因缺 Key 失败）。
- [x] stdout 清洁测试按 initialize 前零杂字节，而不是固定 sleep。
- [x] `.env.example` 仍可作为可选模板。

**Verification:**

- [x] `npx vitest run test/config.test.ts test/tools.test.ts`
- [x] `npm run typecheck`

**Dependencies:** V01（与 V02 都改 `package.json` 时串行；逻辑上不依赖版本号）

**Files likely touched:** `src/config.ts`、`package.json`、`package-lock.json`、`test/`、`docs/decisions/0010-npx-install-and-optional-roots.md`

**Estimated scope:** Medium

## Checkpoint: Foundation

- [x] `npm run typecheck && npm run lint && npm test && npm run build`
- [x] 不读取、不打印、不提交密钥。

## V04：1 小时时长边界

**Description:** README 与 Tool 描述写清一次最多 1 小时。本地 MP4 在同一 FileHandle 上用 box header + seek 解析 `mvhd`（32/64-bit size，version 0/1）。大于 3600 秒返回 `VIDEO_TOO_LONG`（`retryable: false`，`stage: authorized`，无绝对路径）；正好 3600 允许。malformed / 非法 size / `timescale == 0` / 无 `moov/mvhd` → unknown，放行。HTTPS 不 probe。夹具为合成头，不提交真实长视频。残余写入 `SECURITY.md`。

**Acceptance criteria:**

- [x] `API_CONTRACT.md` 增加 `VIDEO_TOO_LONG`，含 retryable / stage / 3600 边界。
- [x] 合成 >3600s 夹具在 resolve/authorize 阶段失败，且未触发上传 mock。
- [x] 合成 =3600s 夹具通过授权。
- [x] 缺 `mvhd` 的夹具仍可走上传 mock。
- [x] `docs/SECURITY.md` 写明 fMP4 / unknown duration 残余。
- [x] schema 仍只有 `video` 与 `question`。

**Verification:**

- [x] `npx vitest run test/media.test.ts test/tools.test.ts test/errors.test.ts`
- [x] `npm run typecheck`

**Dependencies:** Checkpoint Foundation

**Files likely touched:** `src/media.ts`、`src/errors.ts`、`src/server.ts`、`docs/API_CONTRACT.md`、`docs/SECURITY.md`、`README.md`、`test/`

**Estimated scope:** Medium

## V05：SSE 内存上限

**Description:** 未完成 event 与累计回答各设 `MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024`（UTF-8 字节）。超限在追加进 JS string 之前抛 `PROVIDER_RESPONSE_INVALID`。覆盖无 boundary 超限与带 boundary 的单 event 超限。

**Acceptance criteria:**

- [x] 无 boundary 的 >4 MiB UTF-8 输入失败。
- [x] 带 boundary 的单个 >4 MiB SSE event 失败。
- [x] 正常短 SSE 不受影响。
- [x] 不截断成功文本。

**Verification:**

- [x] `npx vitest run test/sse.test.ts`

**Dependencies:** Checkpoint Foundation（不依赖 V04）

**Files likely touched:** `src/sse.ts`、`test/sse.test.ts`

**Estimated scope:** Small

## V06：删除 Bailian 遗留 API

**Description:** 删除 `analyze()`、`buildPayload`、`BailianError`、`AnalyzeParams` 及只覆盖它们的测试。生产路径只留 `analyzeVideo` / `buildVideoPayload` / `contentBlock`。不重命名文件。

**Acceptance criteria:**

- [x] `src/bailian.ts` 无 `maxTokens` / `thinkingBudget` / 非流式 `analyze`。
- [x] `test/bailian.test.ts` 只测视频 SSE 路径。
- [x] AGENTS.md 不再把 `analyze()` 写成测试保留项。

**Verification:**

- [x] `npx vitest run test/bailian.test.ts`
- [x] `npm run typecheck`

**Dependencies:** Checkpoint Foundation（不依赖 V05）

**Files likely touched:** `src/bailian.ts`、`test/bailian.test.ts`、`AGENTS.md`、`docs/ARCHITECTURE.md`

**Estimated scope:** Medium

## V07：安全硬化

**Description:** HTTPS 字面量拒绝补 IPv6 ULA、link-local、IPv4-mapped、未指定地址。stderr 的 requestId 滤成可打印单行。所有 `actions/checkout` 加 `persist-credentials: false`。

**Acceptance criteria:**

- [x] 上述字面量 URL 返回 `INVALID_VIDEO_INPUT`。
- [x] 带换行的 SSE `id` 不会把 stderr 拆成多行。
- [x] workflows 的 checkout 均含 `persist-credentials: false`。

**Verification:**

- [x] `npx vitest run test/media.test.ts test/sse.test.ts`
- [x] 读 `.github/workflows/*.yml`

**Dependencies:** Checkpoint Foundation

**Files likely touched:** `src/media.ts`、`src/sse.ts`、`src/server.ts`、`.github/workflows/`

**Estimated scope:** Medium

## Checkpoint: Core Features

- [x] Tool 字段未改。
- [x] 生产无 dotenv。
- [x] 本地超长视频不上传。
- [x] SSE 两份 UTF-8 硬顶有测试。

## V08：MCP SDK manifest baseline

**Description:** 只把 `@modelcontextprotocol/sdk` 的 `package.json` 声明基线提到当前已测 lock 版本。不改解析后的 SDK 版本（若 lock 已是最新，只改 range）。不升 Vitest / Zod / lint-staged。

**Acceptance criteria:**

- [x] manifest range 反映已测版本。
- [x] lock 中 SDK 版本与改前相同，或 PR 证明「只改 range」。
- [x] 无其它依赖大版本变动。

**Verification:**

- [x] `npm test`
- [x] `npm run typecheck`

**Dependencies:** Checkpoint Core Features

**Files likely touched:** `package.json`、必要时 `package-lock.json`

**Estimated scope:** Small

## V09：Vitest 4

**Description:** `vitest` 与 `@vitest/coverage-v8` 升到 4.x，并修正覆盖率配置。不升 Zod / ESLint / TypeScript / SDK。

**Acceptance criteria:**

- [x] `npm test` 与 `npm run coverage` 在 4.x 通过。
- [x] 覆盖率门槛仍 85%。

**Verification:**

- [x] `npm test`
- [x] `npm run coverage`

**Dependencies:** V08（软顺序：先稳住 SDK 声明；逻辑上可在 Core 之后独立做）

**Files likely touched:** `package.json`、`package-lock.json`、`vitest.config.ts`

**Estimated scope:** Medium

## V10：Zod 4

**Description:** 单独把 zod 升到 4.x，按 MCP SDK 的 Zod 4 兼容说明改 schema。不夹带其它升级。

**Acceptance criteria:**

- [x] lock 为 zod 4。
- [x] policy / SSE / tool schema 测试通过。

**Verification:**

- [x] `npm test`
- [x] `npm run typecheck`

**Dependencies:** Checkpoint Core Features（不依赖 Vitest 4）

**Files likely touched:** `package.json`、`package-lock.json`、`src/*.ts`、`test/*.ts`

**Estimated scope:** Medium

## V11：lint-staged 17

**Description:** 将 `lint-staged` 升到 17.x，确认 husky pre-commit 仍跑 secret scan、lint、format。

**Acceptance criteria:**

- [x] lock 为 lint-staged 17。
- [x] `.husky` / lint-staged 配置无需交互即可跑。

**Verification:**

- [x] `npx lint-staged --help` 可用
- [x] `npm run lint`

**Dependencies:** Checkpoint Core Features（不依赖 Zod）

**Files likely touched:** `package.json`、`package-lock.json`、lint-staged 配置

**Estimated scope:** Small

## V12：跨平台安装 E2E

**Description:** `npx-github-e2e` 与 `pack-install-e2e` 在 Ubuntu 与 Windows 上跑。增加 macOS Node 24 的 initialize / `listTools` smoke。这些 job 纳入 `required-ci`。不依赖工具链大版本升级。

**Acceptance criteria:**

- [x] CI 含 Windows 的 npx 或 pack 安装探测。
- [x] CI 含 macOS Node 24 smoke。
- [x] `required-ci` 的 `needs` 包含上述 blocking 安装 job。
- [x] 默认 `npm test` 仍不额外打真实 GitHub 网络。

**Verification:**

- [x] 读 `.github/workflows/ci.yml`
- [x] `npm run test:pack-install` 本机仍可通过

**Dependencies:** V01（需要 Node 22 矩阵与 `required-ci` 骨架）

**Files likely touched:** `.github/workflows/ci.yml`

**Estimated scope:** Medium

## V13：Release candidate 与 tag

**Description:** 新增 tag 触发的 `release.yml`：校验 `v${version}` 与 `PACKAGE_VERSION` 一致，跑 pack/npx probe，`gh release create`。不改 README、不 push、不移动 tag。本项在用户授权打 tag 时执行前置核对；workflow 文件本身可先合入 main。

**Acceptance criteria:**

- [x] 仅 `v*` tag 触发。
- [x] 版本不一致则失败。
- [x] workflow 不修改工作树、不 push。
- [ ] 打 tag 前对 **exact SHA** 记录：`required-ci`、production audit、跨平台 install E2E、同一 SHA 的 Live Smoke、immutable、ruleset。缺一项不得打 tag。
- [x] 本项 **不** 改 README / examples 安装钉。

**Verification:**

- [x] 读 `.github/workflows/release.yml`
- [ ] 打 tag 前的 SHA 核对表已填

**Dependencies:** V02、V12、人操作完成；用户明确授权打 tag

**Files likely touched:** `.github/workflows/release.yml`

**Estimated scope:** Medium

## V14：Release 之后钉住安装文档

**Description:** 确认 GitHub Release `v0.5.0` 已存在且 tag 仍指向打 tag 时的 commit。然后在 **新 commit** 把 README / examples / 安装规格的 npx 钉改为 `#v0.5.0`，并收紧 Node 22+ 为该稳定安装的前提。

**Acceptance criteria:**

- [ ] `v0.5.0` Release 存在；tag 未移动。
- [ ] README / examples 钉 `#v0.5.0`。
- [ ] 用户面向文案不再把 Node 20+ 写成当前默认安装前提。

**Verification:**

- [ ] 读 README 与 `examples/`
- [ ] `gh release view v0.5.0` 显示已发布

**Dependencies:** V13 完成（Release 已存在）

**Files likely touched:** `README.md`、`examples/`、`docs/SPEC_INSTALL.md`

**Estimated scope:** Small

## Checkpoint: Complete

- [ ] SPEC_V05 完成标准满足。
- [ ] ADR 0012 Accepted（Date 填批准日）。
- [ ] 未另说则不 push、不发 npm。
