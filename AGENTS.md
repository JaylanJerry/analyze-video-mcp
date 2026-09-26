# AGENTS.md — Rules for AI agents working on this repo

> **更名发布（2026-09-26）：** `media-analysis-mcp@2.0.0` 已在官方 npm 发布，展示名为 **Media Analysis MCP**；registry 全新安装与 stdio 握手通过，Trusted Publisher 已绑定新仓库。GitHub tag/Release 收尾待发布流程修正合并。历史 `analyze-video-mcp@1.0.0` 保留；下文 1.0.0 验收仅为原包基线。进度见 [发布记录](tasks/release-2.0.0.md)。

> **2026-09-26 正式发布更新：** `1.0.0` 已通过 Node 24 远程 CI 与 Secret Scan，并经 Trusted Publishing 发布；官方 npm 的 `latest` 为 `1.0.0`，registry 全新安装/stdio 握手与关键构建哈希核对通过。当前安装示例为 1.0.0 / MEDIA_*；下文旧日期状态仅为历史记录。完整证据见 [`tasks/release-1.0.0.md`](tasks/release-1.0.0.md)。

Hard rules. Follow exactly. These exist to keep agents from shipping broken or leaky code.

实现与规格在仓库根。先读 `DEVELOPMENT_HANDOFF.md`，再改代码。

## Secrets (highest priority)

- **Never commit secrets, API keys, tokens, or `.env` files.** Keys live only in `.env` (gitignored) or environment variables.
- **Never hardcode a key in source, tests, configs, or docs.** Read it from `DASHSCOPE_API_KEY` via `src/config.ts`.
- **Never paste a real key into a fixture.** Tests use dummy values (`sk-test`, `sk-secret-key-…`). The pre-commit `check-secrets.mjs` blocks `sk-ws-…` (real Bailian keys); don't try to evade it.
- Do not read, copy, print, or commit `text/` secrets or any `*.key` / `.env`.
- If you accidentally stage a secret: unstage it, rotate the key immediately, and tell the maintainer.

## Git hooks — never bypass

- **Never use `git commit --no-verify` or `git push --no-verify`.** Hooks run secret scan, lint, format, type-check, and tests for a reason.
- If a hook fails, fix the cause. Do not work around it.
- After first clone: run `npm install` (the `prepare` script installs husky hooks). Verify with `git config core.hooksPath` → `.husky`.

## Quality gates — all must pass before push

Run these locally before considering work done:

```bash
npm run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm run lint        # eslint, typescript-eslint strictTypeChecked, --max-warnings 0
npm run format:check
npm test            # vitest, unit + mocked e2e (live tests auto-skip without LIVE=1)
npm run build       # tsc -p tsconfig.build.json -> dist/
```

Version 1.0.0 formally supports Node 24.x only; its blocking CI, release, install and smoke workflows run on Node 24. Node 24 remote CI passed for release commit d6e662a; rerun it for future changes. The published npm `0.6.1` keeps its historical Node `>=22` declaration. Local green ≠ CI green if you skip a step.

## Scope

- 当前正式版本为 **1.0.0**，按 [媒体网关规格](docs/SPEC_MEDIA_GATEWAY.md) 与 [ADR 0024](docs/decisions/0024-agent-directed-media-gateway.md) 实现唯一入口 `analyze_media(media, prompt)`。本地 MP4/MOV/MP3 + 公开 HTTPS 视频；Agent 决定问题，服务端不补提纲、不强制证据 JSON、不自动二次请求。
- 本地授权只使用 `MEDIA_ALLOWED_ROOTS` / `MEDIA_ALLOW_ANY_LOCAL_FILE`。历史 0.6.1 使用 `analyze_video(video, question?)` 与旧 `QWEN_*` 授权变量；迁移说明见 API 契约，不恢复旧接口或已删除的报告/FFmpeg 层。
- 当前任务入口见 [tasks/README.md](tasks/README.md)，验证与正式发布证据见 [发布记录](tasks/release-1.0.0.md)。归档中的旧状态不作为当前工作指令。
- 2.0.0 发布后的安装钉 `npx -y --prefer-offline media-analysis-mcp@2.0.0`；GitHub 回退钉 `#v2.0.0`，npm 12 需 `--allow-git=all`。默认值与本地上限只有在规格批准后才能改。
- 不增加生产依赖。推送、创建/合并 PR、发布须用户明确授权。已授权的 `v*` tag 由 [release.yml](.github/workflows/release.yml) 经 npm Trusted Publishing 发布（[ADR 0014](docs/decisions/0014-npm-trusted-publishing.md)）；不要自行本机 `npm publish`，不要添加 `NPM_TOKEN`。
- 私人 live fixture 留在 `text/`，不复制进仓库。CI Live Smoke 用 `test/fixtures/live-av.mp4`；付费 live test 只有用户明确授权且已注入 `DASHSCOPE_API_KEY` 后才能跑。
- 专项 Tool 表面以 ADR 0001 和 `docs/API_CONTRACT.md` 为准，不为迁就上游五 Tool 测试而保留旧接口。

