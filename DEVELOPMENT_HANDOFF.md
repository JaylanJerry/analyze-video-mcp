# Video MCP 开发交接

> **2026-09-25 下一大版本接手入口：** 用户已确认“一个媒体分析 Tool、Agent 决定问题、本地 MP4/MOV/MP3、首发百炼”的大版本重构方向。DeepSeek 开发请先读 [`docs/SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md`](docs/SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md)、[ADR 0024](docs/decisions/0024-agent-directed-media-gateway.md)、[`tasks/plan-next-major-media-gateway.md`](tasks/plan-next-major-media-gateway.md)、[`tasks/todo-next-major-media-gateway.md`](tasks/todo-next-major-media-gateway.md) 和 [`tasks/deepseek-next-major-handoff.md`](tasks/deepseek-next-major-handoff.md)。以下 v0.7 三 Tool/综合审核计划是历史基线，**不再作为下一大版本实施指令**。当前工作区分支已实现 `analyze_media` 并**本地提交 `381da84`**（未推送、未发布）；npm 上的 `0.6.1` 仍使用 `analyze_video`。

状态：v0.6.1 已在 npm（[`docs/SPEC_V061.md`](docs/SPEC_V061.md)、[ADR 0016](docs/decisions/0016-config-sources-and-evidence-audit.md)）。v0.6.0 基线见 [`docs/SPEC_V06.md`](docs/SPEC_V06.md)，未单独打 tag。推已授权的 `v*` tag 时，`release.yml` 用 Trusted Publishing 发 npm 并建 GitHub Release（[ADR 0014](docs/decisions/0014-npm-trusted-publishing.md)）。人须在 npm 包设置里点一次 Trusted Publisher。不要添加 `NPM_TOKEN`。不要补打已发 npm 的 `v0.5.1` / `v0.5.2`，也不要补打 `v0.6.0`。

基线快照：`sommio/qwen-omni-mcp@8a07182554a985456153644e0006a22bd1c769f7`。

工作区 git 根：本目录（见 ADR 0006、ADR 0011）。

本地分支：以当前工作分支为准。

## 当前产品

v1 已本机收尾。V2 已实施。安装：钉版本 `npx` + 显式 MCP `env` 里的 Key + `QWEN_ALLOWED_ROOTS`；Agent 应转发或整理 `question`。

已在 Windows Node 24 + Cursor 上验证：中文文件名小视频、口播、496.8 MiB 漫剧。示例 Host 键是 `analyze_video_mcp`；已装的旧键（`analyze-video` / `mcp_analyze_video`）可继续用。

## 下一阶段

**2026-09-25 Codex 宿主补验：** 当前 Codex 任务已挂载 `mcp__analyze_video_mcp__analyze_media`，并用仓库公开 3 秒 MP4 夹具完成一次真实调用；`qwen3.5-omni-plus` 报告看到 `24`、听到 `3.1415926`，与夹具说明一致，`isError=false`、`usage=770/26/796`。文件前后 SHA-256 相同。此项验证当前任务的 Tool 调用链；新会话手动拖入、Codex 宿主 MOV/MP3 与 ZCode 宿主仍未验证。该次服务商费用金额未知。详情见 [`tasks/todo-next-major-media-gateway.md`](tasks/todo-next-major-media-gateway.md) D4。

