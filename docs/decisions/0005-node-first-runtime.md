# ADR 0005：v1 以 Node 运行时为准

- Status: Accepted（Node `>=20` 工程兼容目标已被 [0012](0012-v050-runtime-and-hygiene.md) 取代，现为 `>=22`）
- Date: 2026-08-15

## Context

上游 package 支持 Node 20+，release workflow 还用 Bun 交叉编译 Windows 二进制。500 MiB multipart 流对 FormData、fetch、Readable 和背压实现非常敏感；Node 与 Bun 的行为不能假定一致。用户当前只需要在一个本地 Agent 中使用 MCP，不要求 npm 或 exe 发布。

## Decision

- ~~保持 Node `>=20` 工程兼容目标。~~ 已被 ADR 0012 取代为 `>=22`。
- ~~Node 20/22 跑单元与 mock CI。~~ 现为 Node 22/24；见 ADR 0012。
- Windows 11 + Node 22 是真实发布验收环境。
- v1 不发布、不验证 Bun 二进制；现有 release 文件先不扩展。
- multipart 首选 Node 内置流能力，不新增生产依赖；以 Gate 1 数据决定是否申请依赖。

## Alternatives

1. 同时支持 Node/Bun/Windows exe：拒绝；增加验证矩阵，不能帮助核心目标更快可靠完成。
2. 只支持 Node 22 并修改 engines：未采用；Node 20 现有 CI 可低成本继续覆盖。
3. 立即引入 multipart 库：暂缓；先用测量证明需要，遵守依赖审批规则。

## Consequences

- 自 ADR 0012 起，工程兼容目标改为 Node `>=22`；本 ADR 的 Node `>=20` 条款不再执行。
- v1 验收范围清楚，减少跨运行时不确定性。
- 上游现有 Bun artifact 不代表专项功能已支持。
- 未来若要发布 exe，需要新的任务、测试矩阵和 ADR 更新。
