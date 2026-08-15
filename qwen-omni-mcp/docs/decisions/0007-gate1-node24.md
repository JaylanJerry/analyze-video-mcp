# ADR 0007：Gate 1 以本机 Node 24 验收

- Status: Accepted
- Date: 2026-08-15

## Context

Gate 1 原文要求 Node 20 与 Node 22 的 50/500 MiB RSS 表。本机开发与将要启动 MCP 的运行时是 Node v24.18.0。用户确认这是单机 Agent，不发布 npm，也不需要为上游 CI 矩阵额外安装 Node 20。

本机已测：`fetch` + `duplex: "half"` 会把 500 MiB 整包缓冲；Node 内置 `http`/`https.request` 管道的 500 MiB RSS 增量约 17–31 MiB。

## Decision

- Gate 1 通过，依据是 Windows + Node 24 的上传测试与 RSS 测量。
- 不补测 Node 20。
- 最终启动 MCP 的运行时若是 Node 22，在 Gate 4 再补一次大文件 RSS；若仍是 Node 24，Gate 4 按 24 验收。
- 上传实现保持 Node 内置管道，不因此增加依赖。

## Alternatives

1. 为填表安装 Node 20 和 22 再测一遍：拒绝；不能改变本机将使用的运行时，也已被 24 上的反例证明关键差异在 API 选择，不在 20/22 数字本身。
2. 因为缺 20/22 表而卡住 T04：拒绝；用户已批准按 24 放行。

## Consequences

- REVIEW_GATES 中 Gate 1 的“Node 20、Node 22 表”对本项目改为“本机实际运行时表”。
- 可以开始 T04。
