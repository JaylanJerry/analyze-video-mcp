# Video MCP v0.5.0 规格

状态：**已批准。** 按 [`../tasks/todo-v05.md`](../tasks/todo-v05.md) 实施；一次一项。

这是工程卫生与产品边界收口，不是新视频能力。Agent 仍只看到 `analyze_video(video, question?)`。不发 npm，除非另批。公开安装仍是 GitHub `npx` 标签。

对照：Codex 2026-08-15 仓库审计。已核对：`engines` 仍 `>=20`、CI 测 Node 20、版本号仍 `0.4.0`、`import "dotenv/config"`、`analyze()` 遗留、SSE 无 buffer 上限、安装 E2E 仅 Ubuntu、无 release workflow、无 repository ruleset。官方 Qwen3.5-Omni 内容分析单视频上限仍为 1 小时。

## 1. 目标

把 main 上已经落地、但版本与安装说明还停在 `v0.4.0` 的产品收成一次可安装的 **`v0.5.0`**。

源码与 MCP initialize 先改为 `0.5.0`。GitHub 标签、Release、README/examples 的 npx 钉在打标签与事后文档钉住时对齐。过渡期内允许「源码已是 0.5.0、稳定安装钉仍是 `#v0.4.0`」；这不是缺陷。

本轮要收口：

- 运行时只支持仍在安全更新窗口内的 Node；
- 发版前对 **即将打 tag 的 exact SHA** 证明 CI / audit / 安装 E2E / Live Smoke，且未来 Release 在 Settings 开启 immutability 之后创建；
- 本地视频在上传前挡住超过 1 小时的文件；
- stdio MCP 的 stdout 不被 dotenv 污染；
- 删掉非视频路径的 provider 遗留 API，并给 SSE 加上按 UTF-8 字节计的硬上限。

## 2. 保持不变

- 唯一 Tool：`analyze_video(video, question?)`。不加字段。允许在错误码表中新增 `VIDEO_TOO_LONG`（加性契约，不是 Tool breaking）。`0.5.0` 的 breaking 理由是停 Node 20。
- 成功只回文本；错误脱敏。
- 本地主路径：授权 FileHandle → 流式 multipart → `oss://` → SSE。
- 禁止 Base64、整文件 `readFile()`、新增生产依赖、自动重传整个大文件。
- 模型仍是 `qwen3.5-omni-flash`。
- TypeScript 留在 5.9.x；不升 TS 7。ESLint 10、Prettier、MSW 本轮不动。
- 不发 npm。代码 PR 不主动 push。打 `v0.5.0` 标签必须另一次明确授权（推 tag 也是 push）。

## 3. 要改的

| 项       | 现在                              | v0.5.0                                                                   |
| -------- | --------------------------------- | ------------------------------------------------------------------------ |
| Node     | `>=20`，CI 含 20                  | `>=22`；CI 主矩阵 22/24；可选非阻断 26                                   |
| 包版本   | `0.4.0`，main 已漂移              | 源码改为 `0.5.0`。安装钉在 **Release 存在之后** 由独立任务改成 `#v0.5.0` |
| dotenv   | 生产 `import "dotenv/config"`     | 生产移除。Host 传环境变量。本地 `npm run dev` 可选读 `.env`              |
| 视频时长 | 只查大小和 ftyp                   | README 写清 1 小时；本地 MP4 轻量 probe；HTTPS 不下载                    |
| Provider | `analyzeVideo` + 遗留 `analyze()` | 只留视频 SSE 路径                                                        |
| SSE      | buffer 无上限                     | UTF-8 字节硬顶 4 MiB；超限 `PROVIDER_RESPONSE_INVALID`                   |
| 安装验证 | 仅 Ubuntu                         | 至少 Ubuntu + Windows 的 npx/pack；再加 macOS Node 24 smoke              |
| Release  | 人工同步多处版本                  | tag 触发 `release.yml` 建 Release；事后再钉文档                          |
| 仓库门禁 | 无 ruleset                        | 用户开 immutable releases；ruleset 只要求聚合检查 `required-ci`          |

## 4. Node 22+

Breaking change，所以是 `0.5.0` 不是 `0.4.1`。`npx ...#main` 在 V01 合入后即要求 Node 22；`npx ...#v0.4.0` 仍按该标签当时的 Node 20+ 声明。