## Code standards

- **TypeScript strict.** No `any` in `src/` (allowed sparingly in `test/` for fixture typing). No `@ts-ignore`. No non-null assertions in `src/`.
- Prefer narrow types and `unknown` over `any` when parsing external JSON (see `src/bailian.ts`).
- The DashScope video payload builder (`buildVideoPayload`) is intentionally injectable — if the `video_url` content block shape changes, change it in one place (`contentBlock` in `src/bailian.ts`).
- Do not add a new runtime, language, or heavy dependency without explicit maintainer approval.
- Match existing style; let `prettier` and `eslint --fix` handle formatting.

## Tool surface

This specialized fork exposes exactly one MCP tool. In released 1.0.0 it is `analyze_media(media, prompt)` with `prompt` required; the published `0.6.1` still exposes `analyze_video(video, question?)`. See ADR 0001, ADR 0009, ADR 0024, and `docs/API_CONTRACT.md`. Do not restore the upstream five-tool surface, do not keep both names as permanent aliases, and do not add `max_tokens`, `thinking_budget`, `video_url`, provider, or model fields to the public schema.

Agent-facing errors must stay redacted. There are tests asserting no key, path, or `oss://` leaks — keep them passing.

## Backend

- Endpoint: Bailian (DashScope) OpenAI-compatible mode, `${DASHSCOPE_BASE_URL}/chat/completions` (default `https://dashscope.aliyuncs.com/compatible-mode/v1`).
- Model: default `qwen3.8-omni-flash`, overridable with env `QWEN_MODEL` (not a Tool field). `qwen3.5-omni-plus` is the previous generation and still selectable. Video requests must jointly read picture and embedded audio; MP3 requests use `input_audio`. Do not add client-side frame or audio extraction (the MP3 frame-header probe in `src/mpeg-audio.ts` only validates the file, it does not decode audio).
- Requests use `stream: true`, `modalities: ["text"]`, and `stream_options.include_usage`. Do not send Thinking or audio-output parameters.
- Local files are authorized FileHandles streamed to Beijing temporary upload (48h). Same file + same model + same upload endpoint + same credential fingerprint may reuse the `oss://` URL for ~47h across process restarts (disk cache; `QWEN_UPLOAD_CACHE=off` disables). The cache key includes a one-way fingerprint of the API key so a cached object is never reused across Bailian accounts; the key itself is never stored. Do not Base64 whole media. Unset `MEDIA_ALLOWED_ROOTS` refuses local files (legacy `QWEN_ALLOWED_ROOTS` grants nothing).
- The Anthropic-compatible `/apps/anthropic` endpoint does NOT support video input. Do not switch to it.

## Testing

- Unit + mocked e2e use **msw** to mock `fetch` — no real API calls, no cost. Keep it that way.
- Live tests (`test/live.test.ts`) run only with `LIVE=1` and a real `DASHSCOPE_API_KEY`. They hit the real API and cost tokens. Run locally to verify behavior; never make them part of the default `npm test`.
- Every new tool or branch of logic gets a test. Coverage threshold is 85%.
- Synthetic media fixtures only: MP4/MOV boxes from `test/mp4-fixtures.ts`, MPEG audio frames from `test/mp3-fixtures.ts`. Never add private media, and never require FFmpeg for the default suite.

