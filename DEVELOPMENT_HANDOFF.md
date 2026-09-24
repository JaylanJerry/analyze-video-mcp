# Video MCP 开发交接

状态：v0.6.1 已在 npm（[`docs/SPEC_V061.md`](docs/SPEC_V061.md)、[ADR 0016](docs/decisions/0016-config-sources-and-evidence-audit.md)）。v0.6.0 基线见 [`docs/SPEC_V06.md`](docs/SPEC_V06.md)，未单独打 tag。推已授权的 `v*` tag 时，`release.yml` 用 Trusted Publishing 发 npm 并建 GitHub Release（[ADR 0014](docs/decisions/0014-npm-trusted-publishing.md)）。人须在 npm 包设置里点一次 Trusted Publisher。不要添加 `NPM_TOKEN`。不要补打已发 npm 的 `v0.5.1` / `v0.5.2`，也不要补打 `v0.6.0`。

基线快照：`sommio/qwen-omni-mcp@8a07182554a985456153644e0006a22bd1c769f7`。

工作区 git 根：本目录（见 ADR 0006、ADR 0011）。

本地分支：以当前工作分支为准。

## 当前产品

v1 已本机收尾。V2 已实施。安装：钉版本 `npx` + 显式 MCP `env` 里的 Key + `QWEN_ALLOWED_ROOTS`；Agent 应转发或整理 `question`。

已在 Windows Node 24 + Cursor 上验证：中文文件名小视频、口播、496.8 MiB 漫剧。示例 Host 键是 `analyze_video_mcp`；已装的旧键（`analyze-video` / `mcp_analyze_video`）可继续用。

## 下一阶段

P0（0.6.1）已发布。纯音频 / FFmpeg / `audit_media` 推迟到 [`docs/SPEC_V07.md`](docs/SPEC_V07.md)，须另批 ADR。

2026-09-22 后续优化交接：用户指定先处理 Codex 中“手动拖入任意文件夹视频”的体验，再按音频和综合审核路线开发。接手步骤、无付费 Codex 探针与分阶段验收见 [`tasks/deepseek-v07-handoff.md`](tasks/deepseek-v07-handoff.md)。A 批代码已落地（默认行为未变），B 批按“先复现再修”进行。

2026-09-22 拖入体验结论：A1 探针证明 Codex 只把拖入视频写成模型可读的路径文本，MCP 边界拿不到可验证附件，用户据此否决确认弹窗，选定安装级开关 `QWEN_ALLOW_ANY_LOCAL_VIDEO`（默认 `off`；`on` 时任意本地受支持视频路径直接上传，路径即授权）。决策与代价见 [ADR 0021](docs/decisions/0021-allow-any-local-video-opt-in.md)。状态分层见 [`tasks/todo-v07-proposal.md`](tasks/todo-v07-proposal.md) 与 [`tasks/deepseek-v07-handoff.md`](tasks/deepseek-v07-handoff.md)：代码与 CLI 开关验证已完成；用户授权后的真实 MOV 脚本调用、MP4 MCP 工具调用已成功。**2026-09-23 Codex 桌面 GUI 已用公开 3 秒夹具完成一次拖入 → MCP 调用 → 画面及语音数字正确返回，用户报告未出现批准或风险审查提示**；较大文件和其它目录的 GUI 情形未验证。一次真实 MOV 调用在取凭证阶段返回 `request_failed`、重试成功，失败原因仍未知；《AE海-通义.mp4》模型回答未确认音频，本地与受控替换音轨的对照证据见协议文档。该分支尚未进入已发布版本。

绑定文档：

1. [`docs/SPEC_V061.md`](docs/SPEC_V061.md)
2. [`docs/decisions/0016-config-sources-and-evidence-audit.md`](docs/decisions/0016-config-sources-and-evidence-audit.md)
3. [`docs/SPEC_V06.md`](docs/SPEC_V06.md)
4. [`docs/decisions/0015-host-reliability-and-evidence-gate.md`](docs/decisions/0015-host-reliability-and-evidence-gate.md)
5. [`docs/decisions/0014-npm-trusted-publishing.md`](docs/decisions/0014-npm-trusted-publishing.md)
6. [`docs/SPEC_V07.md`](docs/SPEC_V07.md)
7. [`docs/decisions/0017-host-config-key-analyze-video-mcp.md`](docs/decisions/0017-host-config-key-analyze-video-mcp.md)

## 硬规则

- 不改变 `analyze_video` 的名称与字段。
- 不增加生产依赖。不要从本机主动推送或 `npm publish`，除非用户明确要求。已授权的 `v*` tag 由 `release.yml` 发 npm。
- 不读取、复制、打印或提交密钥或 `text/*.key`。
- 私人 live fixture 留在 `text/`。CI 用 `test/fixtures/live-av.mp4`。
- 付费 live 必须用户明确授权。

## 接手者先读

v1 背景仍按原顺序：`AGENTS.md`、`docs/SPEC.md`、`docs/API_CONTRACT.md`、架构 / 协议 / 安全 / 测试、`tasks/todo.md`、`docs/REVIEW_GATES.md`。

然后读通用方向四份文档。实现方向与已接受 ADR 冲突时，必须先有新 ADR 被批准。

## 给下一模型的启动提示词

```text
你在 analyze-video-mcp 仓库根工作。v1 / V2 / 安装 / v0.5.x / v0.6.1 已发布。下一阶段是 v0.7，见 docs/SPEC_V07.md。
默认安装钉 analyze-video-mcp@0.6.1。不要改 analyze_video
字段，不要加依赖，不要读密钥。不要本机 npm publish。已授权的 v* tag 由 release.yml 发 npm。
不要在本轮实现 analyze_audio、FFmpeg 或 audit_media。
```
