# Video MCP v1 任务清单

规则：一次只做一个任务；每个任务结束填写“验证记录”。到 Review Gate 必须停止。

## 准备工作

- [x] P01 固定上游提交并创建本地实施分支。
- [x] P02 完成真实 policy/upload/Omni SSE 小视频协议验证。
- [x] P03 编写规格、架构、协议、安全、测试、ADR、计划与交接文档。
- [x] P03b 工作区根初始化为唯一 git 仓库；交接包被接手模型接受为实施基线。
- [x] P04 用户允许安装依赖后执行 `npm install` 并记录基线质量门。

P04 验收：未改代码前的 typecheck、lint、format、test、coverage、build、`npm audit --omit=dev` 有记录。不得为修复 audit 擅自升级。

验证记录（2026-08-15，未改业务代码，未 `audit fix`，未 `prettier --write`）：

- 环境：Windows，Node v24.18.0（CI 矩阵为 20/22），npm 12.0.2。
- `npm install`：395 packages；`package-lock.json` 未改。
- husky `prepare`：在 `qwen-omni-mcp/` 内找不到 `.git`（git 根在工作区根，ADR 0006）。`core.hooksPath` 未设置。未改 git config。
- install-scripts 被拦：`esbuild`、`msw`；`node_modules/esbuild/bin/esbuild` 仍存在。
- typecheck：通过。
- lint：通过。
- format:check：失败，35 个文件。工作区部分已跟踪 LF 文件以 CRLF 检出（如 `src/config.ts` 为 `i/lf w/crlf`）。
- test：81 通过，5 skipped（live），1 失败。`toDataUrl` 的 `chmod(0o000)` 在 Windows 上仍可读，属上游 Unix 权限用例，不是实现回归。
- coverage：未产出报告；与上一失败相同，阈值未评估。配置门槛为 lines/functions/statements 85、branches 75。
- build：通过，`dist/` 已生成且被 gitignore。
- `npm audit --omit=dev`：2 个生产漏洞（`fast-uri` high，`hono` moderate）。未升级。

## T01：配置与安全错误模型

文件预算：`src/config.ts`、`src/errors.ts`、`test/config.test.ts`、`test/errors.test.ts`、`.env.example`。

- [x] 默认模型改为 `qwen3.5-omni-flash`。
- [x] 加入 allowed roots、upload URL、分阶段 timeout、500 MiB 上限、0/1 retry 配置。
- [x] 配置 URL 强制 HTTPS，数值有上下界。
- [x] 建立内部 typed errors 与 Agent-safe message。
- [x] 删除任何 key 首尾展示行为。

验收：所有新分支有单元测试；错误不包含输入 secret；现有相关测试更新。

验证：`npm test -- test/config.test.ts test/errors.test.ts`、typecheck、lint。

验证记录（2026-08-15）：

- `npx vitest run test/config.test.ts test/errors.test.ts`：15 通过。
- 相关回归 `test/tools.test.ts` `test/bailian.test.ts`：36 通过。
- `tsc --noEmit`：通过。
- eslint（config/errors/server/bailian 及对应测试）：通过。
- `check_endpoint_status` 只输出 `api_key: "configured"`，不再做首尾脱敏。
- `QWEN_OMNI_MODEL` 仍保留到 T06，避免五 Tool 在中途无法编译。

## T02：本地视频授权与 FileHandle

文件预算：`src/media.ts`、`test/media.test.ts`，必要时一个平台测试 helper。

- [x] 只接受 HTTPS URL 或本地绝对 MP4。
- [x] 实现 real allowed roots 与 containment。
- [x] 实现 realpath/stat/open/fstat/recheck 流程。
- [x] 从同一 FileHandle 校验 MP4 magic、普通文件、非空和 500 MiB。
- [x] symlink/junction 越界拒绝；上传接口只能拿到已授权句柄。

