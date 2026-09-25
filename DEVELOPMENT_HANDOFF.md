# Video MCP 开发交接

状态：v0.6.1 已在 npm（[`docs/SPEC_V061.md`](docs/SPEC_V061.md)、[ADR 0016](docs/decisions/0016-config-sources-and-evidence-audit.md)）。v0.6.0 基线见 [`docs/SPEC_V06.md`](docs/SPEC_V06.md)，未单独打 tag。推已授权的 `v*` tag 时，`release.yml` 用 Trusted Publishing 发 npm 并建 GitHub Release（[ADR 0014](docs/decisions/0014-npm-trusted-publishing.md)）。人须在 npm 包设置里点一次 Trusted Publisher。不要添加 `NPM_TOKEN`。不要补打已发 npm 的 `v0.5.1` / `v0.5.2`，也不要补打 `v0.6.0`。

基线快照：`sommio/qwen-omni-mcp@8a07182554a985456153644e0006a22bd1c769f7`。

工作区 git 根：本目录（见 ADR 0006、ADR 0011）。

本地分支：以当前工作分支为准。

## 当前产品

v1 已本机收尾。V2 已实施。安装：钉版本 `npx` + 显式 MCP `env` 里的 Key + `QWEN_ALLOWED_ROOTS`；Agent 应转发或整理 `question`。

已在 Windows Node 24 + Cursor 上验证：中文文件名小视频、口播、496.8 MiB 漫剧。示例 Host 键是 `analyze_video_mcp`；已装的旧键（`analyze-video` / `mcp_analyze_video`）可继续用。

## 下一阶段

2026-09-24《山姆·奥特曼大战达里奥.mp4》实测后的修复与阶段验收见 [`tasks/fix-plan-20260924.md`](tasks/fix-plan-20260924.md)。2026-09-25 N1 已将证据纠错提示改为自然的用户可读限制，并保留有支持的背景音乐；N2 完成 11 次短合成/控制样本 live 对照，发现 qwen3.5 在静音 AAC 上仍会报告 `heard`，因此不宣称其整体更准，也不改公开默认；qwen3.8 对静音样本未直接确认，但对音乐性和弦也未确认。N3 本地 tarball 安装、stdio 单 Tool 握手与 14 个 `dist/*.js` 哈希核对已通过。为避免重复付费，本轮未在新桌面 Codex 会话里重跑私人原片；npm 公布版 `0.6.1` 未改动。现已另行接受 ADR 0022，仅为当前 Tool 添加默认关闭的可选数字静音核对；此决定不接受 ADR 0019 的其它 v0.7 方向。

P0（0.6.1）已发布。ADR 0019 的 v0.7 新 Tool 方向仍见 [`docs/SPEC_V07.md`](docs/SPEC_V07.md) 与 [`SPEC_V07_PROPOSAL.md`](docs/SPEC_V07_PROPOSAL.md)，尚未整体接受。现有 `analyze_video` 可选静音核对由独立 [ADR 0022](docs/decisions/0022-analyze-video-optional-silence-check.md) 授权，实现细节与安全边界见 [`tasks/analyze-video-optional-silence-measurement-proposal-20260925.md`](tasks/analyze-video-optional-silence-measurement-proposal-20260925.md)。授权输入实现使用继承已打开的只读 FileHandle fd + 固定 FFmpeg `fd:`；只在 Windows Node 24 + FFmpeg 8.1.1 的合成样本（含尾部 moov、双轨）验证。尚无 Node 22、Linux/macOS、其它 FFmpeg 版本、长媒体和并发原地写入验证。fstat 可发现常见变化，但不是不可变快照，也不能强制硬 byte-range。默认仍不依赖 FFmpeg；启用 on 时不兼容/解码失败 fail-soft，用户取消 fail-stop。五项质量门通过（`npm test`: 301 passed / 12 skipped），合成 FFmpeg 与 MCP 集成验证通过，独立 tarball install + stdio smoke 通过；本阶段没有额外付费 live 调用，没有发布。

2026-09-25 后续实测：重启后原片 MCP 回答报告背景音乐，本地核对为非零 PCM；20 秒静音对照的本地 `astats` 显示 960512 个样本全零，MCP coverage 报 `audio_track_present=true`、`audio_observed=false`，音频 observations 为空。模型散文却称音轨“似乎是空的或静音的”，并称因未检测到信号而无法确定音轨是否存在。该样本暴露的是 track fact 与散文/uncertainties 的矛盾；本轮已在完整数字静音且本地已确认音轨存在时，窄范围改写这两类确定措辞，并保留声音语义及视频原本是否应有可听声音的不确定性。该 live 样本没有触发 `heard` 冲突分支（`audio_observations=[]`）；该分支仍由 mock 与合成 FFmpeg 集成测试覆盖，不能把本轮 live 记录描述成已验证真实 `heard` 冲突。

2026-09-25 后续定向修正：另一个静音 MCP 返回在 `audio_observations` 中把“未检测到任何可辨识的声音内容（无对白、无音乐、无效应音）”标成 `heard`，正文也明确说未听到声音。只在本地音轨存在且完整测得数字静音时，明确否定项现规范为 `uncertain`，不创建 silence conflict；同一描述中若出现“没听到音乐，但听到枪声”，正向子句仍触发冲突，未命中词表的正向描述也按模型 `heard` 声明处理。静音已确认且轨道存在时，结构化推断中的“当前音轨缺失”现改写为已确认数字静音，并保留对叙事影响的推测。以上新分支由 mock 回归验证；五项门禁通过，`npm test` 304 passed / 12 skipped，独立 tarball 安装和 stdio smoke 通过。没有再次付费 live 调用，先前两次桌面实测均未观察到真实 `heard` 冲突路径。

2026-09-25 后续桌面复测的新增变体：20 秒 AAC 全零样本的结构化声音描述为“音轨全程未检测到任何声音（包括背景音乐、对白、音效或环境噪音），处于静音状态”；该否定句中的补充静音分句先前造成误报冲突。另一个推断写“实际音轨缺失”，与本地确认的 `audio_track_present=true` 矛盾。当前实现将所有分句都明确否定（包括“处于静音状态”补充）的 heard 项降为 uncertain；任何未明确否定的分句仍保留 heard，包括词表外“车辆轰鸣持续”。“当前/实际音轨缺失”推断改为本地轨道存在且完整 PCM 全零，不改变对声音语义或原作本应有声与否的未知。本修正由 mock 回归覆盖；未追加付费调用，真实桌面结果仅作为缺陷复现证据。

2026-09-25 后续独立 live 验证：从刚重新全局安装的 `dist/index.js` 启动独立 stdio MCP 进程，使用同一 20 秒全零 AAC 对照，由 `qwen3.5-omni-plus` 完成 1 次真实 provider 调用（约 27.3 秒）。结果 `audio_observed=false`、`audio_observations=[]`、`video_observed=true`、`isError=false`。本次验证新安装包的独立 stdio live 路径；模型没有给出先前两次的阴性 `heard` 措辞，因此没有 live 触发或验证阴性 `heard` 规范化、正向 heard 冲突与两种音轨缺失推断改写，这些仍由 mock 回归覆盖。上一段“未追加付费调用”指该修复阶段；本段记录其后的 1 次 live 调用。

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
不要实现 `analyze_audio`、`audit_media`，也不要把可选静音核对默认打开。
```
