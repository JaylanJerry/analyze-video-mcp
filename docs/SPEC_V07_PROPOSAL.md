# v0.7 规格提案：音频分析、确定性测量与媒体审核

状态：**待审阅，未批准或实施**。本文件细化 [`SPEC_V07.md`](SPEC_V07.md) 的方向；v0.6.1 契约仍有效。接口和运行时决策分别见 Proposed [ADR 0018](decisions/0018-v07-tool-surface.md) 与 [ADR 0019](decisions/0019-v07-local-measurement.md)。跨目录手动附件输入见 Proposed [ADR 0020](decisions/0020-user-granted-local-media.md)。

## 目标与假设

让 Agent 分别回答：视频画面与内嵌声音发生了什么；独立音频或视频音轨的内容与质量如何；媒体有哪些有证据支持的发布风险。技术数字只来自确定性工具，模型负责语义判断。审核结论说明覆盖范围和未验证项，不代替权利授权。

本提案假设：保留 `analyze_video(video, question?)` 全部现有公开字段和默认行为；新能力用独立 Tool；不修改源媒体。用户 2026-09-22 新增目标：亲自把视频拖进 Agent 窗口时，不因所在文件夹未列入 `QWEN_ALLOWED_ROOTS` 而失败。A1 探针已证明当前 Codex 不向 MCP 提供任何可验证的单文件授权（只给模型一段路径文本），用户随后否决了确认弹窗方案，改为安装级开关 `QWEN_ALLOW_ANY_LOCAL_VIDEO`：默认仍要求允许根，开启后接受任意本地 MP4 路径且不做确认，代价与边界见 [ADR 0021](decisions/0021-allow-any-local-video-opt-in.md)。完整字段细节还需与用户 2026-08-22 综合需求原文复核。若原文与本提案冲突，先修订规格和 ADR。

## 公开接口草案

| Tool            | 输入草案                                                   | 职责                                           |
| --------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| `analyze_video` | 原有 `video`, `question?`                                  | 视频画面和内嵌音频的抽样语义理解；不改 schema  |
| `analyze_audio` | `audio: string`, `question?: string`                       | 独立音频或 MP4 音轨的声音理解与质量检查        |
| `audit_media`   | `video: string`, `subtitles?: string`, `question?: string` | 汇合视觉、音频、技术和字幕证据，给分项审核结论 |

`audio` 拟支持本地 WAV、MP3、M4A、AAC、FLAC、OGG、MP4 及公开 HTTPS URL。`subtitles` 拟支持允许根内的 SRT、ASS、VTT 或公开 HTTPS URL。具体格式、上限和 URL 行为要以 provider 协议试验与安全设计冻结。新 Tool schema 不放 Key、模型、FFmpeg 路径、任意命令或媒体内容。`analyze_video` 的现有错误码和输出语义不变。

## 结果结构草案

三个 Tool 保持单个中文 `content[0].text`，可附带已脱敏 `structuredContent`。新 Tool 使用统一发现结构；旧 `analyze_video` 不必立即增加字段。

```json
{
  "ok": true,
  "coverage": {
    "media_duration_seconds": 120,
    "video_strategy": "sampled_multimodal",
    "audio_strategy": "full_decode_measurement_and_sampled_semantics",
    "ocr_performed": false,
    "subtitle_events_detected": 24,
    "subtitle_events_verified": 8,
    "complete_verification": false,
    "limitations": ["字幕仅抽样核对"]
  },
  "findings": [
    {
      "domain": "audio",
      "severity": "warning",
      "start_seconds": 12.4,
      "end_seconds": 15.2,
      "claim": "对白被环境声遮盖，需要人工复听",
      "evidence": ["heard"],
      "confidence": 0.7
    }
  ],
  "release_verdict": {
    "creative": "needs_review",
    "picture": "incomplete",
    "audio": "needs_review",
    "subtitles": "incomplete",
    "technical": "incomplete",
    "rights": "unverified",
    "overall": "needs_review"
  }
}
```