验收：[`docs/SECURITY.md`](../docs/SECURITY.md) 的 media 用例通过；无大文件 `readFile()`/Base64。

验证：`npm test -- test/media.test.ts`、Windows 平台测试、typecheck、lint。

验证记录（2026-08-15）：

- `npx vitest run test/media.test.ts`：50 通过，1 skipped（Windows 上 chmod 无权限语义）。
- 中文/junction：允许根内 junction 通过，越界 junction 拒绝。
- Windows 盘符 `C:\` 不再被当成 URL scheme。
- `tsc --noEmit` 与 eslint 通过。
- 既有 image/audio Base64 helper 仍保留到 T06，以免五 Tool 中途断裂。

## T03：policy 与 multipart 流式上传

文件预算：`src/upload.ts`、`test/upload.test.ts`，必要时一个测试 HTTP helper。

- [x] Zod 解析 policy，动态校验 `max_file_size_mb`。
- [x] 实现无整文件缓冲的 multipart 流。
- [x] 随机对象 key，固定安全 filename。
- [x] timeout/abort/响应释放/句柄关闭正确。
- [x] 上传失败不自动重传。
- [x] 完成 50 MiB 与 500 MiB mock RSS 测量。

验收：wire fields、hash、零字节提前拒绝、内存与脱敏均通过。

验证：`npm test -- test/upload.test.ts`、内存脚本、完整质量门。

验证记录（2026-08-15）：

- `npx vitest run test/upload.test.ts`：10 通过。
- 相关回归 config/errors/media/tools/bailian：111 通过，1 skipped（Windows chmod）。
- 完整 `vitest run`：111 通过，6 skipped（含 live）。
- `tsc --noEmit` 与 `tsc -p tsconfig.build.json`：通过。
- eslint（upload/config/errors/media）：通过。
- 空文件与已 abort 的 signal 在 policy GET / 上传 POST 之前失败。
- policy 上限不足时 `uploadPosts=0`。
- 小文件 wire：字段名符合协议，`file` 最后，`filename=video.mp4`，sha256 与输入一致。
- **`fetch` + `duplex:"half"` 在 Node 24 / Windows 上会把 500 MiB 整包缓冲（RSS ≈540 MiB）。已改为 Node 内置 `http`/`https.request` 管道，无新依赖。**

RSS 增量（Node v24.18.0，Windows，单位 byte）：

| 大小    | stream     | fetch/pipe |
| ------- | ---------- | ---------- |
| 50 MiB  | 19–37 MiB  | -26–16 MiB |
| 500 MiB | -22–21 MiB | 17–31 MiB  |

500 MiB pipe RSS 远低于 128 MiB 目标与 192 MiB 硬上限，且不随文件线性增长。本机未安装 Node 20/22，Gate 1 要求的双版本表缺这两列。

### STOP — Gate 1

2026-08-15 用户批准按本机 Node 24 放行（ADR 0007）。不补测 Node 20。已开始 T04。

## T04：SSE 增量解析器

文件预算：`src/sse.ts`、`test/sse.test.ts`。

- [x] 实现 TextDecoder 增量 UTF-8 与 SSE event framing。
- [x] Zod 解析 delta、finish、usage。
- [x] 聚合 text，处理 `[DONE]`、usage-only、CRLF 与任意分块。
- [x] 截断、非法 JSON、空回答返回稳定错误。

验收：测试矩阵全部通过，分支 coverage 达标。

验证：`npm test -- test/sse.test.ts`、coverage、typecheck、lint。

验证记录（2026-08-15）：

- `npx vitest run test/sse.test.ts`：14 通过。覆盖单 chunk、逐字节、多 event 同块、CRLF、中文 UTF-8 跨块、role/empty/finish/usage-only、`[DONE]`、无终端截断、空回答、非 JSON 脱敏、数组 content 拒绝、半截 event。
- `tsc --noEmit`：通过。
- eslint `src/sse.ts` `test/sse.test.ts`：通过。
- `delta.content` 只接受 string；数组走 Zod 失败，不拼接。

## T05：Qwen3.5-Omni-Flash Provider

文件预算：`src/bailian.ts`、`test/bailian.test.ts`、`test/live.test.ts`，若获用户许可可增加一个小型 fixture。

- [x] payload 固定 `stream:true`、usage、text modality、单个 video block。
- [x] `oss://` 才添加 resolve header。
- [x] 分析 timeout 与有限重试符合协议文档。
- [x] 不发送 Thinking 或音频输出参数。
- [x] 默认测试完全 mock。
- [x] live 命令缺前置条件时明确失败，不再假绿。
- [x] 用户授权后跑小型 AV，语义同时命中视觉 `24` 与音频 `3.1415926`。

