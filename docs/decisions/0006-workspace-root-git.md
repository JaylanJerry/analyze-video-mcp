# ADR 0006：工作区根作为 git 根

- Status: Accepted（git 根）。嵌套 `qwen-omni-mcp/` 布局已被 [ADR 0011](0011-flatten-implementation-to-repo-root.md) 取代。
- Date: 2026-08-15

## Context

专项实现位于 `qwen-omni-mcp/`，该目录是上游 `sommio/qwen-omni-mcp` 的完整克隆。工作区根目录 `Video MCP/` 原先不是 git 仓库，Cursor 无法在工作区根跟踪交接文档与后续实现。内层仓库的 `feat/video-mcp-v1` 没有本地独有提交，HEAD 与上游 `8a07182554a985456153644e0006a22bd1c769f7` 相同；未跟踪内容只有交接包。

若根目录另建仓库并保留内层 `.git`，父仓库只能把 `qwen-omni-mcp` 记成 gitlink，交接文件无法被根仓库正常跟踪。

## Decision

- 工作区根 `Video MCP/` 是唯一 git 根。
- 实施分支仍为 `feat/video-mcp-v1`。
- 实现目录保持 `qwen-omni-mcp/`，不把源码上移到工作区根。
- 退役内层 `qwen-omni-mcp/.git`。上游历史可从 GitHub 取得；本仓库用文档记录基线哈希，并用 `upstream` remote 指向 `https://github.com/sommio/qwen-omni-mcp.git`。
- `text/` 中的视频和密钥不入库。

## Alternatives

1. 只使用内层仓库：拒绝；工作区根对 Cursor 仍不是 git 项目，根目录文件无法纳入同一历史。
2. 根仓库 + 内层仓库并存：拒绝；嵌套 gitlink 会丢掉未提交的交接包，或造成双历史。
3. 把 `qwen-omni-mcp/` 内容提升到工作区根：拒绝；交接包、上游 README 与路径约定都按该子目录书写，v1 不值得为 git 根再搬一次树。

## Consequences

- 本仓库的 HEAD 不再等于上游提交 `8a07182`；该哈希是代码快照对照，不是当前祖先。
- `npm`、测试和现有相对路径继续在 `qwen-omni-mcp/` 下运行。
- 之后不要在 `qwen-omni-mcp/` 内重新 `git init`。
