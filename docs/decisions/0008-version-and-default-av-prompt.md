# ADR 0008：0.4.0 版本对齐与默认音视频问句

- Status: Accepted
- Date: 2026-08-15

## Context

上游 `package.json` 仍是 0.3.1，而 MCP `initialize` 曾写 0.4.0。专项 fork 已把公开表面收成唯一 `analyze_video`，再沿用 0.3.1 会假装与上游五 Tool 包兼容。

Live 还证明：默认问句若只写「详细说明视频内容」，模型可能只描述画面。产品语义是分析视频等于画面加内嵌音轨。

## Decision

1. 发布前版本号定为 `0.4.0`，表示破坏性 Tool 收敛，不表示 v1 已可用，也不发布 npm。
2. `src/version.ts` 的 `PACKAGE_VERSION` 是 MCP initialize 与 `package.json` 的单一来源；测试断言二者相等。
3. 默认 `question` 为 `画面里发生了什么？音频说了什么？`。Server 在发给模型前再固定包一层音视频约束。公开 schema 仍只有 `video`、`question`、`max_tokens`。

## Consequences

- Agent Host 配置和 README 只描述已实现的单 Tool 行为。
- Gate 4 通过前不得把 0.4.0 写成已发布或 v1 完成。
