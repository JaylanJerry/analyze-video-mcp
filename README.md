# analyze-video-mcp

[![CI](https://github.com/JaylanJerry/analyze-video-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JaylanJerry/analyze-video-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/analyze-video-mcp)](https://www.npmjs.com/package/analyze-video-mcp)
[![Release](https://img.shields.io/github/v/release/JaylanJerry/analyze-video-mcp)](https://github.com/JaylanJerry/analyze-video-mcp/releases/latest)
[![License: MIT](https://img.shields.io/github/license/JaylanJerry/analyze-video-mcp)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933)](https://nodejs.org)

MCP server that gives local agents **video understanding**: the model reads picture and embedded audio together, then answers in text. One tool: `analyze_video`.

给本地 Agent 增加视频理解：同时看画面、听视频里的音轨，只返回文本。把下面的标准配置贴进 MCP 客户端，填入百炼 Key。

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=analyze_video_mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi0tcHJlZmVyLW9mZmxpbmUiLCJhbmFseXplLXZpZGVvLW1jcEAwLjYuMSJdLCJlbnYiOnsiREFTSFNDT1BFX0FQSV9LRVkiOiJZT1VSX0RBU0hTQ09QRV9BUElfS0VZIiwiUVdFTl9NT0RFTCI6InF3ZW4zLjUtb21uaS1wbHVzIiwiUVdFTl9BTExPV0VEX1JPT1RTIjoiQzpcXFxcVXNlcnNcXFxc55So5oi35ZCNXFxcXFZpZGVvcyJ9fQ==)

## Requirements

- Node.js 22+
- An [Alibaba Cloud Bailian](https://bailian.console.aliyun.com/) API key (`DASHSCOPE_API_KEY`)
- Any MCP client (Cursor, Claude Code, Claude Desktop, Codex, VS Code, …)

## Getting started

1. Create a key in the [Bailian console](https://bailian.console.aliyun.com/) → API-KEY. It looks like `sk-…`.
2. Add the **standard config** below to your MCP client.
3. Restart the client (or reload MCP servers).
4. Ask the agent to analyze a **small** local MP4 or MOV (absolute path **inside** `QWEN_ALLOWED_ROOTS`) or a public `https://` URL. Prefer dragging files in from any folder? Turn on `QWEN_ALLOW_ANY_LOCAL_VIDEO` and read its trade-off in the Environment table first.

Do not commit a config file that contains a real key.

### Standard config

Works in Cursor, Claude Desktop, and most `mcpServers` clients:

```json
{
  "mcpServers": {
    "analyze_video_mcp": {
      "command": "npx",
      "args": ["-y", "--prefer-offline", "analyze-video-mcp@0.6.1"],
      "env": {
        "DASHSCOPE_API_KEY": "YOUR_DASHSCOPE_API_KEY",
        "QWEN_MODEL": "qwen3.8-omni-flash",
        "QWEN_ALLOWED_ROOTS": "C:\\Users\\用户名\\Videos"
      }
    }
  }
}
```

Names (do not mix them):

| Layer                                               | Name                |
| --------------------------------------------------- | ------------------- |
| Repository, npm package, CLI, MCP `initialize.name` | `analyze-video-mcp` |
| Host config key                                     | `analyze_video_mcp` |
| Tool                                                | `analyze_video`     |

The Host config key is yours to rename. Changing it does not change the tool name. Old keys (`analyze-video`, `mcp_analyze_video`) still work if already installed.

Copy-paste templates: [`examples/mcp.cursor.json`](examples/mcp.cursor.json), [`examples/mcp.claude-code.json`](examples/mcp.claude-code.json), [`examples/mcp.codex.toml`](examples/mcp.codex.toml).

### Cursor

Use the install button above, or put the standard config in `~/.cursor/mcp.json` (Windows: `%USERPROFILE%\.cursor\mcp.json`). Project-level: `.cursor/mcp.json`.

### Claude Code

```bash
claude mcp add --env DASHSCOPE_API_KEY=YOUR_DASHSCOPE_API_KEY --env QWEN_MODEL=qwen3.8-omni-flash --env QWEN_ALLOWED_ROOTS="C:\Users\用户名\Videos" --transport stdio analyze_video_mcp -- npx -y --prefer-offline analyze-video-mcp@0.6.1
```

On native Windows, wrap `npx` if the server fails to start:

```bash
claude mcp add --env DASHSCOPE_API_KEY=YOUR_DASHSCOPE_API_KEY --env QWEN_MODEL=qwen3.8-omni-flash --env QWEN_ALLOWED_ROOTS="C:\Users\用户名\Videos" --transport stdio analyze_video_mcp -- cmd /c npx -y --prefer-offline analyze-video-mcp@0.6.1
```

### Claude Desktop

Add the standard config to `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

If Windows cannot find `npx`, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "--prefer-offline", "analyze-video-mcp@0.6.1"]`.

### Codex

See [`examples/mcp.codex.toml`](examples/mcp.codex.toml). On Windows Codex, set `startup_timeout_sec = 120` and pin `@0.6.1`. Put `DASHSCOPE_API_KEY` in the MCP `env` block (Codex may not inherit the user/system environment). After adding the server, start a **new** thread; old threads may not remount tools.

```powershell
codex mcp list
codex mcp get analyze_video_mcp
```

### VS Code

User settings → **MCP: Open User Configuration**, or workspace `.vscode/mcp.json`:

```json
{
  "servers": {
    "analyze_video_mcp": {
      "command": "npx",
      "args": ["-y", "--prefer-offline", "analyze-video-mcp@0.6.1"],
      "env": {
        "DASHSCOPE_API_KEY": "YOUR_DASHSCOPE_API_KEY",
        "QWEN_MODEL": "qwen3.8-omni-flash",
        "QWEN_ALLOWED_ROOTS": "C:\\Users\\用户名\\Videos"
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
| `video`    | yes      | Absolute local MP4/MOV path, or a public HTTPS URL        |
| `question` | no       | Defaults to what happened on screen and in the soundtrack |

If the user is specific, copy that into `question`. If they only say “analyze this”, turn it into concrete picture-and-sound questions first.

Vague requests get a structured default from the server: a timeline of segments (skippable for single-scene clips), composition by foreground/subject/background, motion and effects with timing, colour and light, what was actually heard (kept apart from sounds merely implied by the picture) and whether sound matches the action, pacing and mood shifts, evidence-backed pros and cons, likely use cases, and an explicit list of what could not be confirmed. The answer leads and the timestamped observations follow in the text itself, so hosts that ignore `structuredContent` still see per-segment evidence. Specific questions (time codes, “only check …”) are passed through untouched, and nothing claims frame-by-frame or full-transcript verification.

The tool asks the Agent to call it **only when the user explicitly asks for MCP analysis**; ordinary video work (editing, transcoding, screenshots, spotting frames, writing copy) should go through the host's own flow. That wording lives in the server instructions and the tool description, i.e. it steers the Agent — it is not enforcement. What actually bounds the tool is the server-side validation and your install config (allowed roots, `QWEN_ALLOW_ANY_LOCAL_VIDEO` off by default, the host's tool visibility and approval mode).

Example:

```text
Analyze this video: C:\Videos\clip.mp4
What happens on screen, and what does the soundtrack say?
```

## Environment

| Variable                     | Required        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DASHSCOPE_API_KEY`          | yes             | Bailian API key. Resolved from `--config` / `QWEN_CONFIG_FILE`, then MCP/`process.env`, then `~/.analyze-video-mcp/config.env`, then Windows user env                                                                                                                                                                                                                                                                                           |
| `QWEN_CONFIG_FILE`           | no              | Optional env-file path (same format as `--config`). Not a cwd `.env`                                                                                                                                                                                                                                                                                                                                                                            |
| `QWEN_MODEL`                 | no              | DashScope omni model id. Default `qwen3.8-omni-flash`. Any DashScope id that accepts `video_url` **and** reads embedded audio works (`qwen3.5-omni-plus` is the previous generation); VL-only models will not hear the soundtrack. Not a Tool field. The id is part of the upload-cache key, so changing it re-uploads instead of reusing the old object. API keys are region-bound: a key from another region returns `PROVIDER_UNAUTHORIZED`. |
| `QWEN_MCP_SERVER_NAME`       | no              | MCP `initialize.name`. Default `analyze-video-mcp`. Does not change the tool name `analyze_video`                                                                                                                                                                                                                                                                                                                                               |
| `QWEN_ALLOWED_ROOTS`         | for local files | Absolute folder allowlist. Unset: local MP4s are refused; HTTPS still works. Required in the install templates unless `QWEN_ALLOW_ANY_LOCAL_VIDEO` is on. Every entry must exist: a renamed or deleted media folder makes each call fail with `CONFIG_MISSING` (with `QWEN_ALLOW_ANY_LOCAL_VIDEO` on those entries are ignored and reported by `--doctor` instead). Platform path delimiter (`;` on Windows)                                    |
| `QWEN_ALLOW_ANY_LOCAL_VIDEO` | no              | Default `off`. Set `on` to accept **any** absolute local MP4/MOV path the Agent names — no allowed root, no confirmation step (drag the file into the chat and ask). The path alone then counts as authorization, so prompt-injected or mistaken paths can upload local files to Bailian (paid, third party); only enable it on an install where you accept that. See [ADR 0021](docs/decisions/0021-allow-any-local-video-opt-in.md)           |
| `QWEN_UPLOAD_CACHE`          | no              | Default on. Set `off` to disable in-process and on-disk reuse of temporary `oss://` URLs                                                                                                                                                                                                                                                                                                                                                        |
| `DASHSCOPE_BASE_URL`         | no              | Default: Beijing compatible-mode endpoint                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DASHSCOPE_UPLOAD_URL`       | no              | Default: Beijing temporary upload                                                                                                                                                                                                                                                                                                                                                                                                               |

## Limits

- This is **sampled understanding**, not frame-accurate editorial timing. Shot lists and timestamps can miss cuts or invert ranges; for precise transitions pass a **5–30 second clip** (or a public HTTPS URL of that clip). Objective peak/LUFS/black-frame detection is out of scope.
- One video per call, up to **1 hour**. Local files are also capped at 1024 MiB and by live Bailian policy.
- Local files upload in full on a cache miss. The same file + same `QWEN_MODEL` + same upload endpoint reuses the temporary object for about 47 hours (survives MCP restart unless `QWEN_UPLOAD_CACHE=off`). Bigger or slow-to-upload files: host them on public HTTPS and pass the URL. Do not retry the same large local upload after a failed transfer.
- One in-flight analysis per process. Some hosts time out around 60 seconds; Codex templates set `tool_timeout_sec = 1200`.
- Local input containers: **MP4 and MOV** (ISO BMFF, `ftyp` required). Video tracks must be H.264 (`avc1`/`avc3`) or H.265 (`hvc1`/`hev1`); audio tracks must be AAC (`mp4a`). Anything else — ProRes, MPEG-4 Part 2, PCM/ALAC audio — is refused before upload with `UNSUPPORTED_VIDEO_CODEC` naming the codec, because an undecodable audio track would otherwise turn into a misleading "no sound heard" answer.
- The server never transcodes. If you have a MOV or MP4 outside those codecs, remux it yourself first — lossless and fast (no re-encode): `ffmpeg -i input.mov -c copy -movflags +faststart output.mp4`. ffmpeg is **not** a dependency of this package: it is a one-off step you run, and it is not needed for MOV files that already use H.264/AAC.
- Images and standalone audio are not tools yet.

`npx analyze-video-mcp --version` prints the version without calling Bailian. `npx analyze-video-mcp --doctor --json` uses the same config resolver as `analyze_video` and reports whether the key is set **and from which source** — it never prints the key. A missing key no longer prevents MCP initialize; calling the tool returns `CONFIG_MISSING` with the variable name.

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
