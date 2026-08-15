# ADR 0001：专项版只暴露一个视频 Tool

- Status: Accepted
- Date: 2026-08-15

## Context

上游提供 `analyze_video`、`analyze_image`、`analyze_audio`、`analyze_audio_video` 和 `check_endpoint_status`。本项目的唯一目标是让一个 Agent 在需要分析视频时获得联合画面/音频理解。多个相近 Tool 会把模型能力差异泄露给 Agent，并增加选错入口的概率。

上游 `AGENTS.md` 要求不要静默更改 Tool schema；因此专项 fork 必须明确记录这是有意的破坏性产品收敛。

## Decision

只注册：

```text
analyze_video(video, question?, max_tokens?)
```

它的语义固定为“分析视频可用的画面和音频”。模型、上传器和 provider 均为内部细节。上游其他 Tool 从专项 Server 移除，不保留兼容 alias。

## Alternatives

1. 保留全部五个 Tool：拒绝；偏离用户范围并让 Agent 路由复杂化。
2. 保留 `analyze_audio_video` 名称：拒绝；Agent 更自然地寻找 `analyze_video`，且未来纯视频 provider 仍需同一入口。
3. 保留旧 `video_url` 字段：拒绝；该名称误导本地路径使用，专项无既有客户端需要兼容。

## Consequences

- Agent 接口简单且可跨模型保持稳定。
- 本专项不向后兼容上游五 Tool 客户端。
- 所有 tool-list、README 和测试必须同步修改。
- 未来单独图片/音频能力需要新的用户批准与 ADR。

