# ADR 0018：v0.7 独立音频与媒体审核 Tool

- Status: Proposed
- Date: 2026-09-22
- Spec: [`SPEC_V07_PROPOSAL.md`](../SPEC_V07_PROPOSAL.md)

## Context

ADR 0001 将产品收敛为唯一 `analyze_video`，当时目标是视频画面与内嵌声音的联合理解。现有 Agent 工作流还需要独立分析纯音频，并把视频、声音、字幕和技术测量交叉审核。把这两类任务塞进 `analyze_video.question` 会让输入类型、覆盖率和证据来源不清晰。`SPEC_V07.md` 已将新 Tool 留到 v0.7，要求另批 ADR。

## Proposed Decision

1. 保留 `analyze_video(video, question?)` 的名称、字段、默认值与既有兼容性保证。新增 `analyze_audio(audio, question?)` 与 `audit_media(video, subtitles?, question?)`，不恢复上游 `analyze_image`、`analyze_audio_video` 或 `check_endpoint_status`。
2. `analyze_audio` 接受独立音频或 MP4 音轨，负责听觉语义与已验证的技术测量；`audit_media` 汇合各独立证据并给分项结论。技术数值不得由模型生成。模型或测量能力缺席时返回明确的 `incomplete`，不伪装成功。
3. 新 Tool 仍返回单个中文 text，加可选安全的 `structuredContent`。共用 finding、coverage、证据标签和分项 verdict 语义；`rights` 作为独立未验证/受阻状态，不从内容质量推导。
4. 三个 Tool 共用配置解析、允许根、脱敏、活动任务上限、取消和进度原则。MCP 在配置缺失时仍可 `initialize` / `tools/list`；工具调用阶段报告安全错误。
5. 在 Provider 音频协议、输入限制、测试夹具和资源边界获得证据之前，不冻结新 schema，也不实现对外可调用的新 Tool。接受本 ADR 后须同步 `docs/API_CONTRACT.md`、Server instructions、Tool 描述、示例和契约测试。

本 ADR 一旦接受，仅取代 ADR 0001 的“恰好一个 Tool”限制；原 `analyze_video` 的其余约束及 ADR 0009、0015、0016、0017 继续有效。

## Alternatives

1. 继续只用 `analyze_video` 并把音频路径传入 `video`：拒绝提案；字段语义与 MP4 授权校验不匹配。
2. 恢复上游五 Tool：拒绝提案；`analyze_image` 等不属于本产品范围。
3. 只做一个万能 `audit_media`：暂不采用；简单音频问题会被迫承担字幕、画面和发布结论的复杂度。
4. 一次发布三个 Tool：可行但风险高；建议先完成音频与测量，再交付依赖其证据的审核 Tool。

## Consequences

- Agent 多两个明确入口，旧 `analyze_video` 客户端继续可用；Tool 列表测试和文档需要改为三 Tool。
- 新 Tool 的输入与结构化输出成为公开契约，发布后不能随意改字段或枚举。
- 审核结论的质量取决于证据来源与覆盖率；OCR、转写、权利资料缺席时输出必须保持保守。
- 本提案尚未授权改动代码、依赖、tag 或发布。
