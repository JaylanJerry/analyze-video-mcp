# ADR 0024：下一大版本采用 Agent 主导的单入口媒体网关

> Runtime support for the unreleased next major was decided separately in [ADR 0025](0025-next-major-node24-support.md): Node 24.x only; this does not revise published npm `0.6.1` history.

- Status: Accepted for next major; implemented on working branch, unreleased
- Date: 2026-09-25
- Spec: [`SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md`](../SPEC_MEDIA_GATEWAY.md)
- Supersedes for next major: ADR 0001 的“只接受视频”范围与现行 Tool 名称；停止推进 Proposed ADR 0018/0019 的三 Tool、测量与审核主线

## Context

当前 `analyze_video(video, question?)` 已可向百炼上传本地视频并分析，但服务端同时追加宽泛问题的固定提纲、要求证据 JSON、清理/重排回答，有时还会为纠错再次请求。用户明确要求的产品职责是“上传视频或音频，让 Agent 决定向媒体模型问什么”，支持 MP4/MOV/MP3。上述报告层与 Agent 的提问、归纳职责重叠，增加行为不可预期和重复付费风险。历史 v0.7 提案进一步增加 `analyze_audio`、`audit_media` 与 FFmpeg 测量，偏离已确认的单入口目标。

公开同类实现提供了三种可对照的形态：[qwen-omni-mcp](https://github.com/sommio/qwen-omni-mcp) 和 [mcp_video_recognition](https://github.com/mario-andreschak/mcp_video_recognition)以媒体加自定义 prompt 为主；[video-intelligence-mcp](https://github.com/DugboTek/video-intelligence-mcp)用上传会话 ID 支持追问；[mcp-video-analyzer](https://github.com/guimatheus92/mcp-video-analyzer)走转写、帧与 OCR 提取。项目的目标最接近第一种，现有上传缓存已经可以支撑同文件再次提问。以上是公开文档设计比较，不等于安装实测或模型质量比较。

## Decision

1. 下一大版本对 Agent 只暴露 `analyze_media(media, prompt)`；`prompt` 必填。包名与 CLI 保留。旧 `analyze_video` 的破坏性迁移须写清并以契约测试验证，不把两个同义 Tool 长期并列。
2. MCP 管文件授权、格式/编码与大小/时长边界、上传/缓存、协议适配、超时取消、进度、脱敏、错误和用量。Agent 管问题、追问与用户可见归纳。服务端不注入业务报告模板，不强制模型输出证据 JSON，不重写模型的语义结论，也不为“证据纠错”自动产生第二次付费分析。
3. 首批本地格式 MP4/MOV/MP3；保留当前公开 HTTPS 视频 URL 直连能力，远端音频 URL 留待单独确定类型判别与路由。按已验证的本地媒体种类路由到百炼的视频或音频输入协议，未经验证的组合明确失败。不得静默转码或整文件 Base64。
4. 首发单一百炼服务商。内部保留窄适配边界，但不预建通用多云框架、不自动切到第二家。第二家必须有同样样本的质量、费用、时延与隐私对照和单独决定。
5. 本地文件事实、模型报告与用户判断保持分层。只把可靠探测到的轨道、时长等列为本地事实；是否听到、看见由模型回答表达，MCP 不宣称独立确认。已接受的授权、缓存、脱敏、取消与内容检查拒绝防护继续有效。临时上传缓存必须按账号或凭证身份隔离，无法安全确认同一身份时使旧项失效，不能保存 Key 或上传凭证。
6. 新 Tool 的本地授权改用 `MEDIA_ALLOWED_ROOTS` / `MEDIA_ALLOW_ANY_LOCAL_FILE`；旧 `QWEN_ALLOW_ANY_LOCAL_VIDEO` 与 `QWEN_ALLOWED_ROOTS` 不自动转为新 Tool 权限。允许任意目录上传媒体须由安装者明确启用，默认关闭；doctor 提示旧配置的迁移办法。

## Alternatives

1. 保留三 Tool 加综合审核：不作为本轮产品主线。工具选择、测量依赖和审核结论会覆盖用户的基本“上传并问”需求；旧提案留档供独立产品再评估。
2. 保留 `analyze_video` 名称但让它也接收 MP3：迁移成本较低，但字段/Tool 名称误导 Agent。下一大版本采用更准确的 `analyze_media`，并提供清楚迁移说明。
3. `analyze_video` 与 `analyze_media` 同时长期暴露：Agent 可能选错，也违背单入口目标；不采用。短期迁移工具只可在非默认开发构建中临时使用，不进入正式 Tool 列表。
4. 增加保留会话 ID、`ask_video` 与 `forget_video`：只有服务商真正提供可复用会话且路径重用不足以满足需求时才另立决策。上传 URL 缓存不等于模型对话记忆。
5. 首发接 Gemini、自动跨云回退：暂不采用。会扩大密钥、上传同意、费用、缓存隔离与错误语义的范围，缺少本项目对照证据。

## Consequences and boundaries

- 对现有调用者是破坏性 Tool 改名和参数变化；需更新 Host 示例、Server instructions、README、API 契约、doctor、测试和独立安装验证。发布与默认安装版本在通过全部门禁前不动。
- 已发布 `0.6.1` 仍是唯一 `analyze_video`；当前工作区分支已按本 ADR 与新规格改为唯一 `analyze_media`，并更新 `AGENTS.md` 与 `API_CONTRACT.md`。除这项明确迁移，既有安全与工程硬规则不放宽。
- 当前 ADR 0022 可选数字静音核对属于旧报告管线。下一大版本移除它的 FFmpeg 测量和对主回答的语义改写，迁移文档明确 `QWEN_AUDIO_SILENCE_CHECK` 不再生效；历史测试证据保留，并用回归测试证明新版本没有把“有音轨/非零信号”冒充“听到”。未来若要恢复测量，应独立设计元数据，不能暗中恢复报告门禁。
- MP3 临时上传 URL 与 `input_audio` 的组合必须先做协议探针，再承诺音频可用。未获单独授权时可以继续视频实现和 MP3 模拟测试，但不得据此通过 MP3 的真实验收或发布门；协议失败时先提交证据及规格调整，不暗换传输方式。
- 用户已确认此产品方向，并指定由 DeepSeek 接手后续普通开发；当前工作区分支已实现核心代码并完成部分真实服务商和 Codex 宿主 Tool 验收，状态以任务清单为准。跨云上传、增加依赖、推送或发布仍各需按仓库规则单独审阅；新的付费 live 也须逐次授权。
