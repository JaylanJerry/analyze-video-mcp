# v0.7.0：纯音频、确定性测量与交叉审核（尚未实施）

状态：已记录，**尚未实施**。用户 2026-08-22 综合优化需求的第二批；2026-09-22 补充“手动拖入视频不受文件夹限制”的目标。详细的待审阅方案见 [`SPEC_V07_PROPOSAL.md`](SPEC_V07_PROPOSAL.md)；实施前须批准 [ADR 0018](decisions/0018-v07-tool-surface.md)、[ADR 0019](decisions/0019-v07-local-measurement.md) 与经宿主验证的 [ADR 0020](decisions/0020-user-granted-local-media.md)。

依赖：[`SPEC_V061.md`](SPEC_V061.md) 的 P0 已落地。不要把新 Tool 建在不稳定的宿主配置和证据体系上。

## 目标（摘要）

1. 新增 `analyze_audio`：WAV/MP3/M4A/AAC/FLAC/OGG 以及从视频抽出音轨（不改源文件）。
2. 用 FFmpeg 或其它确定性算法测量 LUFS、True Peak、静音、削波等；禁止模型凭听感编造数值。数字静音必须与音轨存在、解码完整性、模型 `heard` 和声音语义分开；Proposed ADR 0019 的 Windows 原型支持“继承已授权 FileHandle fd → FFmpeg `fd:`”作为候选安全路径，但跨平台/长媒体验收与外部运行时审阅仍未完成。
3. 新增 `audit_media`：画面、声音、字幕、技术测量交叉验证后给分项发布结论。
4. 字幕按可靠性选择：独立字幕轨 > 用户 SRT/ASS/VTT > OCR > 仅多模态。
5. 统一 finding 结构、`severity`、`release_verdict`（内容质量 ≠ 版权授权）。
6. 用户亲自拖入或选择的单个视频可从任意文件夹分析；必须由宿主或本地交互提供可验证的单文件授权，不能把 Agent 给出的路径视作授权。

完整字段与回归夹具以用户综合需求原文为准；本文件只锁定「0.7 才做、0.6.1 不做」。

## 本轮禁止

- 为迁就上游五 Tool 测试而恢复旧接口。
- 未先批准生产依赖就引入 FFmpeg 发行包。
- 把 Key、模型或测量开关加进 `analyze_video` schema。
