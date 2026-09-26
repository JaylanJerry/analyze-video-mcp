# analyze-video-mcp

[![CI](https://github.com/JaylanJerry/analyze-video-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JaylanJerry/analyze-video-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/analyze-video-mcp)](https://www.npmjs.com/package/analyze-video-mcp)
[![License: MIT](https://img.shields.io/github/license/JaylanJerry/analyze-video-mcp)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-24.x-339933)](https://nodejs.org)

> **1.0.0 media gateway:** installation below requires this version to be available on npm. Publication and remote CI are tracked in [`tasks/release-1.0.0.md`](tasks/release-1.0.0.md). The previously published `0.6.1` exposes `analyze_video(video, question?)`; it retains its original Node `>=22` metadata.

MCP media gateway for local agents: submit an MP4/MOV video, MP3 audio, or public HTTPS video URL, and ask the media model a question. The Agent decides what to ask and how to present the answer.

本地 Agent 的媒体分析入口：上传视频或音频，由 Agent 向媒体模型提问。服务端不补写分析提纲、不强制证据 JSON、不自动发起纠错分析。

## Requirements

- **Node.js 24.x**. Other Node major versions are not formally supported.
- An Alibaba Cloud Bailian API key (`DASHSCOPE_API_KEY`). Requests can incur provider charges.
- An MCP client such as Cursor, Claude Code, Claude Desktop, Codex or VS Code.

## Getting started

1. Create a key in the [Bailian console](https://bailian.console.aliyun.com/).
2. Add the config below to your MCP client. Set `MEDIA_ALLOWED_ROOTS` to an existing folder containing media you permit the Agent to upload.
3. Restart or reload MCP servers. In Codex, start a new chat after changing the server configuration.
4. Explicitly ask for MCP analysis of a small MP4, MOV or MP3 inside the allowed folder, and state what you want to know.

Do not commit a config containing a real key. Local media is uploaded in full to Bailian's Beijing temporary storage on a cache miss (objects expire after about 48 hours).

### Standard config

```json
{
  "mcpServers": {
    "analyze_video_mcp": {
      "command": "npx",
      "args": ["-y", "--prefer-offline", "analyze-video-mcp@1.0.0"],
      "env": {
        "DASHSCOPE_API_KEY": "YOUR_DASHSCOPE_API_KEY",
        "QWEN_MODEL": "qwen3.8-omni-flash",
        "MEDIA_ALLOWED_ROOTS": "C:\\Users\\用户名\\Videos"
      }
    }
  }
}
```

Names are separate: package/CLI/server name `analyze-video-mcp`; example Host config key `analyze_video_mcp`; the only Tool is `analyze_media`. The Host key may be renamed.

Templates: [`Cursor`](examples/mcp.cursor.json), [`Claude Code/Desktop`](examples/mcp.claude-code.json), [`Codex`](examples/mcp.codex.toml).

### Cursor and Claude Desktop

Use the standard config in Cursor's `~/.cursor/mcp.json`, or Claude Desktop's `claude_desktop_config.json`.

On Windows, if the host cannot find `npx`, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "--prefer-offline", "analyze-video-mcp@1.0.0"]`.

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=analyze_video_mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi0tcHJlZmVyLW9mZmxpbmUiLCJhbmFseXplLXZpZGVvLW1jcEAxLjAuMCJdLCJlbnYiOnsiREFTSFNDT1BFX0FQSV9LRVkiOiJZT1VSX0RBU0hTQ09QRV9BUElfS0VZIiwiUVdFTl9NT0RFTCI6InF3ZW4zLjgtb21uaS1mbGFzaCIsIk1FRElBX0FMTE9XRURfUk9PVFMiOiJDOlxcVXNlcnNcXOeUqOaIt+WQjVxcVmlkZW9zIn19)

### Claude Code

```bash
claude mcp add --env DASHSCOPE_API_KEY=YOUR_DASHSCOPE_API_KEY --env QWEN_MODEL=qwen3.8-omni-flash --env MEDIA_ALLOWED_ROOTS="C:\Users\用户名\Videos" --transport stdio analyze_video_mcp -- npx -y --prefer-offline analyze-video-mcp@1.0.0
```

On native Windows, add `cmd /c` before `npx` if required by the host.

### Codex

Use [`examples/mcp.codex.toml`](examples/mcp.codex.toml). Set `startup_timeout_sec = 120` and `tool_timeout_sec = 1200`; put the Key and allowed roots in the MCP `env` table because Codex may not inherit user/system environment variables. Start a new chat after installation.

```powershell
codex mcp list
codex mcp get analyze_video_mcp
```

### VS Code

Use the standard server entry under `servers` instead of `mcpServers` in `.vscode/mcp.json` or the user MCP configuration.

## Tool

```text
analyze_media(media, prompt)
```

| Field    | Required | Description                                                                             |
| -------- | -------- | --------------------------------------------------------------------------------------- |
| `media`  | yes      | Absolute local MP4/MOV/MP3 path, or public HTTPS video URL without embedded credentials |
| `prompt` | yes      | The Agent's question; 1–8000 characters after trimming surrounding whitespace           |

The prompt's internal whitespace and wording are retained. The server adds only a fixed protocol note requesting text and honest uncertainty. It does not prescribe a timeline, shot list, critique or output structure. Empty and oversized questions are rejected.

```text
请用 MCP 分析 C:\Videos\clip.mov，描述画面和内嵌声音；无法确认时明确说明。
```

Results contain one text answer plus `structuredContent.answer`, `media`, `request`, optional `usage`, and `limitations`. Media facts are populated only when established locally. A matching answer does not prove the model's internal modality path or the accuracy of its timestamps.

The Agent should read only one copy of the answer. For long results, save the tool result and read it in chunks if the host display truncates it; do not call paid analysis again merely because display output was truncated.

There is no evidence correction request. Before any answer text arrives, transient failures may receive one bounded retry (configurable). Known content-inspection rejections are not automatically retried. Only one analysis is active per process.

Internal upload URLs, credential-shaped tokens and local absolute paths are redacted. The exact local input path is hidden in the answer, while public HTTP(S) links are preserved. Generic redaction of other paths has declared limits; see [`SECURITY.md`](docs/SECURITY.md).

## Environment

| Variable                     | Purpose                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DASHSCOPE_API_KEY`          | Required Bailian Key. Resolved from explicit config, MCP/process env, user config, then supported Windows user env lookup. Never printed.                                       |
| `MEDIA_ALLOWED_ROOTS`        | Existing absolute allowed folders; separate with the platform delimiter (`;` on Windows). Unset means all local files are refused.                                              |
| `MEDIA_ALLOW_ANY_LOCAL_FILE` | Default `off`. `on` permits any absolute local media path the Agent names, including files outside allowed roots. Enable only if you accept mistaken or prompt-induced uploads. |
| `MEDIA_MAX_LOCAL_MEDIA_MB`   | Local size limit; default and maximum 1024 MiB.                                                                                                                                 |
| `QWEN_MODEL`                 | Model id; default `qwen3.8-omni-flash`. Video/audio support varies by model. `qwen3.5-omni-plus` remains selectable. Not a Tool field.                                          |
| `QWEN_CONFIG_FILE`           | Optional config file path (same format as `--config`); the server does not implicitly load the cwd `.env`.                                                                      |
| `QWEN_MCP_SERVER_NAME`       | MCP server name; does not change Tool name.                                                                                                                                     |
| `QWEN_UPLOAD_CACHE`          | Default on; `off` disables temporary-upload reuse.                                                                                                                              |
| `DASHSCOPE_BASE_URL`         | Default Beijing OpenAI-compatible endpoint. Key region must match.                                                                                                              |
| `DASHSCOPE_UPLOAD_URL`       | Default Beijing temporary upload endpoint.                                                                                                                                      |

Use `analyze-video-mcp --doctor --json` to inspect configuration, variable sources and obsolete names without printing the Key. A missing Key permits MCP initialization but analysis returns `CONFIG_MISSING`.

## Limits

- Local inputs: **MP4/MOV** (ISO BMFF) with H.264/H.265 video and AAC audio; **MP3** with real MPEG Layer III frames. Renaming an MP4 to `.mp3` does not convert it and is refused.
- An audio-only MP4 has been refused by the provider through the video path. Export genuine MP3 for standalone audio. The server never transcodes, extracts frames, decodes audio or installs FFmpeg.
- Known local durations greater than **3600 seconds** are refused; exactly 3600 is allowed. Unknown duration is allowed. MP3 duration is reported only from declared Xing/Info/VBRI frame counts, with no bitrate estimate.
- HTTPS inputs are fetched by the provider; the server does not download or probe their content/duration. Remote `.mp3` URLs are refused.
- Media understanding is sampled, not frame-accurate or a verified transcript. Use a 5–30 second excerpt for precise timing questions; shot counts, dialogue and timestamps still require independent checking.
- Cache entries include file identity, a size/head/tail fingerprint, model, upload endpoint and credential fingerprint, and expire after about 47 hours. Changing only the middle while preserving identity/head/tail can reuse stale media; this is an accepted limitation. Disable cache if that matters.
- Images, downloads from video sites, automatic conversion, batch analysis, cross-call conversation memory and deterministic loudness/edit checks are outside scope.

## Migrating from 0.6.1

This is a breaking release. Existing configs do not silently gain MP3 access.

| Published 0.6.1                      | 1.0.0                                            |
| ------------------------------------ | ------------------------------------------------ |
| `analyze_video(video, question?)`    | `analyze_media(media, prompt)`; prompt required  |
| Optional question and server outline | Agent supplies the question; no business outline |
| Evidence JSON and correction request | Plain answer with media facts and limitations    |
| Local MP4/MOV                        | Local MP4/MOV/MP3                                |
| `QWEN_ALLOWED_ROOTS`                 | `MEDIA_ALLOWED_ROOTS`                            |
| `QWEN_ALLOW_ANY_LOCAL_VIDEO`         | `MEDIA_ALLOW_ANY_LOCAL_FILE` (off by default)    |
| `QWEN_MAX_LOCAL_VIDEO_MB`            | `MEDIA_MAX_LOCAL_MEDIA_MB`                       |
| `QWEN_AUDIO_SILENCE_CHECK`           | Removed                                          |
| Node `>=22` declaration              | Formal support only for Node 24.x                |

Old authorization variables grant nothing. Reload the MCP server after changing the version and variables. Full contract: [`API_CONTRACT.md`](docs/API_CONTRACT.md).

## Development and release

```powershell
npm install
npm run typecheck
npm run lint
npm run format:check
npm test
npm run coverage
npm run build
npm run test:pack-install
```

Default tests are mocked and free. Live tests require explicit authorization and a real Key; they are not part of the default suite.

After remote Node 24 CI passes, pushing an authorized version tag matching `package.json` and `src/version.ts` runs [`release.yml`](.github/workflows/release.yml): package/install probes, npm Trusted Publishing (OIDC), then GitHub Release. No `NPM_TOKEN` is used. See [ADR 0014](docs/decisions/0014-npm-trusted-publishing.md).

GitHub fallback after release:

```text
npx -y --allow-git=all github:JaylanJerry/analyze-video-mcp#v1.0.0
```

npm 12 requires `--allow-git=all`. Do not use this tag until it exists.

## License

MIT. Specialized fork of [`sommio/qwen-omni-mcp`](https://github.com/sommio/qwen-omni-mcp).
