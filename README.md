# analyze-video-mcp

[![CI](https://github.com/JaylanJerry/analyze-video-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JaylanJerry/analyze-video-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/analyze-video-mcp)](https://www.npmjs.com/package/analyze-video-mcp)
[![Release](https://img.shields.io/github/v/release/JaylanJerry/analyze-video-mcp)](https://github.com/JaylanJerry/analyze-video-mcp/releases/latest)
[![License: MIT](https://img.shields.io/github/license/JaylanJerry/analyze-video-mcp)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933)](https://nodejs.org)

MCP server that gives local agents **video understanding**: the model reads picture and embedded audio together, then answers in text. One tool: `analyze_video`.

给本地 Agent 增加视频理解：同时看画面、听视频里的音轨，只返回文本。把下面的标准配置贴进 MCP 客户端，填入百炼 Key。

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=mcp_analyze_video&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImFuYWx5emUtdmlkZW8tbWNwIl0sImVudiI6eyJEQVNIU0NPUEVfQVBJX0tFWSI6IllPVVJfREFTSFNDT1BFX0FQSV9LRVkifX0=)

## Requirements

- Node.js 22+
- An [Alibaba Cloud Bailian](https://bailian.console.aliyun.com/) API key (`DASHSCOPE_API_KEY`)
- Any MCP client (Cursor, Claude Code, Claude Desktop, Codex, VS Code, …)

## Getting started

1. Create a key in the [Bailian console](https://bailian.console.aliyun.com/) → API-KEY. It looks like `sk-…`.
2. Add the **standard config** below to your MCP client.
3. Restart the client (or reload MCP servers).
4. Ask the agent to analyze a **small** local MP4 (absolute path) or a public `https://` URL.

Do not commit a config file that contains a real key.

### Standard config

Works in Cursor, Claude Desktop, and most `mcpServers` clients:

```json
{
  "mcpServers": {
    "mcp_analyze_video": {
      "command": "npx",
      "args": ["-y", "analyze-video-mcp"],
      "env": {
        "DASHSCOPE_API_KEY": "YOUR_DASHSCOPE_API_KEY"
      }
    }
  }
}
```

The Host config key (`mcp_analyze_video` in the examples) is yours to rename. The tool name stays `analyze_video`.

Copy-paste templates: [`examples/mcp.cursor.json`](examples/mcp.cursor.json), [`examples/mcp.claude-code.json`](examples/mcp.claude-code.json), [`examples/mcp.codex.toml`](examples/mcp.codex.toml).

### Cursor

Use the install button above, or put the standard config in `~/.cursor/mcp.json` (Windows: `%USERPROFILE%\.cursor\mcp.json`). Project-level: `.cursor/mcp.json`.

### Claude Code

```bash
claude mcp add --env DASHSCOPE_API_KEY=YOUR_DASHSCOPE_API_KEY --transport stdio mcp_analyze_video -- npx -y analyze-video-mcp
```

On native Windows, wrap `npx` if the server fails to start:

```bash
claude mcp add --env DASHSCOPE_API_KEY=YOUR_DASHSCOPE_API_KEY --transport stdio mcp_analyze_video -- cmd /c npx -y analyze-video-mcp
```

### Claude Desktop

Add the standard config to `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

If Windows cannot find `npx`, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "analyze-video-mcp"]`.

### Codex

See [`examples/mcp.codex.toml`](examples/mcp.codex.toml).

### VS Code

User settings → **MCP: Open User Configuration**, or workspace `.vscode/mcp.json`:

```json
{
  "servers": {
    "mcp_analyze_video": {
      "command": "npx",
      "args": ["-y", "analyze-video-mcp"],
      "env": {
        "DASHSCOPE_API_KEY": "YOUR_DASHSCOPE_API_KEY"
      }
    }
  }
}
```

## Tools

```text
analyze_video(video, question?)
```

| Field      | Required | Description                                               |
| ---------- | -------- | --------------------------------------------------------- |
| `video`    | yes      | Absolute local MP4 path, or a public HTTPS URL            |
| `question` | no       | Defaults to what happened on screen and in the soundtrack |

If the user is specific, copy that into `question`. If they only say “analyze this”, turn it into concrete picture-and-sound questions first.

Example:

```text
Analyze this video: C:\Videos\clip.mp4
What happens on screen, and what does the soundtrack say?
```

## Environment

| Variable               | Required | Description                                                                                                                                                        |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DASHSCOPE_API_KEY`    | yes      | Bailian API key                                                                                                                                                    |
| `QWEN_MODEL`           | no       | DashScope video model id. Default `qwen3.5-omni-flash`. Must accept `video_url` plus embedded audio. Not a Tool field; VL-only models will not hear the soundtrack |
| `QWEN_MCP_SERVER_NAME` | no       | MCP `initialize.name`. Default `analyze-video-mcp`. Does not change the tool name `analyze_video`                                                                  |
| `QWEN_ALLOWED_ROOTS`   | no       | Optional folder allowlist for local files. Unset: the server does not scan the disk, but will read any valid absolute MP4 the caller passes                        |
| `DASHSCOPE_BASE_URL`   | no       | Default: Beijing compatible-mode endpoint                                                                                                                          |
| `DASHSCOPE_UPLOAD_URL` | no       | Default: Beijing temporary upload                                                                                                                                  |

## Limits

- This is **sampled understanding**, not frame-accurate editorial timing. Shot lists and timestamps can miss cuts or invert ranges; use `ffmpeg` (or similar) when you need objective cut points or silence.
- One video per call, up to **1 hour**. Local files are also capped at 1024 MiB and by live Bailian policy.
- Local files upload in full on a cache miss. The same file + same `QWEN_MODEL` in this process reuses the temporary object for about 47 hours. Bigger or slow-to-upload files: host them on public HTTPS and pass the URL. Do not retry the same large local upload after a failed transfer.
- One in-flight analysis per process. Some hosts time out around 60 seconds; raise that for large files.
- Images and standalone audio are not tools yet.

`npx analyze-video-mcp --version` prints the version without calling Bailian. If the server never starts, read stderr — a missing key names `DASHSCOPE_API_KEY`.

## Development

Install and contract details: [`docs/SPEC_INSTALL.md`](docs/SPEC_INSTALL.md), [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md). Index: [`docs/README.md`](docs/README.md).

```powershell
npm install
npm test
npm run build
```

## Release

Pushing an authorized `v*` tag (must equal `v${package.version}`) runs [`.github/workflows/release.yml`](.github/workflows/release.yml): pack probes, `npm publish`, then a GitHub Release. Authentication is npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC), not a local OTP and not an `NPM_TOKEN` secret.

One-time setup on [the npm package](https://www.npmjs.com/package/analyze-video-mcp) → Settings → Trusted Publisher → GitHub Actions:

| Field                | Value               |
| -------------------- | ------------------- |
| Organization or user | `JaylanJerry`       |
| Repository           | `analyze-video-mcp` |
| Workflow filename    | `release.yml`       |
| Allowed actions      | `npm publish`       |

Do not publish on every `main` push. Do not retag a version that is already on npm.

## Install from GitHub

If you cannot use the npm registry:

```text
npx -y --allow-git=all github:JaylanJerry/analyze-video-mcp#v0.5.0
```

npm 12 requires `--allow-git=all`. To follow `main` instead of the release tag, change the spec to `#main`.

## License

MIT. Specialized fork of [`sommio/qwen-omni-mcp`](https://github.com/sommio/qwen-omni-mcp).
