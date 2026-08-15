# qwen-omni-mcp

给本地 Agent 增加一个视频分析工具。传入本地 MP4 或公开 HTTPS URL，返回纯文本。模型同时看画面、听内嵌音轨；客户端不抽帧、不抽音频。

这是上游 `sommio/qwen-omni-mcp` 的专项 fork，**只注册 `analyze_video`**。不是已发布的 npm 包。推到 GitHub 之后用 `npx` 安装。

## 公开工具

```text
analyze_video(video, question?)
```

| 字段       | 必需 | 默认                               | 说明                                     |
| ---------- | ---- | ---------------------------------- | ---------------------------------------- |
| `video`    | 是   | 无                                 | 本地绝对 MP4 路径，或公开 `https://` URL |
| `question` | 否   | `画面里发生了什么？音频说了什么？` | 关于画面和声音的问题                     |

成功只返回一段文本。不要传入 model、upload、thinking、max_tokens 或音频参数。回答长度按模型自身上限。

用户说得具体时，把原话写入 `question`。只说「分析一下」时，先整理成具体的画面与声音问题再调用。

## 要求

- Node.js 20 或 22。本机开发可用 Node 24。
- 环境变量 `DASHSCOPE_API_KEY`（自己填写，不要写入仓库）。
- `QWEN_ALLOWED_ROOTS` 可选。建议填写视频目录。留空时不扫盘，但会读取调用方传入的任意合法本地绝对 MP4。

## 安装

在 Host 里只填 Key。默认钉 `v0.4.0`；要跟最新提交，把参数改成 `#main`。

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

完整模板：

- Cursor：[`examples/mcp.cursor.json`](examples/mcp.cursor.json)
- Claude Code：[`examples/mcp.claude-code.json`](examples/mcp.claude-code.json)
- Codex：[`examples/mcp.codex.toml`](examples/mcp.codex.toml)

本机 Host 配置不要提交。首次 `npx` 会下载并 build，需要网络。

推送前可先用本机开发入口：`npm install` 后 `npm run build`，把 `command` 换成 `node`，`args` 换成本机 `dist/index.js`。

配好后用一个很小的 MP4 或公开 HTTPS 调用一次 `analyze_video`。没有单独的测试连接工具。

本仓库开发用的 `text/*.key` 启动脚本不是产品安装方式。

## 本地开发

```powershell
cd qwen-omni-mcp
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

真实 API 测试会花钱。只有明确授权且已注入 key 后才运行：

```powershell
$env:LIVE = "1"
$env:QWEN_LIVE_VIDEO = "C:\path\to\small-av.mp4"
npm run test:live
```

不要把 key、`.env` 或视频复制进仓库。`text/` 下的 fixture 和密钥保持在仓库外。

## 行为与限制

- 本地默认上限 1024 MiB，且不超过当场上传政策。可把 `QWEN_MAX_LOCAL_VIDEO_MB` 收紧到更小。
- 未超上限就直接流式上传。上传超时或凭证过期时，不要重传原文件，改用公开 HTTPS。
- 走授权 FileHandle + 流式临时上传，不走整文件 Base64。
- 临时对象在 DashScope **北京区**，约 **48 小时**后自动删除。按单用户、非高并发定位。
- 上传凭证实测约 300 秒有效。1 GiB 大约需要 28 Mbit/s 的持续上行。
- 远程输入只接受 HTTPS。Server 不代为下载。
- 同一进程同时只处理一个视频任务。
- 工具只读这次传入的路径，不扫描磁盘。
- Windows 同账户下仍有 TOCTOU 残余风险，实现已缓解，未消除。
- 未做生产 OSS、未发布 npm、未做 Windows exe。
- 许多 MCP Host 默认工具超时约 60 秒。大文件需要把 Host 超时调长。

内部模型是 `qwen3.5-omni-flash`，不出现在 Tool schema 里。

## 许可

MIT
