# qwen-omni-mcp

An [MCP](https://modelcontextprotocol.io) server that gives Claude Code and other AI agents **video, image, audio, and audio-video understanding** via [Bailian (DashScope)](https://bailian.console.aliyun.com/) using the multimodal **Qwen3.8-Max** and **Qwen3.5-Omni** models.

Qwen3.8-Max reads video natively — **no client-side frame extraction**. Qwen3.5-Omni adds native **audio** understanding (and audio-track awareness for video). Pass a public media URL **or a local file path**; the model does the rest. The server also ships MCP **instructions** that teach text-only agents to reach for these tools when they need to view/read media — while telling natively multimodal agents to prefer their own vision.

## Highlights

- **Native video understanding** — send a video URL or local file, get grounded analysis
- **Image understanding** — describe, Q&A, OCR; doubles as the "eyes" for text-only agents whose file reader can't display images
- **Audio understanding** — transcribe, summarize, analyze speech/sound (mp3/wav/flac/ogg/m4a/aac)
- **Audio-video understanding** — analyze a video's visuals **and** its sound track together
- **Thinking control** — optional per-call `thinking_budget` on every media tool; omitted = provider default
- **Local file support** — pass a local path; files are sent inline as base64 (25MB guardrail)
- **npx-launchable** — one line in your MCP client config

## Install

No global install needed. Run directly with npx:

```bash
npx -y qwen-omni-mcp
```

For local development:

```bash
git clone <this-repo>
cd qwen-omni-mcp
npm install            # also installs husky git hooks
cp .env.example .env   # fill in DASHSCOPE_API_KEY
npm run dev            # run from source via tsx
```

## Configuration

All config is via environment variables (loaded from `.env` by `dotenv`):

| Variable               | Required | Default                                             | Description                         |
| ---------------------- | -------- | --------------------------------------------------- | ----------------------------------- |
| `DASHSCOPE_API_KEY`    | yes      | —                                                   | Bailian API key                     |
| `QWEN_MODEL`           | no       | `qwen3.8-max`                                       | Model id for video/image analysis   |
| `QWEN_OMNI_MODEL`      | no       | `qwen3.5-omni-plus`                                 | Omni model id for audio/audio-video |
| `DASHSCOPE_BASE_URL`   | no       | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI-compatible endpoint          |
| `QWEN_REQUEST_TIMEOUT` | no       | `300`                                               | Per-request timeout in seconds      |

Get a key at <https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key>.

> The Anthropic-compatible `/apps/anthropic` endpoint does **not** support video input, so this server uses the OpenAI-compatible endpoint.

## Use with Claude Code

Add to your MCP client config:

```json
{
  "mcpServers": {
    "qwen-omni-mcp": {
      "command": "npx",
      "args": ["-y", "qwen-omni-mcp"],
      "env": {
        "DASHSCOPE_API_KEY": "your-key"
      }
    }
  }
}
```

For local development without publishing:

```json
{
  "mcpServers": {
    "qwen-omni-mcp": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "env": { "DASHSCOPE_API_KEY": "your-key" }
    }
  }
}
```

## Tools

| Tool                    | Description                                                           |
| ----------------------- | --------------------------------------------------------------------- |
| `analyze_video`         | Analyze a video (URL or local file) with a custom prompt              |
| `analyze_image`         | Analyze an image (URL or local file) with a custom prompt             |
| `analyze_audio`         | Analyze an audio file (URL or local) with a custom prompt (Omni)      |
| `analyze_audio_video`   | Analyze a video's visuals + sound (URL or local) with a prompt (Omni) |
| `check_endpoint_status` | Show configured endpoint/model (key redacted)                         |

Each media tool accepts a public `http`/`https` URL **or a local file path**. Local files are read and sent inline as base64, with a 25MB guardrail (verified up to a 14MB video / ~18MB body on Qwen3.7-Plus, and an 8.8MB video / ~11.7MB base64 body on Qwen3.5-Omni, both HTTP 200). Files larger than 25MB must be hosted at a public URL instead. Local input is validated by extension + magic-byte signature before encoding, so non-media files are rejected.

Each media tool also accepts an optional `thinking_budget` (positive integer): the maximum tokens the model may spend thinking before answering. Omit it to use the provider default (thinking on at full budget for Qwen3.8 hybrid-thinking models). Thinking tokens are billed but do **not** count against `max_tokens`, which limits the answer itself.

`analyze_audio` / `analyze_audio_video` use the omni model (`QWEN_OMNI_MODEL`, default `qwen3.5-omni-plus`) and force text-only output. Audio is sent as an `input_audio` block in the `data:;base64,<b64>` form with a `format` field (mp3/wav/flac/ogg/m4a/aac).

## Development

```bash
npm run typecheck     # strict tsc
npm run lint          # eslint, --max-warnings 0
npm run format:check  # prettier
npm test              # unit + mocked e2e (no API cost)
npm run build         # emit dist/
LIVE=1 npm run test:live   # real API calls (costs tokens)
```

CI (`.github/workflows/ci.yml`) runs the same gates on Node 20/22. `secrets-scan.yml` runs gitleaks. `smoke-live.yml` (manual / weekly) runs one real image call.

See [AGENTS.md](AGENTS.md) for the full set of agent rules (never bypass hooks, never commit secrets, etc.).

## License

MIT
