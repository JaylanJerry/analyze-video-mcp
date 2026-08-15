# ADR 0012：v0.5.0 运行时、时长边界与工程收口

- Status: Accepted
- Date: 2026-08-15

## Context

v1 / V2 / npx 安装已经本机收尾，公开标签仍是 `v0.4.0`。main 相对该标签已有扁平化、prepare、coverage、安全和 Live Smoke，但 `package.json` 与 MCP initialize 仍报 `0.4.0`。同时：

- Node 20 已 EOL，`engines` 与 CI 仍包含 20（ADR 0005）。
- 生产 `import "dotenv/config"`。dotenv 17 会向 stdout 打字，而 stdout 是 MCP JSON-RPC。
- 官方 Qwen3.5-Omni 单视频上限 1 小时，产品只查文件大小。
- `bailian.ts` 仍保留非流式 `analyze()`。SSE buffer 无上限。安装 E2E 只跑 Ubuntu。仓库没有 ruleset，GitHub Release 也不是 immutable。

需要一次破坏性但范围清楚的小版本，把运行时和支持边界收口，而不是继续在 `0.4.x` 上假装兼容 Node 20。

## Decision

批准 [`SPEC_V05.md`](../SPEC_V05.md) 后：

1. 进入 **`0.5.0`**。`engines.node` 改为 `>=22`。CI 主矩阵 Node 22/24。不测 Node 20。可选 Node 26 compat 失败不挡合并，且不进入 `required-ci`。`#main` 在该变更合入后即要求 Node 22；`#v0.4.0` 保持该标签当时的 Node 20+ 语义。
2. 生产移除 dotenv；`.env` 可选，不是启动前置。`node dist/index.js` 不再自动加载 `.env`。不升级 dotenv 17。
3. 本地 MP4 在同一 FileHandle 上做无依赖 duration probe（box header + seek，支持 32/64-bit size 与 `mvhd` v0/v1）。**大于 3600 秒** 返回 `VIDEO_TOO_LONG`（`retryable: false`，`stage: authorized`，diagnostic 无绝对路径）；正好 3600 允许。读不出则放行。HTTPS 不 probe。这是加性错误码，不是 Tool schema breaking。
4. 删除非视频 `analyze()` API。不重命名 `bailian.ts`。
5. SSE 与累计回答各设 `MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024`（UTF-8 字节，不是 `string.length`）。超限立即 `PROVIDER_RESPONSE_INVALID`，不得先拼进超大 string。无 boundary 超限与单 event 超限都必须拒绝。
6. 两阶段发版：tag `v0.5.0` 指向安装钉仍为 `#v0.4.0` 的 commit；`release.yml` 只校验并创建 Release，不改文件、不 push、不移动 tag；Release 存在后另一次提交把 main 的安装钉改为 `#v0.5.0`。`v0.4.0` 标签不移动；其文案去掉「不可变」。
7. 打 `v0.5.0` 之前，对 **该 exact SHA** 证明：version 一致、`required-ci` 绿、production audit 绿、跨平台 install E2E 绿、同一 SHA 的 Live Smoke 绿、immutable 已开、ruleset 已生效。Live Smoke 不得用其它 SHA 的绿 run 代替。
8. 不发 npm。Ruleset 由管理员配置，required check 仅为聚合 job `required-ci`。工具链升级拆成四项：SDK manifest baseline、Vitest 4、Zod 4、lint-staged 17。

本 ADR 批准后，取代 ADR 0005「保持 Node >=20」和 ADR 0010「根 package 必须声明 dotenv」。ADR 0007（本机 Node 24 验收）仍有效。

## Alternatives

1. 发 `0.4.1` 仍声明 Node 20：拒绝；EOL 运行时不应继续出现在 engines。
2. 升级 dotenv 17 并设 `quiet: true`：拒绝；Host 已注入环境变量，生产不需要 dotenv；该库默认写 stdout，不适合 MCP。
3. 继续在生产加载 dotenv 16：拒绝；Host 路径不需要它，留着仍是 stdout 风险与多余依赖。
4. 用 ffprobe 测时长：拒绝；违反「不增加生产依赖」。
5. HTTPS 也下载再测时长：拒绝；与「本机不下载 URL」冲突。
6. 缺 `mvhd` 则当超长拒绝：拒绝；会误杀合法 fMP4。unknown 放行是有意残余。
7. 复用 `UNSUPPORTED_VIDEO` / `VIDEO_FILE_TOO_LARGE`：拒绝；时长不是类型或体积。新码 `VIDEO_TOO_LONG` 为加性契约。
8. 把 3600 做成环境变量：拒绝；这是模型政策边界，不是用户旋钮。
9. 在打 tag 的同一 commit / 同一 workflow 里改 README 安装钉：拒绝；tag 已指向旧树，又禁止移动 tag，会形成无法执行的循环。
10. 把 MCP SDK range 与 Vitest 4 放进同一任务：拒绝；规格要求依赖升级拆开，即使 SDK 只改 manifest。
11. SSE 硬顶用 `string.length` /「4 MiB 字符」：拒绝；MiB 是字节，JS length 是 UTF-16 code unit。
12. 本轮同时升 Vitest 4、Zod 4、ESLint 10、TS 7：拒绝；工具链拆开，TS 7 超出 typescript-eslint 支持范围。
13. 立刻发 npm：拒绝；安装路径仍是 GitHub `npx` 标签。
14. 把 `v0.4.0` 标签改指扁平化后的树：拒绝；已发布标签不移动。
15. 重命名 `bailian.ts` 为 `provider/qwen.ts`：拒绝；本轮只删遗留 API，改路径另开任务。

## Consequences

- 仍在 Node 20 上跑 MCP、并且跟 `#main` 的人必须升级 Node。跟 `#v0.4.0` 的人不受本次 engines 变更影响。文档必须分轨道写清。
- initialize 在 GitHub Release 存在之前就会报 `0.5.0`；npx 默认钉仍是 `#v0.4.0`，直到 post-release 文档任务。这是接受的暂时不一致。
- `node dist/index.js` 与 `npm start` 不再读 `.env`；本机开发用可选的 `npm run dev`。缺 `.env` 不得阻止进程启动。
- 部分 fMP4 / 坏 `mvhd` 的超长文件会漏到 Provider。写入 [`SECURITY.md`](../SECURITY.md)。
- 管理员必须先开 immutable releases 和 `required-ci` ruleset，否则 `v0.5.0` 仍可能被移动标签，或 required checks 随 matrix 名漂移。
- 版本扫描不碰 `qwen-omni-mcp/`。