**2026-09-25 下一大版本已在本工作区分支实现（已本地提交 `381da84`，未推送、未发布）：** 按 [`docs/SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md`](docs/SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md) 与 [ADR 0024](docs/decisions/0024-agent-directed-media-gateway.md) 完成单入口 `analyze_media(media, prompt)`：本地 MP4/MOV **与 MP3**、公开 HTTPS 视频直连；服务端不再补写九段提纲、不再强制证据 JSON、不再有纠错二次请求；本地授权改为 `MEDIA_ALLOWED_ROOTS` / `MEDIA_ALLOW_ANY_LOCAL_FILE`（旧 `QWEN_ALLOWED_ROOTS` / `QWEN_ALLOW_ANY_LOCAL_VIDEO` / `QWEN_MAX_LOCAL_VIDEO_MB` / `QWEN_AUDIO_SILENCE_CHECK` 只被 doctor 报告为失效，不授予任何访问）；旧报告层 `src/evidence.ts`、可选 FFmpeg 静音核对 `src/audio-silence.ts`、`analyze_video` 注册与旧报告专用测试已删除（内容仍在 git 历史）。新增 `src/mpeg-audio.ts`（有界 MPEG Layer III 解析）、`src/bytes.ts`（共享探测预算）、`src/sanitize.ts`（保留的脱敏出口）；上传缓存键加入 API Key 单向指纹，换账号不再复用旧 `oss://`。本地门禁全通过：typecheck / lint / format:check / `npm test` 258 passed+1 skipped / coverage 88.18% stmts、81.84% branch / build；`dist/index.js --doctor` 只注册 `analyze_media`。**2026-09-25 真实百炼验收（用户授权，共 7 次调用）：** ① 非私密合成 MP3（9.04 秒、三段递增音调）两次调用都成功，模型准确说出三段与“依次升高”，第二次 `upload_reused:true`；② 890 秒真实 MP3 成功概括内容；③ 公开夹具 MP4 与 `-c copy` 转封装的 MOV 都读出画面 `24` 与语音 `3.1415926`。**负例：** 只有音频轨、没有视频轨的 MP4 经视频路径被服务商 **HTTP 400** 拒绝（复现 2 次，原因未定位）。全部运行的 stderr 与正文均无 `oss://`、密钥或本地路径。**仍属未验证：** `MEDIA_MODEL_UNSUPPORTED` 的服务商真实措辞、宿主 GUI（Codex/ZCode）、费用金额、内容检查拒绝的真实触发；Node 22 与 CI 未跑（本机只有 Node 24，且没有推送）。详见 [`tasks/todo-next-major-media-gateway.md`](tasks/todo-next-major-media-gateway.md)。npm 上的 `0.6.1` 未改动，仍是 `analyze_video`；本轮已**本地提交 `381da84`**（66 文件），但没有 push、tag 或 publish。

2026-09-25 内容检查错误修复：真实 `1_merged.mp4` 调用两次在首个 SSE 事件返回 `data_inspection_failed`，本地全量解码通过，但无法确定输入/输出触发点。现按 [ADR 0023](docs/decisions/0023-provider-inspection-errors.md) 将 SSE 与 HTTP 正文中的已知内容检查错误明确报告为不可直接重试的 `PROVIDER_CONTENT_REJECTED`；仅归纳固定措辞的侧别并保留安全 Request ID，不透传服务商原文。五项质量门通过（`npm test`: 318 passed / 12 skipped），打包后独立安装与 stdio 握手通过。本机构建已覆盖全局安装，四个关键 `dist` 文件哈希一致；已运行中的 Codex MCP 进程仍需重启才会加载新代码。没有为此重新上传原视频，已发布 npm 包未更新。

2026-09-25 重启后真实复测：同一 `1_merged.mp4` 的 SHA256 前后均为 `73F3003D3E853B8340BC6B90A5527AA0EB44F4DCCE98A82C8FE1D64DDF992BA7`；MCP 已返回 `PROVIDER_CONTENT_REJECTED`、`retryable:false`、`data_inspection_failed`、首个 SSE 事件、`inspection_side:unknown`，确认分类修复生效，但服务商仍未给出内容。结果中的 `chatcmpl-…` 被误标为 Request ID；官方文档将补全 `id` 与 Request ID 区分，后续代码只保留显式 `request_id` 或响应 Header，缺失时省略。后续修正五项质量门通过（`npm test`: 319 passed / 12 skipped），打包后独立安装与全局入口握手通过。全局包是指向本仓库的 junction，重新构建后的文件已可供新进程加载；一次重复 `npm install -g .` 因现有 shim 报 `EEXIST`，无需强制覆盖。当前 Codex 进程仍需重启；本轮不再重复付费调用。

