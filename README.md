# analyze-video-mcp

[![CI](https://github.com/JaylanJerry/analyze-video-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JaylanJerry/analyze-video-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/JaylanJerry/analyze-video-mcp)](https://github.com/JaylanJerry/analyze-video-mcp/releases/latest)
[![License: MIT](https://img.shields.io/github/license/JaylanJerry/analyze-video-mcp)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933)](https://nodejs.org)

Give Cursor, Claude Code, and Codex **video understanding**: the model reads picture and embedded audio together, then answers in text.

给本地 Agent 增加视频理解：同时看画面、听视频里的音轨，只返回文本。

One MCP tool. Install with `npx` and your own [Alibaba Cloud Bailian](https://bailian.console.aliyun.com/) `DASHSCOPE_API_KEY`.

公开工具只有 `analyze_video`。填自己的百炼 Key 即可使用。

## Install

Requires **Node.js 22+**. npm 12 (the default on current Node 22/24) blocks git packages unless you pass `--allow-git=all`.

Get a key: [Bailian console](https://bailian.console.aliyun.com/) → API-KEY. It looks like `sk-…`. Put it in the MCP `env`, not in the repo.

Cursor / Claude Code:

```json
{
  "mcpServers": {
    "analyze-video": {
      "command": "npx",
      "args": ["-y", "--allow-git=all", "github:JaylanJerry/analyze-video-mcp#v0.5.0"],
      "env": {
        "DASHSCOPE_API_KEY": "paste-your-key-here"
      }
    }
  }
}
```

Without `--allow-git=all`, npm 12 fails with `EALLOWGIT`. To follow `main` instead of the release, change the spec to `#main`.

Codex: [`examples/mcp.codex.toml`](examples/mcp.codex.toml). Other templates: [`examples/mcp.cursor.json`](examples/mcp.cursor.json), [`examples/mcp.claude-code.json`](examples/mcp.claude-code.json).

The first `npx` download builds from source and needs network. Do not commit a Host config that contains a real key.

If `npx` is not an option, clone `v0.5.0`, run `npm install` and `npm run build`, then point the Host at `node` + `dist/index.js`.

Then ask the agent to analyze a **small** local MP4 (or a public `https://` URL). There is no separate health tool; `npx … --version` prints the package version without calling Bailian. If the server never starts, read stderr — a missing key names `DASHSCOPE_API_KEY` instead of a generic analysis failure.

装好后对 Agent 说「分析这个视频」，并带上本地绝对路径或公开链接。用一个很小的 MP4 先试一次。

## Tool

```text
analyze_video(video, question?)
```

| Field      | Required | Description                                               |
| ---------- | -------- | --------------------------------------------------------- |
| `video`    | yes      | Absolute local MP4 path, or a public HTTPS URL            |
| `question` | no       | Defaults to what happened on screen and in the soundtrack |

If the user is specific, the agent should copy that into `question`. If they only say “analyze this”, turn it into concrete picture-and-sound questions first.

`QWEN_ALLOWED_ROOTS` is optional but recommended: it limits which local folders the server may read. When unset, the server does not scan the disk, but it will read any valid absolute MP4 the caller passes.

## Limits

- One video per call, up to **1 hour**. Local files are also capped at 1024 MiB and by live Bailian policy.
- Bigger or slow-to-upload files: host them on public HTTPS and pass the URL. Do not retry the same large local upload.
- One in-flight analysis per process.
- Some hosts time out around 60 seconds; raise that for large files.
- Images and standalone audio are not tools yet.

## Development

Install and contract details: [`docs/SPEC_INSTALL.md`](docs/SPEC_INSTALL.md), [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md). Index: [`docs/README.md`](docs/README.md).

```powershell
npm install
npm test
npm run build
```

## License

MIT. Specialized fork of [`sommio/qwen-omni-mcp`](https://github.com/sommio/qwen-omni-mcp).