枚举草案：`severity = info | warning | blocker`；各质量分项 `verdict = pass | needs_review | fail | incomplete`；`rights = verified | unverified | blocked`。任一 blocker 可使 overall 为 `fail`；关键覆盖缺失时 overall 不得为 `pass`。即使质量分项通过，权利 `unverified` 也不能自动变成 `verified`。聚合规则须经固定夹具和用户案例审阅后冻结。

证据标签沿用 `seen`、`heard`、`measured`、`inferred`、`cross_validated`、`uncertain`。`measured` 必须标注工具、版本、算法/滤镜、单位、范围和时间段；模型给的数字不能升级为测量。`cross_validated` 需要两个独立来源并对齐时间；同一模型重复表述不算。身份、声音来源、字幕全文或权利来源无法核实时用 `uncertain` / `unverified`。

## 音频与技术测量

- 本地媒体沿用只读授权原则；探测、解码和测量走受控外部进程，见 ADR 0019。原文件不得覆盖，临时产物只在受控目录创建并于正常、错误、取消路径清理。Agent 结果不得含本地路径。
- 最低测量集：媒体/音轨时长、采样率、声道布局、整段 integrated LUFS、true peak dBTP、静音区间、样本峰值和疑似削波区间。LRA、相位/声道平衡及解码完整性可在算法和夹具确定后增加。
- 静音阈值、最短时长、测量版本与覆盖范围须在结果中披露。只测到部分媒体、滤镜失败或无音轨时返回 `incomplete`，不得填推测值。无目标平台或用户标准时只报告数值和风险，不自动判技术 `pass`。
- 对白、配音、环境声、音乐、音效、过渡、遮盖和可疑不同步属于听觉/推断证据，不冒充连续精密测量。模型抽样不能证明整段逐秒检查。

## 字幕与审核

证据优先级：可解码独立字幕轨 > 用户提供的 SRT/ASS/VTT > 独立 OCR 得到的屏幕文字 > 多模态抽样描述。每种来源记录时间范围、事件数与失败原因。先核对事件分割、时间合法性、重叠和相邻事件；连续相邻字幕不得被误合并为“漏字”。字幕轨本身不能证明对白文字正确，还需独立转写或人工对照。

OCR 若需要新引擎或依赖，须另行批准；缺席时明确 `ocr_performed: false`、`complete_verification: false`。没有字幕轨、sidecar、OCR 或覆盖率时，不得宣称“所有字幕正确”“逐帧核对”。`audit_media` 对创意、画面、声音、字幕、技术、权利分别给结论；版权和商业发布始终是独立门槛。

## 安全与资源边界

- 当前实现：默认要求本地媒体位于 `QWEN_ALLOWED_ROOTS`，未设置则拒绝；安装者可用 `QWEN_ALLOW_ANY_LOCAL_VIDEO=on` 接受任意本地 MP4 路径（无确认弹窗），见 [ADR 0021](decisions/0021-allow-any-local-video-opt-in.md)。早期“经宿主验证的单文件授权”方案（ADR 0020）因宿主能力不足且用户否决额外确认步骤而未实施。`realpath`、普通文件、打开后身份复核、`ftyp`、大小与时长限制在两种模式下都执行；允许根模式额外检查根包含。外部进程用固定可执行文件和参数数组，禁止 shell 拼接；受超时、取消、输出大小限制控制。
- 不将整个媒体 Base64 到内存，也不自动上传私有文件给尚未验证的服务。HTTPS 输入若要本机测量，必须先设计下载大小、SSRF、超时和清理策略；此前只报告“本机测量不可用”，不给测量数字。
- Key、路径、上传凭证、OSS URL、provider 原始响应不得进入 Agent 文本或结构化结果。无 FFmpeg、无音轨、无法解码、字幕解析失败、供应商协议不支持与中断均须有稳定错误或局限标记。配置错误仍应允许 MCP 握手和 Tool 列表出现。
- 新 Tool 与当前视频分析共享一个进程级活动任务上限；取消后释放子进程、句柄、临时文件和锁。默认测试不发真实 API 请求。

