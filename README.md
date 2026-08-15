# Video MCP

给本地 Agent 增加视频理解能力的专项工作区：传入本地 MP4 或 HTTPS URL，返回纯文本。画面和内嵌音轨由模型直接读取，客户端不抽帧、不抽音频。

实现目录是 [`qwen-omni-mcp/`](qwen-omni-mcp/)。当前状态是**规格已冻结、交接包已接受、业务代码尚未修改**。

## 先读

1. [`qwen-omni-mcp/DEVELOPMENT_HANDOFF.md`](qwen-omni-mcp/DEVELOPMENT_HANDOFF.md) — 接手入口、接受范围与执行规则
2. [`qwen-omni-mcp/docs/SPEC.md`](qwen-omni-mcp/docs/SPEC.md) — 产品范围
3. [`qwen-omni-mcp/docs/API_CONTRACT.md`](qwen-omni-mcp/docs/API_CONTRACT.md) — 唯一 Tool 契约
4. [`qwen-omni-mcp/tasks/todo.md`](qwen-omni-mcp/tasks/todo.md) — 一次只做一个任务

## 布局

```text
Video MCP/                  git 根，分支 feat/video-mcp-v1
  qwen-omni-mcp/            实现与规格（上游基线 8a07182）
  text/                     仓库外 live fixture 与密钥，不入库
  README.md
  AGENTS.md
```

上游对照提交：`sommio/qwen-omni-mcp@8a07182554a985456153644e0006a22bd1c769f7`。

## 命令

在 `qwen-omni-mcp/` 下执行。依赖已按 lockfile 安装。P04 基线见 [`qwen-omni-mcp/tasks/todo.md`](qwen-omni-mcp/tasks/todo.md)。

```powershell
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

真实 API 测试会产生费用，不得自动执行。