验收：mock 契约和真实语义均通过；request id 可诊断但不对 Agent 暴露。

验证：provider/SSE 测试、授权后的 live、完整质量门。

验证记录（2026-08-15）：

- 新增 `buildVideoPayload` / `analyzeVideo` / `createVideoAnalyzer`。旧 JSON `analyze()` 仍保留到 T06。
- payload 固定：`stream:true`、`modalities:["text"]`、`stream_options.include_usage`、单个 `video_url` block；无 `thinking_budget` / `enable_thinking`。
- 仅 `oss://` 或 `requiresOssResolve` 添加 `X-DashScope-OssResourceResolve: enable`。HTTPS 不加。
- 首字节前：429（尊重 `Retry-After`，上限 30s）、502/503、连接失败可自动重试至多 1 次。500 不重试。timeout 不重试。有 SSE 文本后截断不重试。
- 真实 Omni SSE 首包带 `usage: null` 与可选 `delta.content: null`。解析器按空 usage / 空 delta 忽略，未改 payload 契约。
- `npx vitest run test/bailian.test.ts`：27 通过。
- `npx vitest run test/sse.test.ts`：19 通过。
- 默认套件中 live 仍 skip。进程环境测完已清除 key。

Live（仓库外短视频，未入库；不记录路径/key/OSS）：

| 次  | 提问侧重                           | 视觉 `24` | 音频 `3.1415926` | events | elapsed_ms | request id                                      |
| --- | ---------------------------------- | --------- | ---------------- | ------ | ---------- | ----------------------------------------------- |
| 1   | 默认「详细说明视频内容」           | 命中      | 未命中           | 49     | 1556       | `chatcmpl-d2825e6c-c203-9a0d-a027-8a016c900121` |
| 2   | 明确要求分别写出画面数字和音频朗读 | 命中      | 命中             | 31     | 1456       | `chatcmpl-1d7ae164-b7e2-94c1-9fd3-2716858b634c` |

HTTP 均为分析阶段成功（SSE 聚合完成）。第 2 次同时命中两个语义 token。默认产品问句可能只描述画面，T06 的 server instructions / 默认 question 需要强调声音。

### STOP — Gate 2

T05 mock + 真实语义已齐。等待主审核。未开始 T06。

## T06：唯一 MCP Tool 与生命周期

文件预算：`src/server.ts`、`src/index.ts`、`test/tools.test.ts`，必要时一个 lifecycle test。

- [x] 删除四个非目标 Tool，只注册 `analyze_video`。
- [x] schema 与 [`API_CONTRACT.md`](../docs/API_CONTRACT.md) 完全一致。
- [x] server instructions 强调画面 + 内嵌音频联合分析。
- [x] 本地与 HTTPS 输入接入同一内部 provider。
- [x] Agent 成功/错误输出符合契约并脱敏。
- [x] SIGINT/SIGTERM/Host close 取消活跃操作。
- [x] 同一时间只允许一个活跃调用，其他调用返回 `VIDEO_ANALYSIS_BUSY`。
- [x] stdout 保持纯 MCP。

