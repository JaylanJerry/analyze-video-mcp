# Video MCP

给本地 Agent 增加视频理解：传入本地 MP4 或 HTTPS URL，返回纯文本。画面和内嵌音轨由模型直接读取。

实现目录是 [`qwen-omni-mcp/`](qwen-omni-mcp/)。公开工具只有 `analyze_video`。当前实现到 T08；v1 还要等 T09 真实 Host / 500 MiB 验收和 Gate 4。

## 先读

1. [`qwen-omni-mcp/DEVELOPMENT_HANDOFF.md`](qwen-omni-mcp/DEVELOPMENT_HANDOFF.md)
2. [`qwen-omni-mcp/docs/API_CONTRACT.md`](qwen-omni-mcp/docs/API_CONTRACT.md)
3. [`qwen-omni-mcp/README.md`](qwen-omni-mcp/README.md) — 安装与 Host 配置
4. [`qwen-omni-mcp/tasks/todo.md`](qwen-omni-mcp/tasks/todo.md)

## 布局

```text
Video MCP/                  git 根，分支 feat/video-mcp-v1
  qwen-omni-mcp/            实现与规格
  text/                     仓库外 live fixture 与密钥，不入库
```

## 命令

在 `qwen-omni-mcp/` 下：

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

真实 API 测试会花钱，不要自动跑。Key 只放在进程环境里。