- `engines.node`: `>=22`
- `@types/node`: 22
- CI `test` 矩阵删除 Node 20；保留 Ubuntu/Windows × 22/24
- 增加聚合 job `required-ci`：`needs` 全部 blocking jobs（至少 typecheck、lint、format、test 矩阵、coverage、audit-prod、build、install-e2e；跨平台安装 E2E 落地后也列入）。Node 26 compat **不得** 进入 `needs`。失败不挡合并。
- 用户面向的 Node 文案在 Release 前必须区分轨道，避免把 Node 22+ 写到仍指向 `#v0.4.0` 的安装段：

```text
即将发布的 v0.5.0 / 跟 #main：需要 Node 22 或更新。
当前稳定安装 #v0.4.0：以该标签当时的说明为准（Node 20+）。
```

- 取代 ADR 0005「保持 Node >=20」中的工程兼容目标；Gate 1 仍以本机 Node 24 为准（ADR 0007）

## 5. 版本与两阶段 Release

版本源：`package.json`、`src/version.ts` 必须同号。`test/version.test.ts` 只断言二者相等，不写死数字。脚本里的 MCP client `version` 读 `PACKAGE_VERSION`。版本扫描范围是**仓库根**（`package.json`、`src/`、`test/`、`scripts/`、`examples/`、根文档）。不扫描、不修改 `qwen-omni-mcp/`。

禁止用同一个 commit / 同一个任务既打 `v0.5.0` 又改 README 安装钉。Git 状态机是：

```text
commit A（安装钉仍 #v0.4.0）
  → 人推 tag v0.5.0 指向 A
  → release.yml 校验并创建 Release（不改文件、不 push、不移动 tag）
  → 之后的 commit B 把 main 的 README/examples 改为 #v0.5.0
```

`v0.5.0` 标签必须一直指向 A。现有 `v0.4.0` 标签不移动；若 Release 文案写了「不可变」，改为「已发布标签，不要移动」。

用户在推 `v0.5.0` **之前** 于 Settings 开启 immutable releases。该开关只对之后的 Release 生效。

`release.yml`：仅在 tag `v*` 上跑；断言 `tag == v${package.version}` 且与 `PACKAGE_VERSION` 一致；跑 pack / npx probe；然后 `gh release create`。不发 npm。不修改工作树。

### 5.1 Release 前置（对即将打 tag 的 exact SHA）

在创建 `v0.5.0` 标签之前，必须证明 **该 SHA**（不是「最近某次」）同时满足：

1. `package.json` / `PACKAGE_VERSION` / 将要打的 tag 一致；
2. blocking CI 全绿（`required-ci`）；
3. production audit 全绿（`npm audit --omit=dev`）；
4. 跨平台 install E2E 全绿；
5. Live Smoke 针对 **同一 SHA** 成功；
6. immutable releases 已开启；
7. `main` / `v*` ruleset 已生效，且 required check 为 `required-ci`。

Live Smoke 不得用「这周某个绿的 run」代替。绑定方式：workflow run 的 `github.sha` 等于将要打 tag 的 commit，或文档记录该 SHA 与成功 run URL。

## 6. 仓库 Ruleset（人在 GitHub Settings 操作）

代码仓库无法代替这项。最低要求：

- `main`：禁止 force push 与删除；required status check **只** 要求 `required-ci`。不要把 matrix 展开名（如 `test (ubuntu-latest, 22)`）写进 ruleset。
- `v*`：限制更新与删除。
- 开启后用 `gh api` 确认 ruleset 非空。

## 7. 一小时时长

官方内容分析场景：Qwen3.5-Omni 单视频最长 1 小时。本产品落实为：

- README / Tool 描述写清：一次最多 1 小时；本地还受 1024 MiB 与当场 policy 约束。
- 本地 MP4：在已打开的同一 FileHandle 上做轻量 duration probe。时长 **大于 3600 秒** 拒绝；**正好 3600 秒允许**。发生在取 policy / 上传之前，错误码 `VIDEO_TOO_LONG`。
- `VIDEO_TOO_LONG`：`retryable: false`；`stage` 为 `authorized`；diagnostic 不得含本地绝对路径。
- 解析约束：支持 ISO BMFF 的 32-bit size 与 64-bit largesize，以及 `mvhd` version 0/1。malformed box、非法 size、`timescale == 0`、未找到 `moov/mvhd` → 时长 unknown，**放行**，不得报 `VIDEO_TOO_LONG`。HTTPS 不 probe。
- 不得为找 `mvhd` 顺序读完整文件。必须 box header + seek。探测读入的总字节应远小于文件大小，且与 1 GiB 文件解耦。
- 夹具必须是合成 `mvhd` 头，不得把真实 ≥1 小时视频提交进仓库。
- 不把 duration 放进 Tool schema。不得引入 ffprobe / mp4box。残余风险写入 `docs/SECURITY.md`。