验收：MCP 内存 E2E、取消和输出捕获通过。

验证：`npm test -- test/tools.test.ts`、完整质量门。

验证记录（2026-08-15）：

- 只注册 `analyze_video`。公开字段只有 `video`、`question`、`max_tokens`。无 `thinking_budget` / `video_url` / 模型字段。
- 默认 `question` 改为 `画面里发生了什么？音频说了什么？`。发给模型的文本固定包一层「必须同时看画面、听内嵌音轨」约束。
- HTTPS 走 `analyzeVideo`；本地走 `resolveVideo` + 流式上传 + 同一 analyzer。句柄在 `finally` 关闭。
- 成功只回一个 text content。错误走 `agentErrorText`，不含 key / 路径 / `oss://`。
- 第二路并发立即 `VIDEO_ANALYSIS_BUSY`，不发起第二次上传。
- `abortActiveAnalysis` 取消进行中的分析；`index.ts` 在 SIGINT/SIGTERM/stdin end|close 时调用。
- 诊断只写 stderr（`code/stage/http/request_id`）。stdout 不写业务日志。
- `npx vitest run test/tools.test.ts`：12 通过。
- 完整 `vitest run`：133 通过，2 skipped（live + Windows chmod）。
- `tsc --noEmit` 与 `tsc -p tsconfig.build.json`：通过。
- 未宣称消除 Windows 同账户 TOCTOU 残余风险。
- 上游 README / `AGENTS.md` 仍写五 Tool，留给 T08。

### STOP — Gate 3

T06 已完成。用户授权在必须询问之外自行推进。T07 已完成。

## T07：CI 与 Windows 验证

文件预算：相关 `.github/workflows/*.yml`、必要的 Windows 测试 helper，不超过 5 个文件。

- [x] 常规 CI 保留 Node 20/22。
- [x] 增加 Windows Node 22 单元/mock job。
- [x] 确认中文路径、空格、junction 用例在 Windows 执行。
- [x] Live job 没有 key 时 job 明确不调度；被调度后缺 fixture 必须失败。

验收：CI 配置可解析，本地可模拟的命令通过。

验证记录（2026-08-15）：

- 工作区 git 根在 `Video MCP/`，因此在仓库根增加 `.github/workflows/ci.yml` 与 `smoke-live.yml`（`working-directory: qwen-omni-mcp`）。实现目录内工作流同步更新。
- Ubuntu job：Node 20/22，typecheck / lint / format:check / test / build。
- Windows job：Node 22，typecheck / lint / test / build。不跑 `format:check`（本机 CRLF 基线失败，见 P04）。
- `test/media.test.ts` 增补中文路径、空格路径；junction 用例已有。本机 Windows Node 24：`media.test.ts` 52 通过，1 skipped（chmod）。
- Live：`if: secrets.DASHSCOPE_API_KEY != ''`，无 key 不调度。被调度后若 `QWEN_LIVE_VIDEO` 为空，job 非零退出。默认 `npm test` 仍 skip live。
- 未推送，远端 CI 尚未实际跑过。

## T08：文档、版本与安装说明同步

文件预算：`README.md`、`package.json`、必要的版本单一来源文件、`DEVELOPMENT_HANDOFF.md`、一个 ADR 更新。

- [x] README 只描述已实现行为，不保留上游五 Tool/25MB Base64 宣称。
- [x] 提供安全 Agent Host 配置模板，key 不写入仓库。
- [x] package 版本与 MCP initialize 版本单一来源或严格一致。
- [x] 清楚标注临时存储北京区、48 小时、非高并发定位。
- [x] 将所有已知限制同步到 docs。

验收：文档命令可执行，描述与测试一致。

验证记录（2026-08-15）：

