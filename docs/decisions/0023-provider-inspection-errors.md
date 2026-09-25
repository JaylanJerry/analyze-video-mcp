# ADR 0023：明确报告百炼内容检查拒绝

- Status: Accepted
- Date: 2026-09-25

## 背景

一段 14 分 50 秒的本地 MP4 在两次已授权 live 调用中，均收到首个 SSE 事件 `error.code=data_inspection_failed`，没有生成分析内容。原实现把所有 SSE 错误事件归为 `PROVIDER_RESPONSE_INVALID` 并给出 `retryable:true`，同时舍弃服务商错误消息与 Request ID。阿里云文档将该错误码归于内容检查拦截；仅凭错误码无法确定输入还是输出被拦，也无法断定视频违规。HTTP 400 JSON 错误正文同样可能返回该错误码，原实现直接丢弃正文。

## 决定

- 已知 `DataInspectionFailed` / `data_inspection_failed` 在 SSE 错误事件及 HTTP 错误正文中统一映射为 `PROVIDER_CONTENT_REJECTED`，`retryable:false`，不自动重试。
- 仅将服务商消息中已知的固定措辞归纳为 `inspection_side=input|output|unknown`；不向 Agent 透传原文，也不把拦截等同于视频违规。
- 可用的 Request ID 只从显式 `request_id` 字段或响应 Header 提取，经长度、字符集和敏感值校验后放入错误 `structuredContent.request_id`，便于模型监控或工单查询；未提供时省略。SSE 的 `id`（`chatcmpl-…`）是补全 ID，不冒充 Request ID；成功结果的内部请求编号遵循同一来源规则。阿里云[错误码文档](https://help.aliyun.com/zh/model-studio/error-code)给出的 Request ID 是 UUID，[OpenAI 兼容响应示例](https://help.aliyun.com/zh/model-studio/context-cache)将 `id` 与 `request_id` 分开列出。
- 其他格式正确的 SSE 服务商错误归为 `VIDEO_ANALYSIS_FAILED`，保留安全的 `diagnostics.error_code`；真正的 SSE 解析、结构或截断错误仍用 `PROVIDER_RESPONSE_INVALID`。
- HTTP 非成功响应正文最多读取 64 KiB，只识别已知内容检查错误；其他状态码映射、429/502/503 自动重试行为保持原样。Tool 名称与输入字段不变，不增加依赖或付费验证。

## 验证边界

单元与模拟 HTTP/SSE 测试覆盖两种错误形态、输入/输出/未知归纳、Request ID 脱敏与补全 ID 区分、429 仍重试，以及内容检查不重试。2026-09-25 重启后的同一视频真实调用确认 `PROVIDER_CONTENT_REJECTED` / `retryable:false` / `inspection_side:unknown`，服务商仍在首个 SSE 事件拒绝，未提供视频分析内容；这次调用也暴露了 `chatcmpl-…` 被误标为 Request ID 的问题，本 ADR 的来源限制是之后的修正。修正后的 Request ID 来源尚未再做付费 live 验证。服务商若改变错误结构或措辞，侧别会保守地显示 `unknown`。
