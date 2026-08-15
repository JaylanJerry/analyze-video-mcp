# Video MCP 开发交接

状态：v1 本机收尾完成；V2 与安装形态已实施。公开仓库 `JaylanJerry/analyze-video-mcp`。未发 npm。实现已提到仓库根（ADR 0011）。

基线快照：`sommio/qwen-omni-mcp@8a07182554a985456153644e0006a22bd1c769f7`。

工作区 git 根：本目录（见 ADR 0006、ADR 0011）。

本地分支：`feat/video-mcp-v1`。

## 当前产品

v1 已本机收尾。V2 已实施。安装：`npx` + Key；目录可选；Agent 应转发或整理 `question`。

已在 Windows Node 24 + Cursor 上验证：中文文件名小视频、口播、496.8 MiB 漫剧。Cursor 用户级 MCP 名称是 `analyze-video`。

## 下一阶段

安装规格已落地。默认用 `npx -y github:JaylanJerry/analyze-video-mcp#v0.4.0`。跟最新提交用 `#main`。未另说不要发 npm。

v0.5.0 工程收口已批准：[`docs/SPEC_V05.md`](docs/SPEC_V05.md)。一次只做 `tasks/todo-v05.md` 里的下一项。

绑定文档：

1. [`docs/SPEC_V05.md`](docs/SPEC_V05.md)
2. [`docs/decisions/0012-v050-runtime-and-hygiene.md`](docs/decisions/0012-v050-runtime-and-hygiene.md)
3. [`tasks/todo-v05.md`](tasks/todo-v05.md)
4. [`docs/SPEC_INSTALL.md`](docs/SPEC_INSTALL.md)
5. [`docs/SPEC_V2.md`](docs/SPEC_V2.md)

## 硬规则

- 不改变 `analyze_video` 的名称与字段。
- 不增加生产依赖。不要主动推送或发布 npm，除非用户明确要求。
- 不读取、复制、打印或提交密钥或 `text/*.key`。
- 私人 live fixture 留在 `text/`。CI 用 `test/fixtures/live-av.mp4`。
- 付费 live 必须用户明确授权。

## 接手者先读

v1 背景仍按原顺序：`AGENTS.md`、`docs/SPEC.md`、`docs/API_CONTRACT.md`、架构 / 协议 / 安全 / 测试、`tasks/todo.md`、`docs/REVIEW_GATES.md`。

然后读通用方向四份文档。实现方向与已接受 ADR 冲突时，必须先有新 ADR 被批准。

## 给下一模型的启动提示词

```text
你在 analyze-video-mcp 仓库根工作。v1 / V2 / 安装已完成，未发 npm。
v0.5.0 规格已批准。一次只做 tasks/todo-v05.md 中的一项；不要改 analyze_video
字段，不要加依赖，不要读密钥，不要主动推送或发布。
```
