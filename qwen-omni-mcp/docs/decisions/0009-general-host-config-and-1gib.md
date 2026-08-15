# ADR 0009：通用 Host 配置与 1 GiB 本地上限

- Status: Accepted
- Date: 2026-08-15

## Context

v1 按开发难度把本地上限冻在 500 MiB，并把 API Key 写成“由启动进程注入，不建议写入 Host 配置”。本机验收已经证明：流式上传内存与文件大小解耦；Cursor 可完整分析约 500 MiB 视频；百炼临时上传政策为 1024 MB。

用户要求转向更通用的 MCP：别人换一台机器也能装；本地文件对齐供应商上限；配置按 MCP 常规由用户自己填写。这与 v1 的 500 MiB 硬顶和仓库内 `*.key` 启动脚本冲突。

v1 的 Tool 表面仍然正确，不应为了通用化拆成多个 Tool 或做成 GUI。

## Decision

在批准 [`SPEC_GENERAL.md`](../SPEC_GENERAL.md) 后：

1. 保持唯一 Tool `analyze_video`。V2 公开字段为 `video` 与 `question`，去掉 `max_tokens`。
2. 本地策略上限改为默认 1024 MiB；硬顶 1024 MiB；实际上传前仍取 `min(用户配置, 当场 policy.max_file_size_mb)`。网速够就直接上传分析；上传超时或凭证过期时用错误文本建议改走公开 HTTPS，不测速、不弹窗、不自动重传。
3. 标准安装路径是用户在本机 Host `env` 中自己填写 `DASHSCOPE_API_KEY`、`QWEN_ALLOWED_ROOTS`，以及可选的 Base/Upload URL。仓库提供无密钥模板。密钥不得提交。
4. 仓库内读取 `text/*.key` 的启动脚本只算本机开发便利，不再当作产品安装方式。
5. 本 ADR 只覆盖本地上限与 Host 配置。正式 OSS、npm 发布、额外 Tool、GUI 仍不在范围。

本 ADR 批准后，取代 ADR 0002 / 0004 中“产品本地上限必须是 500 MiB”的部分；流式上传、默认拒绝本地路径、MP4 only 仍然有效。

## Alternatives

1. 继续 500 MiB：拒绝；用户真实 7 分钟素材会略超上限，而政策已是 1024 MB。
2. 做成配置 GUI：拒绝；stdio MCP 没有统一 UI，v1 已列为非目标。
3. 把 key 或 URL 放进 Tool 参数：拒绝；会进入对话上下文，且破坏“对 Agent 像原生能力”。
4. 立刻上正式 OSS：暂缓；当前网速已能传约 500 MiB，1 GiB 先用动态政策与超时失败提示。

## Consequences

- 564 MiB 一类本地文件可以直接分析，不必先截断。
- 1 GiB 必须在约 300 秒凭证窗口内传完；慢网应改用公开 HTTPS 或以后的正式 OSS。
- 用户本机 `mcp.json` 会含密钥，必须 gitignore，文档必须写明不要提交。
- 测试与 `.env.example` 必须把 1–500 改成 1–1024。