## 8. 移除 dotenv

stdio 的 stdout 是 JSON-RPC。dotenv 17 默认向 stdout 打 injection 消息，升级它比删掉更危险。

- 从 `dependencies` 删除 `dotenv`。`src/` 不再 import dotenv。生产只读 `process.env`。`node dist/index.js` 不再自动加载 `.env`。
- `.env` 是可选开发便利，**不得**成为启动前置条件。`npm run dev` 在 `.env` 不存在时必须仍能拉起进程；缺 Key 才按现有配置错误失败。实现：仅当文件存在时才传 `--env-file`，或等价脚本。不新增依赖。
- stdout 验收不是「启动 N 毫秒无输出」。稳定口径：raw spawn MCP server → 写入 initialize 请求 → **第一条** stdout protocol record 必须是合法 MCP/JSON-RPC 响应；其前不得有其它 stdout 字节。
- 取代 ADR 0010「根 package 必须声明 dotenv」。

## 9. Provider 与 SSE

- 删除 `AnalyzeParams`、`AnalyzeResult`、`BailianError`、`buildPayload`、`analyze()`、`thinkingBudget`、`maxTokens` 及只为它们存在的测试。
- 保留 `contentBlock` / `buildVideoPayload` / `analyzeVideo`。本轮 **不** 重命名文件为 `provider/qwen.ts`。
- SSE 硬顶按 **UTF-8 字节**，不是 `string.length`：

```text
MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024
```

未完成 SSE event 按接收到的 UTF-8 输入字节累计；累计回答按将要输出文本的 UTF-8 字节累计。两份独立预算，任一超过立即 `PROVIDER_RESPONSE_INVALID`，不得截断装成成功。必须在把超限 chunk 拼进 JS string 之前拒绝。

必须覆盖：无 boundary 的 >4 MiB 输入失败；**带 boundary 的单个 >4 MiB SSE event 也失败**。

- `requestId` 写入 stderr 前滤成可打印单行（拒绝控制字符与换行）。

## 10. 安全与 CI 硬化

- `parseHttpsVideoUrl` 补全字面量：IPv6 ULA / link-local / IPv4-mapped IPv6 / 未指定地址。不做 DNS SSRF。
- 所有 `actions/checkout` 加 `persist-credentials: false`。
- 依赖升级必须拆开，禁止一把梭。**纯 manifest 的 SDK baseline 也不得与 Vitest 4 合并**：
  1. `@modelcontextprotocol/sdk` 声明基线到当前已测版本（lock 已是最新则只改 range）。
  2. Vitest 4 + `@vitest/coverage-v8`。
  3. Zod 4。
  4. `lint-staged` 17。
  5. 不升 TypeScript 7、ESLint 10。

## 11. 跨平台安装验证

- `npx-github-e2e` 与 `pack-install-e2e` 至少 Ubuntu + Windows。
- macOS + Node 24 的 smoke 是 initialize + `listTools`（可用 pack/install 握手，不强制再跑一遍 GitHub npx）。
- 删除 Node 20 后省出的 runner 预算优先给上述矩阵。
- 这些 job 在落地后纳入 `required-ci`。

## 12. 不做

- 不发 npm。
- 不改 `analyze_video` 字段。
- 不加图片 / 独立音频 Tool。
- 不引入 duration 库。
- 不升 dotenv 17。
- 不移动 `v0.4.0` 或 `v0.5.0` 标签。
- 本轮不删除工作区残留 `qwen-omni-mcp/`。
- 不在创建 Release 的同一 commit 里改安装钉。

## 13. 完成标准

对应 `tasks/todo-v05.md` 全部勾选，且：

- `engines` 为 `>=22`；CI 不再测 Node 20；存在 `required-ci`。
- initialize 报告 `0.5.0`。仓库根无第三处与 package 不一致的产品版本常量；`qwen-omni-mcp/` 除外。
- 生产依赖无 dotenv；initialize 前 stdout 无杂字节。
- 本地 duration >3600 秒在上传前返回 `VIDEO_TOO_LONG`；正好 3600 允许；unknown 放行。
- `analyze()` 遗留 API 不存在。
- SSE 超限（无 boundary 与单 event 超限）有测试。
- 工具链四项（SDK range、Vitest 4、Zod 4、lint-staged 17）各自独立完成。
- 跨平台安装 E2E 已落地。
- 仅在 §5.1 前置满足且用户授权后打 `v0.5.0`；Release 存在后再把安装钉改为 `#v0.5.0`。
- 未另说则不 push、不发 npm。
