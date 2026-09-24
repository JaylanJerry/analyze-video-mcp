# 下一阶段任务清单（待审阅）

按 [`plan-v07-proposal.md`](plan-v07-proposal.md) 的依赖顺序执行。A 批已完成一次 Codex 桌面短片流程验证；B 批仍在收口。完成一项时补充实测结果，不以文档勾选代替真实用户流程。

## A. Codex 任意目录视频输入（P0）

状态分三层，不要混：**代码已实现**、**Codex CLI 已验证**、**桌面 GUI 已用一个公开短片验证**。证据、命令与残留项见 [`deepseek-v07-handoff.md`](deepseek-v07-handoff.md) 的“A 批状态”。

- [x] A1 无私密 MP4 宿主探针：Codex 桌面版接受拖入 MP4，但只写成用户消息里的绝对路径文本，MCP 边界拿不到附件或授权对象。未调用百炼。
- [x] A2 授权契约与回退体验：用户否决确认步骤与宿主选择器，选定安装级开关 `QWEN_ALLOW_ANY_LOCAL_VIDEO`（默认 `off`，`on` 时路径即授权）。见 [ADR 0021](../docs/decisions/0021-allow-any-local-video-opt-in.md)；ADR 0020 被取代。
- [x] A3 实现（代码）：开关接入 `config` / `media` / `doctor` / Server 与错误文案，根外放行、开关关闭仍拒绝、坏 MP4、超大小、超时长、junction 改指均有测试；取凭证失败拆成六个 `parse_reason`，数字字符串形态亦兼容。
- [x] A4 桌面 GUI 实测：2026-09-23 用户在新 Codex 任务拖入公开 `test/fixtures/live-av.mp4` 并明确要求 MCP 分析；任务记录显示路径进入用户消息，`analyze_video` 工具调用完成（约 52.7 秒），回答正确区分画面 `24` 与语音 `3.1415926`，报告 `model=qwen3.8-omni-flash`、`audio_track_present=true`、`audio_observed=true`。用户报告本次没有批准或风险审查提示。只验了这个短 MP4 与本次会话；大文件、其它目录、MOV/HEVC 的 GUI 情形不由此推定。

## B. 现有视频链路可靠性（P1）

- [ ] B1 在当前版复现具体的中断、超时或缓存问题。验收：有可重复步骤和脱敏阶段结果；无复现则不改该路径。已有两条待定位线索（2026-09-20 的 38 秒 + 1 毫秒失败、2026-09-22 的取凭证失败），见交接文档 B 段。
- [ ] B2 修复已复现问题并补回归。**2026-09-23 状态**：JSON 兜底已有 mocked 回归（同文件真实调用返回可读文本，但**未真实触发**坏 JSON 分支，不能算真实验证）；模型 id 与本地轨道事实在真实结果中可见。`uncertain` 音频条目对应 `audio_observed=false` 现已在《AE海-通义.mp4》的真实响应中确认；原片与提高 12 dB 的版本均未让模型确认声音，换入受控语音的同画面版本则正确给出 `heard`（证据见协议文档 1e 节）。**cross_validated 配对已收紧**（无付费反例驱动）：`cross_validated` 条目现要求对面存在直接确认条目（画面 `seen` / 声音 `heard`），否则就地降级为 `inferred`；两侧互证而无确认条目按循环处理；`audio_observed` / `video_observed` 只认 `heard` / `seen`，不再计 `cross_validated`；限制文案改为列出实际条目类型。回归：4 个配对用例 + uncertain/inferred-only 用例。**证据冲突信号已加**（`coverage.evidence_conflicts`；无音轨却声称听到不计入 `observed`）。**清理顺序漏检已修**（配对只认清理后仍有效的 `seen`/`heard`，清理输出为不动点，见交接第三段修正）。**仍未勾完成**：上述修复只有 mock 覆盖，未在真实响应上确认；原音轨内容与模型未确认的原因仍未定位。
- [ ] B1 剩余待定位：上传凭证 `request_failed` 在 MOV 和公开 3 秒夹具上均曾出现、重试成功，根因未明；`AE海-通义.mp4` 同文件付费重跑后模型仍无法判断声音，原因未明（公开夹具的画面与语音 live 测试均命中，证明不是全局无音频能力）；`usage` 数值、HEVC、Codex 桌面 GUI 的大文件与其它目录情形未验证。

## C. 独立音频与测量（P2）

- [ ] C1 审定 `analyze_audio` schema、输入格式、模型音频协议和限制。验收：模拟协议测试完成；付费 live 验证单独授权。
- [ ] C2 审定 FFmpeg/ffprobe 策略并实现最小确定性测量。验收：时长、音轨、LUFS、true peak、静音等值带来源和范围；运行时缺失不伪造数值。
- [ ] C3 接通独立音频和 MP4 音轨语义分析。验收：`heard`、`measured`、`inferred` 清楚分开，失败和部分覆盖返回 `incomplete`。

## D. 综合审核（P3）

- [ ] D1 支持字幕轨与 sidecar 的解析和时间校验。验收：连续相邻字幕、错字、无字幕和重叠夹具不会误判为完整核验。
- [ ] D2 实现 `audit_media` 分项发现、证据来源、覆盖范围和结论聚合。验收：无证据不能 `pass`；权利未知保持 `unverified`。
- [ ] D3 决定 OCR 是否进入后续版本。验收：若未加入，输出明确 `ocr_performed: false`，不宣称屏幕字幕全量准确。

## E. 发布候选（P4）

- [ ] E1 同步 `docs/API_CONTRACT.md`、安全文档、安装与宿主示例、Server instructions、doctor 指引。
- [ ] E2 通过 typecheck、lint、format、单测、coverage、build 和 Codex 真实流程回归；记录未验证能力。
- [ ] E3 审阅发布候选；推送、tag、npm 发布和付费 live 均依照仓库授权要求另行执行。
