# AGENTS.md — Rules for AI agents working on this repo

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

- **下一大版本状态（2026-09-25 起）：** 本工作区分支**已按** [`docs/SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md`](docs/SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md) 与 [ADR 0024](docs/decisions/0024-agent-directed-media-gateway.md) 实现单入口 `analyze_media(media, prompt)`：本地 MP4/MOV/MP3 + 公开 HTTPS 视频，服务端不再补写提纲、不再强制证据 JSON、不再自动二次请求，本地授权改用 `MEDIA_ALLOWED_ROOTS` / `MEDIA_ALLOW_ANY_LOCAL_FILE`；旧报告层（`src/evidence.ts`）、可选 FFmpeg 静音核对（`src/audio-silence.ts`）与 `analyze_video` 已删除。**1.0.0 已正式发布**；历史 npm `analyze-video-mcp@0.6.1` 是 `analyze_video(video, question?)` + `QWEN_*` 授权变量。当前安装指向 1.0.0，必须保留旧版本迁移说明。其它密钥、安全、验证、依赖、付费与发布门禁仍适用。
- 下一大版本的未验证项与验收状态见 [`tasks/todo-next-major-media-gateway.md`](tasks/todo-next-major-media-gateway.md) 与 [`tasks/deepseek-next-major-handoff.md`](tasks/deepseek-next-major-handoff.md)。**MP3 已有真实百炼与宿主夹具调用证据**，详见验收报告；不外推跨模型可用性或模型内部模态路径。
- v1 任务在 `tasks/todo.md`，已收尾。v0.5.0 已发布（[`docs/SPEC_V05.md`](docs/SPEC_V05.md)）。v0.5.2 见 [`docs/SPEC_V052.md`](docs/SPEC_V052.md)。v0.6 见 [`docs/SPEC_V06.md`](docs/SPEC_V06.md)。v0.6.1 见 [`docs/SPEC_V061.md`](docs/SPEC_V061.md)。当前安装钉 `npx -y --prefer-offline analyze-video-mcp@1.0.0`；GitHub 回退钉 `#v1.0.0`，npm 12 需 `--allow-git=all`。
- 已发布的 `0.6.1` 不改变 `analyze_video` 的名称与字段；1.0.0 按 ADR 0024 改为 `analyze_media(media, prompt)`，两者不得长期并列保留。默认值与本地上限只有在规格批准后才能改。
- 不增加生产依赖。不要从本机主动推送或 `npm publish`，除非用户明确要求。已授权的 `v*` tag 由 [`release.yml`](.github/workflows/release.yml) 用 npm Trusted Publishing 发布（见 [ADR 0014](docs/decisions/0014-npm-trusted-publishing.md)）。不要添加 `NPM_TOKEN` secret。
- 私人 live fixture 留在 `text/`，不要复制进仓库。CI Live Smoke 用 `test/fixtures/live-av.mp4`。
- 付费 live test 只有用户明确授权且已注入 `DASHSCOPE_API_KEY` 后才能跑。
- 专项 Tool 表面以 ADR 0001 和 `docs/API_CONTRACT.md` 为准，不要为迁就上游五 Tool 测试而保留旧接口。

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

