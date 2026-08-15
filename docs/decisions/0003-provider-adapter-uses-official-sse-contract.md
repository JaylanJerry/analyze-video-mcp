# ADR 0003：Provider 采用正式 SSE 契约并与 Tool 隔离

- Status: Accepted
- Date: 2026-08-15

## Context

上游 `analyze()` 使用非流式 JSON。仓库维护者曾实测非流也能返回 200，但 Qwen3.5-Omni 当前官方示例明确要求 `stream: true`，响应通过 `choices[0].delta` 逐块返回。依赖未文档化行为会增加接口变更风险。

用户还要求未来切换为其他视频模型时不影响 Agent 使用。

## Decision

- `QwenVideoAnalyzer` 位于内部 provider 边界后。
- 当前 payload 固定使用 `qwen3.5-omni-flash`、`modalities:["text"]`、`stream:true` 和 usage stream option。
- 独立增量 SSE parser 聚合完整文本。
- Agent 只看到最终 text，不看到 chunk 或 provider metadata。
- 只在首个有效 delta 前对少数暂时错误做至多一次重试。

## Alternatives

1. 延续非流 JSON：拒绝；与官方契约冲突。
2. 直接使用 OpenAI SDK：拒绝；当前项目没有该依赖，且临时 `oss://` HTTP header 仍需显式处理。
3. 将 SSE chunk 流式转发给 Agent：拒绝；不是用户需求，会扩大 MCP 契约。
4. 在 `server.ts` 内直接写 provider fetch：拒绝；妨碍未来模型替换和单元测试。

## Consequences

- 与当前官方协议一致，且响应解析可独立模糊测试。
- 需要处理 SSE 分块、usage-only 与截断等复杂边界。
- Provider 替换不会改变 Tool schema。
- 真实协议变化必须通过 Gate 2 重新验证。