## 实施前验证

1. **Provider 协议**：用无私密内容的小音频验证目标模型的输入字段、URL/临时上传、时长与大小、文本输出和失败码。官方文档提及 `input_audio`，但本仓库尚未 live 验证。付费试验另需明确授权。
2. **本机运行时**：验证 FFmpeg/ffprobe 版本与安装策略、Windows 和 Node 22/24、无运行时时的降级、长媒体内存、超时与取消清理。ADR 0019 接受前不加入生产依赖或二进制。
3. **契约与安全**：新 Tool schema、原 `analyze_video` 不变、允许根、用户授权附件的宿主能力与来源证明、junction/symlink、坏媒体、HTTPS 降级、并发、进度通知、脱敏和进程退出。
4. **审核夹具**：连续字幕、错字、无字幕、无音轨、削波、长静音、对白被环境声遮盖、模型误判身份、权利未知。逐项断言 coverage 与 verdict 不夸大。
5. **质量门**：`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm test`、`npm run coverage`、`npm run build`。付费 live 独立于默认测试。

代码在 `src/`，单测与 mocked E2E 在 `test/`，协议和决策在 `docs/`；维持 TypeScript strict、现有格式和无真实请求的默认测试。规格通过审阅后再写依赖顺序的实施计划和任务清单。

实现代码沿用现有显式类型与判别联合风格，例如测量失败不能用缺失的数字冒充成功：

```ts
type Measurement =
  | { status: "complete"; value: number; unit: "LUFS" | "dBTP" }
  | { status: "incomplete"; reason: string };
```

必须做：保持输入授权、证据来源、脱敏和模拟测试。实施前先确认：公开 schema、外部运行时、任何新生产依赖、付费 live 测试。禁止：硬编码密钥、整文件 Base64、把模型推断写成测量、绕过 Git hooks 或改写原媒体。

## 完成标准

1. `analyze_video` 的契约回归测试全部通过；新 Tool 的字段、错误、取消和输出有独立契约测试。
2. 音频语义与确定性测量分别给出来源；无音轨、无运行时、部分解码等案例不能得到虚假的 `measured` 或 `pass`。
3. 字幕相邻事件、错字和缺少独立证据的夹具不能得到 `complete_verification: true`；权利未知不能得到商业发布通过。
4. 本地路径/HTTPS、安全脱敏、内存、子进程清理和默认无真实请求测试均通过；手动附件跨目录成功且同一路径在无授权时仍被拒绝；质量门达到项目现有覆盖率阈值。
5. 仅在另获授权的 live 验证中确认 provider 音频协议与真实宿主行为，记录脱敏证据后才可考虑发布。

## 待确认决定

1. 建议分两批：先交付 `analyze_audio` 与确定性测量，再由真实证据能力支撑 `audit_media`。
2. 建议用户自行安装 FFmpeg/ffprobe，程序仅检测和调用；若要求零安装，须先评估二进制体积、许可、平台与维护成本。
3. 建议首批支持字幕轨和 sidecar，OCR 另做验证过的后续里程碑。
4. 音频、字幕及平台发布阈值由用户或目标平台标准提供；未提供时只提示风险，不自动判通过。
5. 先选一个 Agent 宿主做拖入附件的端到端能力验证；若宿主不提供可验证的附件引用或字节流，不能声称“拖进聊天框即自动分析”，需要向用户提供明确的单文件选择/授权回退路径。

## 技术资料

- [阿里云 Qwen-Omni 文档](https://help.aliyun.com/zh/model-studio/qwen-omni)：音频输入 API 形态的参考；不等同本项目 live 证据。
- [FFmpeg 官方滤镜文档](https://ffmpeg.org/ffmpeg-filters.html)：`loudnorm`、`silencedetect`、`astats` 等测量能力的参考。
