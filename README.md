# analyze-video-mcp

给本地 Agent 增加视频理解。传入本地 MP4 或公开 HTTPS，返回纯文本。模型同时看画面、听视频里的音轨。

公开工具只有 `analyze_video`。不是 npm 包。在 Cursor、Claude Code、Codex 里用 `npx` 安装，填自己的百炼 Key 即可使用。

## 安装

需要 Node.js 20 或更新版本，以及阿里云百炼 `DASHSCOPE_API_KEY`。不要把 Key 写进仓库。

默认安装钉在发布标签 `v0.4.0`。要跟 `main` 的最新提交，把参数改成 `github:JaylanJerry/analyze-video-mcp#main`。

Cursor / Claude Code 用户配置示例：

```json
{
  "mcpServers": {
    "analyze-video": {
      "command": "npx",
      "args": ["-y", "github:JaylanJerry/analyze-video-mcp#v0.4.0"],
      "env": {
        "DASHSCOPE_API_KEY": "paste-your-key-here"
      }
    }
  }
}
```

Codex 见 [`qwen-omni-mcp/examples/mcp.codex.toml`](qwen-omni-mcp/examples/mcp.codex.toml)。完整模板：

- [`qwen-omni-mcp/examples/mcp.cursor.json`](qwen-omni-mcp/examples/mcp.cursor.json)
- [`qwen-omni-mcp/examples/mcp.claude-code.json`](qwen-omni-mcp/examples/mcp.claude-code.json)

首次 `npx` 会下载并 build，需要网络。本机已填写 Key 的 Host 配置不要提交。

装好后对 Agent 说「分析这个视频」，并带上本地绝对路径或公开 `https://` 链接。用一个很小的 MP4 试一次即可。没有单独的测试连接工具。

## 工具

```text
analyze_video(video, question?)
```

| 字段       | 必需 | 说明                                |
| ---------- | ---- | ----------------------------------- |
| `video`    | 是   | 本地绝对 MP4 路径，或公开 HTTPS URL |
| `question` | 否   | 默认问画面和声音里发生了什么        |

用户说得具体时，Agent 应把原话写入 `question`。只说「分析一下」时，先整理成具体的画面与声音问题再调用。

`QWEN_ALLOWED_ROOTS` 可选。建议填上，把可读范围限制在你的视频目录。留空时 MCP 不扫盘，但会读取调用方传入的任意合法本地绝对 MP4。填写后只允许这些目录。

## 限制

- 本地默认最高 1024 MiB，且不超过当场百炼政策。
- 更大或上行太慢：先放到公开 HTTPS，再把链接交给工具。不要重传同一本地大文件。
- 同一进程一次只处理一个视频。
- 部分 Host 默认超时约 60 秒，大文件需要调长。
- 图片、独立音频尚未提供。

## 开发

实现在 [`qwen-omni-mcp/`](qwen-omni-mcp/)。规格见 [`qwen-omni-mcp/docs/SPEC_INSTALL.md`](qwen-omni-mcp/docs/SPEC_INSTALL.md) 与 [`qwen-omni-mcp/docs/SPEC_V2.md`](qwen-omni-mcp/docs/SPEC_V2.md)。

```powershell
cd qwen-omni-mcp
npm install
npm test
npm run build
```

## 许可

MIT。本仓库是 `sommio/qwen-omni-mcp` 的专项 fork。
