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

- [ ] 默认模型改为 `qwen3.5-omni-flash`。
- [ ] 加入 allowed roots、upload URL、分阶段 timeout、500 MiB 上限、0/1 retry 配置。
- [ ] 配置 URL 强制 HTTPS，数值有上下界。
- [ ] 建立内部 typed errors 与 Agent-safe message。
- [ ] 删除任何 key 首尾展示行为。

验收：所有新分支有单元测试；错误不包含输入 secret；现有相关测试更新。

验证：`npm test -- test/config.test.ts test/errors.test.ts`、typecheck、lint。

验证记录：待填写。

## T02：本地视频授权与 FileHandle

文件预算：`src/media.ts`、`test/media.test.ts`，必要时一个平台测试 helper。

- [ ] 只接受 HTTPS URL 或本地绝对 MP4。
- [ ] 实现 real allowed roots 与 containment。
- [ ] 实现 realpath/stat/open/fstat/recheck 流程。
- [ ] 从同一 FileHandle 校验 MP4 magic、普通文件、非空和 500 MiB。
- [ ] symlink/junction 越界拒绝；上传接口只能拿到已授权句柄。

验收：[`docs/SECURITY.md`](../docs/SECURITY.md) 的 media 用例通过；无大文件 `readFile()`/Base64。

验证：`npm test -- test/media.test.ts`、Windows 平台测试、typecheck、lint。

验证记录：待填写。

## T03：policy 与 multipart 流式上传

文件预算：`src/upload.ts`、`test/upload.test.ts`，必要时一个测试 HTTP helper。

- [ ] Zod 解析 policy，动态校验 `max_file_size_mb`。
- [ ] 实现无整文件缓冲的 multipart 流。
- [ ] 随机对象 key，固定安全 filename。
- [ ] timeout/abort/响应释放/句柄关闭正确。
- [ ] 上传失败不自动重传。
- [ ] 完成 50 MiB 与 500 MiB mock RSS 测量。

验收：wire fields、hash、零字节提前拒绝、内存与脱敏均通过。

验证：`npm test -- test/upload.test.ts`、内存脚本、完整质量门。

验证记录：待填写。

### STOP — Gate 1

按 [`docs/REVIEW_GATES.md`](../docs/REVIEW_GATES.md) 提交证据，等待审核。

## T04：SSE 增量解析器

文件预算：`src/sse.ts`、`test/sse.test.ts`。

- [ ] 实现 TextDecoder 增量 UTF-8 与 SSE event framing。
- [ ] Zod 解析 delta、finish、usage。
- [ ] 聚合 text，处理 `[DONE]`、usage-only、CRLF 与任意分块。
- [ ] 截断、非法 JSON、空回答返回稳定错误。

验收：测试矩阵全部通过，分支 coverage 达标。

验证：`npm test -- test/sse.test.ts`、coverage、typecheck、lint。

验证记录：待填写。

## T05：Qwen3.5-Omni-Flash Provider

文件预算：`src/bailian.ts`、`test/bailian.test.ts`、`test/live.test.ts`，若获用户许可可增加一个小型 fixture。

- [ ] payload 固定 `stream:true`、usage、text modality、单个 video block。
- [ ] `oss://` 才添加 resolve header。
- [ ] 分析 timeout 与有限重试符合协议文档。
- [ ] 不发送 Thinking 或音频输出参数。
- [ ] 默认测试完全 mock。
- [ ] live 命令缺前置条件时明确失败，不再假绿。
- [ ] 用户授权后跑小型 AV，语义同时命中视觉 `24` 与音频 `3.1415926`。

验收：mock 契约和真实语义均通过；request id 可诊断但不对 Agent 暴露。

验证：provider/SSE 测试、授权后的 live、完整质量门。

验证记录：待填写。

### STOP — Gate 2

按审核文档提交证据，等待审核。

## T06：唯一 MCP Tool 与生命周期

文件预算：`src/server.ts`、`src/index.ts`、`test/tools.test.ts`，必要时一个 lifecycle test。

- [ ] 删除四个非目标 Tool，只注册 `analyze_video`。
- [ ] schema 与 [`API_CONTRACT.md`](../docs/API_CONTRACT.md) 完全一致。
- [ ] server instructions 强调画面 + 内嵌音频联合分析。
- [ ] 本地与 HTTPS 输入接入同一内部 provider。
- [ ] Agent 成功/错误输出符合契约并脱敏。
- [ ] SIGINT/SIGTERM/Host close 取消活跃操作。
- [ ] 同一时间只允许一个活跃调用，其他调用返回 `VIDEO_ANALYSIS_BUSY`。
- [ ] stdout 保持纯 MCP。

验收：MCP 内存 E2E、取消和输出捕获通过。

验证：`npm test -- test/tools.test.ts`、完整质量门。

验证记录：待填写。

### STOP — Gate 3

按审核文档提交证据，等待审核。

## T07：CI 与 Windows 验证

文件预算：相关 `.github/workflows/*.yml`、必要的 Windows 测试 helper，不超过 5 个文件。

- [ ] 常规 CI 保留 Node 20/22。
- [ ] 增加 Windows Node 22 单元/mock job。
- [ ] 确认中文路径、空格、junction 用例在 Windows 执行。
- [ ] Live job 没有 key 时 job 明确不调度；被调度后缺 fixture 必须失败。

验收：CI 配置可解析，本地可模拟的命令通过。

验证记录：待填写。

## T08：文档、版本与安装说明同步

文件预算：`README.md`、`package.json`、必要的版本单一来源文件、`DEVELOPMENT_HANDOFF.md`、一个 ADR 更新。

- [ ] README 只描述已实现行为，不保留上游五 Tool/25MB Base64 宣称。
- [ ] 提供安全 Agent Host 配置模板，key 不写入仓库。
- [ ] package 版本与 MCP initialize 版本单一来源或严格一致。
- [ ] 清楚标注临时存储北京区、48 小时、非高并发定位。
- [ ] 将所有已知限制同步到 docs。

验收：文档命令可执行，描述与测试一致。

验证记录：待填写。

## T09：Windows 500 MiB Agent E2E

文件预算：原则上不改代码；如发现 bug，回到对应任务并重新经过相关 Gate。

- [ ] 用户确认真实 Agent Host 和测试视频。
- [ ] 小型中文路径 AV 经 Host 调用，命中两个语义值。
- [ ] 450–500 MiB、约 7 分钟 MP4 经 Host 完整调用。
- [ ] 记录 upload/analysis 耗时、RSS、request id 和结果摘要。
- [ ] 测试 Ctrl+C/Host 退出。
- [ ] 执行完整质量门、coverage、audit、diff check。

验收：[`docs/SPEC.md`](../docs/SPEC.md) 的全部完成标准满足。

验证记录：待填写。

### STOP — Gate 4

主审核者通过后，v1 才能标记可用。不要自动 commit、push、publish 或创建 PR。