2026-09-24《山姆·奥特曼大战达里奥.mp4》实测后的修复与阶段验收见 [`tasks/fix-plan-20260924.md`](tasks/fix-plan-20260924.md)。2026-09-25 N1 已将证据纠错提示改为自然的用户可读限制，并保留有支持的背景音乐；N2 完成 11 次短合成/控制样本 live 对照，发现 qwen3.5 在静音 AAC 上仍会报告 `heard`，因此不宣称其整体更准，也不改公开默认；qwen3.8 对静音样本未直接确认，但对音乐性和弦也未确认。N3 本地 tarball 安装、stdio 单 Tool 握手与 14 个 `dist/*.js` 哈希核对已通过。为避免重复付费，本轮未在新桌面 Codex 会话里重跑私人原片；npm 公布版 `0.6.1` 未改动。现已另行接受 ADR 0022，仅为当前 Tool 添加默认关闭的可选数字静音核对；此决定不接受 ADR 0019 的其它 v0.7 方向。

P0（0.6.1）已发布。ADR 0019 的 v0.7 新 Tool 方向仍见 [`docs/SPEC_V07.md`](docs/SPEC_V07.md) 与 [`SPEC_V07_PROPOSAL.md`](docs/SPEC_V07_PROPOSAL.md)，尚未整体接受。现有 `analyze_video` 可选静音核对由独立 [ADR 0022](docs/decisions/0022-analyze-video-optional-silence-check.md) 授权，实现细节与安全边界见 [`tasks/analyze-video-optional-silence-measurement-proposal-20260925.md`](tasks/analyze-video-optional-silence-measurement-proposal-20260925.md)。授权输入实现使用继承已打开的只读 FileHandle fd + 固定 FFmpeg `fd:`；只在 Windows Node 24 + FFmpeg 8.1.1 的合成样本（含尾部 moov、双轨）验证。尚无 Node 22、Linux/macOS、其它 FFmpeg 版本、长媒体和并发原地写入验证。fstat 可发现常见变化，但不是不可变快照，也不能强制硬 byte-range。默认仍不依赖 FFmpeg；启用 on 时不兼容/解码失败 fail-soft，用户取消 fail-stop。五项质量门通过（`npm test`: 301 passed / 12 skipped），合成 FFmpeg 与 MCP 集成验证通过，独立 tarball install + stdio smoke 通过；本阶段没有额外付费 live 调用，没有发布。

2026-09-25 后续实测：重启后原片 MCP 回答报告背景音乐，本地核对为非零 PCM；20 秒静音对照的本地 `astats` 显示 960512 个样本全零，MCP coverage 报 `audio_track_present=true`、`audio_observed=false`，音频 observations 为空。模型散文却称音轨“似乎是空的或静音的”，并称因未检测到信号而无法确定音轨是否存在。该样本暴露的是 track fact 与散文/uncertainties 的矛盾；本轮已在完整数字静音且本地已确认音轨存在时，窄范围改写这两类确定措辞，并保留声音语义及视频原本是否应有可听声音的不确定性。该 live 样本没有触发 `heard` 冲突分支（`audio_observations=[]`）；该分支仍由 mock 与合成 FFmpeg 集成测试覆盖，不能把本轮 live 记录描述成已验证真实 `heard` 冲突。

2026-09-25 后续定向修正：另一个静音 MCP 返回在 `audio_observations` 中把“未检测到任何可辨识的声音内容（无对白、无音乐、无效应音）”标成 `heard`，正文也明确说未听到声音。只在本地音轨存在且完整测得数字静音时，明确否定项现规范为 `uncertain`，不创建 silence conflict；同一描述中若出现“没听到音乐，但听到枪声”，正向子句仍触发冲突，未命中词表的正向描述也按模型 `heard` 声明处理。静音已确认且轨道存在时，结构化推断中的“当前音轨缺失”现改写为已确认数字静音，并保留对叙事影响的推测。以上新分支由 mock 回归验证；五项门禁通过，`npm test` 304 passed / 12 skipped，独立 tarball 安装和 stdio smoke 通过。没有再次付费 live 调用，先前两次桌面实测均未观察到真实 `heard` 冲突路径。

