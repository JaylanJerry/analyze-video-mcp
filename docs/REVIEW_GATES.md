# 主审核关卡

普通任务由接手模型自行完成。只有以下关卡需要主审核者介入。每次提交证据必须脱敏；不要发送 API Key、policy、完整 OSS URL 或本地绝对路径。

## Gate 0：规格冻结

时机：编码前。

状态：本文档包已准备好；用户将其交给接手模型即视为同意按此基线开始。

审核对象：

- 公开 Tool 只有 `analyze_video`；
- `qwen3.5-omni-flash` 音视频联合理解；
- 本地最大 500 MiB，临时上传，SSE；
- v1 非目标与安全边界；
- 无新增依赖、无发布行为。

若接手模型想改变以上任何一项，必须在编码前返回变更建议和理由。

## Gate 1：上传与内存

状态：2026-08-15 由用户按本机 Node 24 放行，见 [0007](decisions/0007-gate1-node24.md)。不补测 Node 20。

时机：完成 T01–T03 后。

必须提交：

1. `git diff --stat` 和相关 diff。
2. config、media、upload 单元/集成测试输出。
3. multipart wire capture 的字段清单与文件 hash 对比。
4. 本机实际运行时（现为 Node 24）的 50 MiB 与 500 MiB mock 上传 RSS 表。Node 20 不测；若最终 Host 使用 Node 22，在 Gate 4 补测。
5. Windows 中文路径和 junction 测试结果。
6. FileHandle 生命周期与 abort 说明。
7. 完整质量门结果。

通过条件：

- 无 Base64、整文件 Buffer/Blob/readFile；
- 500 MiB RSS delta ≤192 MiB，且不随文件大小线性增长；
- policy 不足时零字节上传；
- 越界路径与 junction 拒绝；
- secrets 不进入错误/日志。

若 Node 内置 multipart 不可靠，在此 Gate 只提出最小依赖方案、维护状态、许可、包大小和替代方案；等待用户批准后再改 `package.json`。

## Gate 2：Provider/SSE 与真实语义

时机：完成 T04–T05 后。

必须提交：

1. SSE parser 的分块测试矩阵与 coverage。
2. 推理 payload/header 的 mock capture。
3. 429/502/503、timeout、截断流、usage-only chunk 的结果。
4. 用户明确授权后的小型 AV live 结果：必须同时识别 `24` 和 `3.1415926`。
5. 脱敏 request id、HTTP status、chunk 数、耗时；不得提交 key、policy、OSS URL。
6. 完整质量门结果。

通过条件：

- `stream:true` 且 SSE 聚合正确；
- `modalities:["text"]`，无 Thinking、无音频输出；
- 内嵌音轨语义真实命中；
- 首字节后失败不重试；
- Agent-facing error 完全脱敏。

## Gate 3：MCP 与安全边界

时机：完成 T06 后。

必须提交：

1. `listTools()` 和 Tool schema 快照。
2. `Client + InMemoryTransport` E2E 输出。
3. allowed roots、symlink/junction、TOCTOU 缓解测试结果。
4. stdout/stderr 检查。
5. 启动、正常关闭、上传中取消、推理中取消结果。
6. 从固定上游提交至当前分支的完整 diff 摘要。
7. 完整质量门与 coverage。

通过条件：

- Agent 只看到一个稳定 Tool；
- 成功只返回文本；
- 错误码符合契约；
- stdout 无日志污染；
- 本地文件外传边界与文档一致；
- 没有声称消除了仍存在的 TOCTOU 残余风险。

## Gate 4：Windows 500 MiB 发布候选

时机：T07–T09 完成后；这是 v1 完成审核。

必须提交：

1. Windows 11、Node 22、实际 Agent Host 和 MCP 配置说明。
2. 中文/空格路径的小型语义 AV 完整调用。
3. 450–500 MiB、约 7 分钟视频完整调用。
4. 上传和推理各阶段耗时、peak RSS/delta、request id。
5. Ctrl+C/Host 退出时资源关闭结果。
6. CI Node 20/22 与 Windows job 结果。
7. 所有文档与实现差异清单，应为空或明确列为已知限制。
8. `npm audit --omit=dev` 与全部质量门结果。

通过条件：

- 真实 Agent 使用时无需知道上传或模型细节；
- 500 MiB 不触发 O(file size) 内存；
- 小型 AV 同时听到和看到；
- 所有安全、质量、Windows 验收通过；
- 不含 secrets，未发布、未推送。

状态：2026-08-15 证据收齐。本机按可用收尾，**不发布**。主 Host 为 Cursor（用户级 `analyze-video`）。补充证据：Cursor 真实调用 `8月15日.mp4` 与 `2-under500.mp4`（8192 token 写到片尾）。CI 未推送故未在 GitHub 跑过，列为已知限制。

发布 npm、制作 exe 或切换生产 OSS 是后续独立决策。通用方向不走 Gate 4 翻案，另见 [`SPEC_GENERAL.md`](SPEC_GENERAL.md)。
