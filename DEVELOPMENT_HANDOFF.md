# Video MCP 开发交接

状态：v0.5.2 已在 npm。v0.6 见 [`docs/SPEC_V06.md`](docs/SPEC_V06.md) 与 [ADR 0015](docs/decisions/0015-host-reliability-and-evidence-gate.md)。推已授权的 `v*` tag 时，`release.yml` 用 Trusted Publishing 发 npm 并建 GitHub Release（[ADR 0014](docs/decisions/0014-npm-trusted-publishing.md)）。人须在 npm 包设置里点一次 Trusted Publisher。不要添加 `NPM_TOKEN`。打 tag 仍须另授权。不要补打已发 npm 的 `v0.5.1` / `v0.5.2`。

基线快照：`sommio/qwen-omni-mcp@8a07182554a985456153644e0006a22bd1c769f7`。

工作区 git 根：本目录（见 ADR 0006、ADR 0011）。

本地分支：以当前工作分支为准。

## 当前产品

v1 已本机收尾。V2 已实施。安装：钉版本 `npx` + Key + `QWEN_ALLOWED_ROOTS`；Agent 应转发或整理 `question`。

已在 Windows Node 24 + Cursor 上验证：中文文件名小视频、口播、496.8 MiB 漫剧。Cursor 用户级 MCP 名称是 `analyze-video`。

## 下一阶段

v0.6 见 [`docs/SPEC_V06.md`](docs/SPEC_V06.md)。推已授权的 `v*` tag 时，`release.yml` 用 Trusted Publishing 发 npm 并建 GitHub Release（[ADR 0014](docs/decisions/0014-npm-trusted-publishing.md)）。人须在 npm 包设置里点一次 Trusted Publisher。不要添加 `NPM_TOKEN`。打 tag 仍须另授权。不要补打已发 npm 的 `v0.5.1` / `v0.5.2`。

绑定文档：

1. [`docs/SPEC_V06.md`](docs/SPEC_V06.md)
2. [`docs/decisions/0015-host-reliability-and-evidence-gate.md`](docs/decisions/0015-host-reliability-and-evidence-gate.md)
3. [`docs/decisions/0014-npm-trusted-publishing.md`](docs/decisions/0014-npm-trusted-publishing.md)
4. [`docs/SPEC_V052.md`](docs/SPEC_V052.md)
5. [`docs/SPEC_INSTALL.md`](docs/SPEC_INSTALL.md)

## 硬规则

- 不改变 `analyze_video` 的名称与字段。
- 不增加生产依赖。不要从本机主动推送或 `npm publish`，除非用户明确要求。已授权的 `v*` tag 由 `release.yml` 发 npm。
- 不读取、复制、打印或提交密钥或 `text/*.key`。
- 私人 live fixture 留在 `text/`。CI 用 `test/fixtures/live-av.mp4`。
- 付费 live 必须用户明确授权。

## 接手者先读

v1 背景仍按原顺序：`AGENTS.md`、`docs/SPEC.md`、`docs/API_CONTRACT.md`、架构 / 协议 / 安全 / 测试、`tasks/todo.md`、`docs/REVIEW_GATES.md`。

然后读通用方向四份文档。实现方向与已接受 ADR 冲突时，必须先有新 ADR 被批准。

## 给下一模型的启动提示词

```text
你在 analyze-video-mcp 仓库根工作。v1 / V2 / 安装 / v0.5.x 已完成，v0.6 见 docs/SPEC_V06.md。
默认安装钉 analyze-video-mcp@0.6.0。不要改 analyze_video
字段，不要加依赖，不要读密钥。不要本机 npm publish。已授权的 v* tag 由 release.yml 发 npm。
```