## Filesystem

- Delete files with `trash`, never `rm` (per global policy).
- `ref/` is vendored reference material — read-only, do not modify, do not import from.

## Fragile assumptions (verify before relying on)

1. `video_url` 与 MP3 `input_audio` 的真实百炼及宿主调用证据见 [Provider 协议](docs/PROVIDER_PROTOCOL.md) 与 [Codex 验收记录](tasks/archive/1.0/codex-acceptance-20260926.md)。MOV/MP3 在 Codex 重启后的新 MCP 进程调用已验证；宿主拖入与长结果交付细节以验收记录为准。模型回答符合样本，不证明内部模态路径，也不保证段数和时间码正确。费用账单仍未知。
   - 只有音频轨的 MP4 曾经通过 `video_url` 收到 HTTP 400，原因未定位；不要自动转码，也不要把所有 400 归为内容检查。
   - `MEDIA_MODEL_UNSUPPORTED` 分类目前有 mock 证据，尚无真实命中样本；不能用 token 数判断是否读取媒体。协议形态变化必须先取证，再在 `src/bailian.ts` 的 payload 构建边界提出修正。
2. The default model id string is `qwen3.8-omni-flash`. `QWEN_MODEL` may point at another DashScope id that accepts the same `video_url`/`input_audio` protocol; VL-only models will not hear embedded audio, and audio-input support is not guaranteed across ids. Verify against the Bailian model list if a call returns a model-not-found error. Thinking is on by default for this model: reasoning may arrive as a separate `reasoning_content` field or wrapped in `<think>` inside `content` — `src/sse.ts` drops both and fails with `parse_reason=reasoning_only` when only reasoning arrived.
3. Local MP4/MOV files are streamed to Beijing temporary upload (48h). Accepted containers are `.mp4` and `.mov` (ISO BMFF `ftyp`); video codecs `avc1`/`avc3`/`hvc1`/`hev1` and audio `mp4a` only. Local `.mp3` is accepted only when a bounded probe finds real MPEG Layer III frames (`src/mpeg-audio.ts`) — an ID3-only or renamed text file is refused, and MP3 duration is reported only when the stream declares a Xing/Info/VBRI frame count — no bitrate estimation, because sampling cannot prove a whole file is constant bitrate and a wrong number would drive the one-hour gate. The server never transcodes — no FFmpeg dependency and no runtime beyond Node. Do not Base64 whole media. Authorization is extension + content probe + size + required allowed-root containment + duration probe (`resolveMedia` in `src/media.ts`). Unset roots → `MEDIA_PATH_NOT_ALLOWED`. Duration **greater than** 3600 seconds is `MEDIA_TOO_LONG`; exactly 3600 is allowed; unknown duration is allowed and must never be guessed. HTTPS is not probed, and a remote `.mp3` URL is refused (`UNSUPPORTED_MEDIA`, `input_kind=remote_audio`) instead of being treated as verified remote audio.
4. Production `analyzeMedia` always sends `stream: true`, `modalities: ["text"]`, and `stream_options.include_usage`, and adds `X-DashScope-OssResourceResolve: enable` for uploaded `oss://` inputs (video and audio alike). It never sends a business analysis outline: the only server-side wording is the fixed `PROTOCOL_NOTE`.
5. The default `dashscope.aliyuncs.com/compatible-mode/v1` endpoint is documented to serve `qwen3.8-omni-flash` and the `qwen3.5-omni-*` ids. Business-space MaaS URLs (`https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`) exist but are not required. API keys are region-bound: a key from another region returns 401.
6. MCP server `instructions` (returned in `initialize`) are surfaced to the model by Claude Code (loaded at session start, truncated at 2KB) and pi (leading ~150 chars in the mcp tool description). Some hosts (e.g. Claude.ai web) ignore them — tool descriptions carry the same guidance as a fallback. Keep both layers in sync when the guidance changes.