- `src/version.ts` 的 `PACKAGE_VERSION` 为 `0.4.0`；`package.json` 与 MCP initialize 共用。`test/version.test.ts` 断言一致。
- README 只写 `analyze_video`、500 MiB 流式上传、北京区 48 小时临时存储、非高并发。Host 配置示例不提交 key。
- ADR 0008 记录版本对齐与默认音视频问句。
- 未发布、未推送。T09 需要用户确认 Host 和测试视频。

## T09：Windows 500 MiB Agent E2E

文件预算：原则上不改代码；如发现 bug，回到对应任务并重新经过相关 Gate。

- [x] 用户确认真实 Agent Host 和测试视频。
- [x] 小型中文路径 AV 经 Host 调用，命中两个语义值。
- [x] 450–500 MiB、约 7 分钟 MP4 经 Host 完整调用。
- [x] 记录 upload/analysis 耗时、RSS、request id 和结果摘要。
- [x] 测试 Ctrl+C/Host 退出。
- [x] 执行完整质量门、coverage、audit、diff check。

验收：[`docs/SPEC.md`](../docs/SPEC.md) 的全部完成标准满足。

验证记录（2026-08-15，Windows Node v24.18.0，真实 MCP stdio，已授权付费）：

Host：Cursor / Codex / Claude Code 均走同一 stdio MCP。本次用 `scripts/t09-e2e.ts` 拉起 `dist/index.js` 做完整 `analyze_video` 调用。未把 key 写入任何 Host 配置。

视频（均在仓库外 `text/`，未入库）：

| 输入                                                 | 大小      | 时长  | 结果                                                                                                                                   |
| ---------------------------------------------------- | --------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `8月15日.mp4`（中文文件名）                          | 0.51 MiB  | 2.6s  | 成功。画面 `24`。音频写成「三点一四一五九二六」，未出现阿拉伯数字 `3.1415926`。1.9s，33 events，RSS 85 MiB，`chatcmpl-f2e0b376-…87f3b` |
| `口播测试/口播.mp4`（中文目录硬链接到 `1.mp4`）      | 119.7 MiB | 60.7s | 成功。描述女性口播家庭/教育，含讲话内容。31.3s，218 events，RSS 126 MiB，`chatcmpl-9a81527e-…d012`                                     |
| 原 `2.mp4`                                           | 564.4 MiB | 7:04  | 上传前拒绝 `VIDEO_FILE_TOO_LARGE`（0.2s）。产品上限 500 MiB 生效                                                                       |
| `2-under500.mp4`（从 `2.mp4` stream copy 截到 370s） | 496.8 MiB | 6:10  | 成功。画面古装绘地图 + 听到对白。103s，147 events，RSS 129 MiB，`chatcmpl-1dbc40c0-…781d85`                                            |

中止：上传中杀掉 stdio 父进程后，`dist/index.js` 残留为 0。

质量门：typecheck / lint / test 137 通过 2 skipped / coverage lines 87.45 branches 83.93 functions 92.39 / build 通过。`npm audit --omit=dev` 仍为 fast-uri high、hono moderate，未升级。`git diff --check` 通过（仅 CRLF 提示）。

已知限制：MCP SDK / 多数 Host 默认 tool timeout 60s，497 MiB 会先被客户端掐断；E2E 脚本把 timeout 调到 900s 后才跑通。在 Cursor / Claude Code / Codex 里用大视频必须把 Host 超时调到 ≥15 分钟。

Cursor Host 补证（2026-08-15，用户级 `user-analyze-video`）：

- `8月15日.mp4`：画面红色 `24`，音频「三点一四一五九二六」。
- `2-under500.mp4`：`max_tokens=8192` 后画面与对白写到片尾。
- 未在 Codex / Claude Code UI 各点一次；二进制相同。

未 commit、未 push、未发布。

### Gate 4 收尾

v1 按本机可用收尾，不标记已发布。通用方向规划在 [`plan-general.md`](plan-general.md) 与 [`todo-general.md`](todo-general.md)，批准前不改 500 MiB 契约上限。