2026-09-25 后续桌面复测的新增变体：20 秒 AAC 全零样本的结构化声音描述为“音轨全程未检测到任何声音（包括背景音乐、对白、音效或环境噪音），处于静音状态”；该否定句中的补充静音分句先前造成误报冲突。另一个推断写“实际音轨缺失”，与本地确认的 `audio_track_present=true` 矛盾。当前实现将所有分句都明确否定（包括“处于静音状态”补充）的 heard 项降为 uncertain；任何未明确否定的分句仍保留 heard，包括词表外“车辆轰鸣持续”。“当前/实际音轨缺失”推断改为本地轨道存在且完整 PCM 全零，不改变对声音语义或原作本应有声与否的未知。本修正由 mock 回归覆盖；未追加付费调用，真实桌面结果仅作为缺陷复现证据。

2026-09-25 后续独立 live 验证：从刚重新全局安装的 `dist/index.js` 启动独立 stdio MCP 进程，使用同一 20 秒全零 AAC 对照，由 `qwen3.5-omni-plus` 完成 1 次真实 provider 调用（约 27.3 秒）。结果 `audio_observed=false`、`audio_observations=[]`、`video_observed=true`、`isError=false`。本次验证新安装包的独立 stdio live 路径；模型没有给出先前两次的阴性 `heard` 措辞，因此没有 live 触发或验证阴性 `heard` 规范化、正向 heard 冲突与两种音轨缺失推断改写，这些仍由 mock 回归覆盖。上一段“未追加付费调用”指该修复阶段；本段记录其后的 1 次 live 调用。

2026-09-25 桌面内 MCP 后续验证：重启后对 SHA256 前后不变的同一 20 秒已验证全零 AAC 对照发起 1 次真实 `qwen3.5-omni-plus` 调用。结果 `isError=false`，coverage 为 `audio_track_present=true`、`audio_observed=false`、`video_observed=true`，`audio_observations=[]`、无 `evidence_conflicts`，并明确报告 PCM 全零；正文和结构化推断未再声称当前/实际音轨缺失。模型没有返回 `heard` 否定项，因此这次仍未 live 验证该规范化分支。待评估的文案问题：正文仍称“无法排除存在极低音量或压缩丢失的音频成分”，其中“极低音量”可能与已测全零 PCM 的事实混淆；另有“无效时间码：整个视频片段中未检测到任何可辨识的声音……”这一冗余不确定项。本轮未把这两项记录为已修复。

2026-09-25 本地文案修复：只在本地已确认音轨且完整解码 PCM 全零时，把“无法排除存在极低音量或压缩丢失的音频成分”改为当前解码 PCM 无低幅非零样本、但有损压缩前音频内容、具体声音语义和静音是否为创作意图仍未知；只移除与整段无声说明完全匹配的误标 `无效时间码` 项，真实时间码格式错误/越界项仍保留。默认 off、non_silent、测量不完整、HTTPS 和无音轨分支维持原文。该行为由 MCP mock 回归覆盖；五项质量门通过（`npm test`: 309 passed / 12 skipped），pack-install smoke 通过。已本地提交 `bee12d1`，重新打包并覆盖全局安装；安装的 `dist/evidence.js` 与本地构建 SHA256 一致，安装版 `--doctor --json` 正常，独立 stdio 握手仅注册 `analyze_video`。未做额外 live，也未推送或发布。

2026-09-25 桌面后续真实调用再次暴露阴性 heard 误报：同一 20 秒全零 AAC（SHA256 `8DA8D6D432C246686324977C96D70FE591C60E598554C7D88BBA65E3796E768E`）以 `qwen3.5-omni-plus` 完成 1 次调用，模型将“音轨全程为静音状态，未检测到任何背景音乐、对白或音效。”标为 `heard`，当时造成 1 项 `evidence_conflicts`，而本地事实仍为音轨存在、PCM 全零、`audio_observed=false`。本轮仅在已确认数字静音分支，把精确的“音轨全程为静音状态”分句识别为明确否定；若同句另有任何未明确否定分句（包括词表外声音或“但仍听到枪声”），仍按正向 `heard` 冲突处理。相关测试覆盖真实原句、混合正向与“音轨不为静音状态”反例，以及先前默认关闭/非静音/未测/HTTPS 不变边界。五项质量门通过（`npm test`: 309 passed / 12 skipped），pack-install smoke 通过；本地提交 `62bab3c` 后重新打包覆盖全局安装，安装的 `dist/evidence.js` 与构建 SHA256 一致，安装版 `--doctor --json` 正常，独立 stdio 握手只注册 `analyze_video`。未再次付费 live；该修正仍待桌面新会话复核，不把 mock 结果描述成已验证 live 修复。