1. The OpenAI-compatible endpoint accepts a `video_url` content block (verified live on `qwen3.5-omni-flash` in 2026-08; the current default `qwen3.8-omni-flash` is documented to accept it but has no project live verification yet). If a live call rejects it, the fallback is the native DashScope `video` content type. Change `contentBlock()` in `src/bailian.ts`.
   1b. **Verified live (2026-09-25, default region, `qwen3.8-omni-flash`):** the `input_audio` block with an `oss://` temporary URL plus the OSS-resolve header works for local MP3 — a non-private 9 s synthetic sample answered a three-segment ascending-tone question correctly twice in a row, and an 890 s MP3 was summarized accurately; `upload_reused` went `false → true` on the second call. Evidence (request ids, usage, event counts) is in `docs/PROVIDER_PROTOCOL.md` §3b.
   1c. **Known negative (2026-09-25):** an MP4 with no video track (audio-only `ftyp isom`) is refused by the provider with **HTTP 400** through `video_url` (reproduced twice); the same protocol works for MP4/MOV with a video track. The cause is not localized (missing video track vs. another property), so the server does not pre-reject it — the caller sees `MEDIA_ANALYSIS_FAILED` with `http_status=400`. Auto-remuxing it to the audio path would be transcoding, which needs its own approval. Later (2026-09-25) the full A/V version of that same 890 s source video returned an explicit `data_inspection_failed` HTTP 400 instead, so content inspection is a candidate cause for those earlier bare 400s — their bodies were discarded by the pre-ADR-0023 code, so the cause is not retroactively knowable and this is not established.
   1d. **Still unverified:** the `MEDIA_MODEL_UNSUPPORTED` error-code allowlist in `src/provider-error.ts` remains mock-fixed — the observed 400 was not a recognized modality rejection. A text-only model (`qwen-plus`) accepts an `input_audio` request without error and, measured against a no-media control at the same model/question, contributes zero input tokens for the block; the server therefore must not infer "media was read" from tokens — it exposes `request.model`/`usage` and says in `limitations` that the local check does not prove the model heard anything. Host-GUI calling of `analyze_media` has passed twice, both 2026-09-25: one Codex task with the public MP4 fixture, and one ZCode GUI session where a `-c copy` MOV remux of that same fixture (identical `mdat` payload, verified locally) was dragged in; both reported `24` + `3.1415926`. Codex-side new-session drag-in and in-host MOV/MP3, and provider cost figures are still unverified. A 2026-09-25 host call on the documented 72,559 B three-tone MP3 is a real "heard it but got the numbers wrong" sample: the model answered 4 segments with switches at 2/5/8 s while a local spectral-centroid measurement shows 3 segments at ≈2.9/5.9 s. Never treat model-reported segment counts or timestamps as verified.
   1e. **2026-09-26 update to 1d:** With explicit authorization, the current Codex task also called `analyze_media` once each on the documented 3 s synthetic MOV and 9 s three-tone MP3. Both returned `isError=false` and answers matching the fixture descriptions; the model was `qwen3.5-omni-plus`. This verifies the current task's mounted Tool for MOV/MP3. **Codex new-session drag-in and a fresh MCP process loading the latest local build remain unverified.** Provider charges remain unknown. See `tasks/codex-acceptance-20260926.md`; do not infer a model's internal modality path from a matching answer.
   1f. **2026-09-26 restart update:** After the user restarted Codex and explicitly requested testing, one MOV and one MP3 call succeeded again. The MCP process started after the local build; the global installation junction points to this repo and key dist hashes match. Loading the current build in a fresh MCP process is now verified. **New-session manual drag-in is still unverified**, as are Node 22/24 PR CI and charges. See the acceptance report for the two calls and their limits.
2. The default model id string is `qwen3.8-omni-flash`. `QWEN_MODEL` may point at another DashScope id that accepts the same `video_url`/`input_audio` protocol; VL-only models will not hear embedded audio, and audio-input support is not guaranteed across ids. Verify against the Bailian model list if a call returns a model-not-found error. Thinking is on by default for this model: reasoning may arrive as a separate `reasoning_content` field or wrapped in `<think>` inside `content` — `src/sse.ts` drops both and fails with `parse_reason=reasoning_only` when only reasoning arrived.
3. Local MP4/MOV files are streamed to Beijing temporary upload (48h). Accepted containers are `.mp4` and `.mov` (ISO BMFF `ftyp`); video codecs `avc1`/`avc3`/`hvc1`/`hev1` and audio `mp4a` only. Local `.mp3` is accepted only when a bounded probe finds real MPEG Layer III frames (`src/mpeg-audio.ts`) — an ID3-only or renamed text file is refused, and MP3 duration is reported only when the stream declares a Xing/Info/VBRI frame count — no bitrate estimation, because sampling cannot prove a whole file is constant bitrate and a wrong number would drive the one-hour gate. The server never transcodes — no FFmpeg dependency and no runtime beyond Node. Do not Base64 whole media. Authorization is extension + content probe + size + required allowed-root containment + duration probe (`resolveMedia` in `src/media.ts`). Unset roots → `MEDIA_PATH_NOT_ALLOWED`. Duration **greater than** 3600 seconds is `MEDIA_TOO_LONG`; exactly 3600 is allowed; unknown duration is allowed and must never be guessed. HTTPS is not probed, and a remote `.mp3` URL is refused (`UNSUPPORTED_MEDIA`, `input_kind=remote_audio`) instead of being treated as verified remote audio.
4. Production `analyzeMedia` always sends `stream: true`, `modalities: ["text"]`, and `stream_options.include_usage`, and adds `X-DashScope-OssResourceResolve: enable` for uploaded `oss://` inputs (video and audio alike). It never sends a business analysis outline: the only server-side wording is the fixed `PROTOCOL_NOTE`.
5. The default `dashscope.aliyuncs.com/compatible-mode/v1` endpoint is documented to serve `qwen3.8-omni-flash` and the `qwen3.5-omni-*` ids. Business-space MaaS URLs (`https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`) exist but are not required. API keys are region-bound: a key from another region returns 401.
6. MCP server `instructions` (returned in `initialize`) are surfaced to the model by Claude Code (loaded at session start, truncated at 2KB) and pi (leading ~150 chars in the mcp tool description). Some hosts (e.g. Claude.ai web) ignore them — tool descriptions carry the same guidance as a fallback. Keep both layers in sync when the guidance changes.