2026-09-25 后续桌面复测：对同一 20 秒全零 AAC 先后发起 2 次真实 `qwen3.5-omni-plus` 调用；首次返回可重试的 `data_inspection_failed`，第二次成功，coverage 为 `audio_track_present=true`、`audio_observed=false`、`audio_observations=[]`、无冲突，并报告 PCM 全零。两次调用可能产生费用，具体计费未知。成功输出没有再现 `heard` 阴性句，因此不能作为上一条阴性规范化已 live 验证的证据。新发现两项模型文字问题：把全片“音轨为完全静音”作为 observation 后误标 `无效时间码`，以及从全零 PCM 推断声音元素“实际并未录制或混入音频”。本地修正仅匹配这条全片静音 uncertainty，并改写这条具体来源推断为当前文件 PCM 全零、原始录音/混音原因未知；局部音频和真实视觉时间码错误保留，合理视觉推断不变。完整原话及这些反例由 mock 回归覆盖；五项门禁通过（`npm test`: 309 passed / 12 skipped），pack-install smoke 通过；没有额外 live 验证本轮修复。

同次结构化结果还把“无法判断该视频是否原本设计为有声版本，或因技术原因导致音轨丢失”列为不确定项。确认已有 AAC 音轨仅能排除“当前文件没有音轨”，不能证明历史录制/混音/转码原因；因此仅在已确认数字静音分支把该精确句子改为“无法判断该视频是否原本设计为有声版本，或现有音轨为何全零”，不把历史丢轨原因当成已排除事实。真实无音轨、HTTPS、未测及非静音分支不触发该措辞改写。

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

## 硬规则与版本边界

- **已发布 `0.6.1`** 不改变 `analyze_video` 的名称与字段；**当前工作区的下一大版本**已按 ADR 0024 改为唯一的 `analyze_media(media, prompt)`，不得把两者长期并列或把分支实现写成已发布。
- 不增加生产依赖。不要从本机主动推送或 `npm publish`，除非用户明确要求。已授权的 `v*` tag 由 `release.yml` 发 npm。
- 不读取、复制、打印或提交密钥或 `text/*.key`。
- 私人 live fixture 留在 `text/`。CI 用 `test/fixtures/live-av.mp4`。
- 付费 live 必须用户明确授权。

## 接手者先读

下一大版本先按本文开头的五份目标文档读，再核对 `AGENTS.md`、`docs/API_CONTRACT.md`、架构 / 协议 / 安全 / 测试及现行代码。`docs/SPEC.md` 与 `tasks/todo.md` 只用于追溯 v1 背景。

实现方向若超出 ADR 0024 与新规格，先记录证据并提出规格/决策调整；不得用旧 v0.7 提案覆盖已接受的新方向。

## 给下一模型的启动提示词（下一大版本）

```text
你在 analyze-video-mcp 仓库根工作。先读 AGENTS.md、DEVELOPMENT_HANDOFF.md、docs/SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md、ADR 0024、tasks/plan-next-major-media-gateway.md 和 tasks/todo-next-major-media-gateway.md。工作区分支已实现唯一的 analyze_media(media, prompt)，支持本地 MP4/MOV/MP3 与公开 HTTPS 视频，已本地提交 381da84（未推送、未发布）；npm 0.6.1 仍是 analyze_video。MP3 协议和 MP4/MOV/MP3 服务商调用已有真实证据，当前 Codex 任务的公开 MP4 Tool 调用也已通过。先核对任务清单的证据与剩余项，再验收新会话手动拖入、Codex 宿主 MOV/MP3、ZCode 宿主和 Node 22 CI；不要重复已完成的付费调用，也不要外推单个宿主结果。保留授权、脱敏、取消、缓存和内容检查拒绝防护；缓存不能跨账号或凭证身份复用。不要读密钥或 text/；新依赖、新的付费 live、推送和发布按仓库规则另行审阅。逐项记录已实现、已验证、未验证和下一步，并维护现有工作区改动。
```
