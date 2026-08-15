# AGENTS.md — Rules for AI agents working on this repo

Hard rules. Follow exactly. These exist to keep agents from shipping broken or leaky code.

## Secrets (highest priority)

- **Never commit secrets, API keys, tokens, or `.env` files.** Keys live only in `.env` (gitignored) or environment variables.
- **Never hardcode a key in source, tests, configs, or docs.** Read it from `DASHSCOPE_API_KEY` via `src/config.ts`.
- **Never paste a real key into a fixture.** Tests use dummy values (`sk-test`, `sk-secret-key-…`). The pre-commit `check-secrets.mjs` blocks `sk-ws-…` (real Bailian keys); don't try to evade it.
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

CI runs the same on Node 20 and 22. Local green ≠ CI green if you skip a step.

## Code standards

- **TypeScript strict.** No `any` in `src/` (allowed sparingly in `test/` for fixture typing). No `@ts-ignore`. No non-null assertions in `src/`.
- Prefer narrow types and `unknown` over `any` when parsing external JSON (see `src/bailian.ts`).
- The DashScope payload builder (`buildPayload`) is intentionally injectable — if the `video_url`/`image_url`/`input_audio` content block shape changes, change it in one place (`contentBlock` / `audioBlock` in `src/bailian.ts`).
- Do not add a new runtime, language, or heavy dependency without explicit maintainer approval.
- Match existing style; let `prettier` and `eslint --fix` handle formatting.

## Tool surface

This specialized fork exposes exactly one MCP tool: `analyze_video(video, question?)`. See ADR 0001, ADR 0009, and `docs/API_CONTRACT.md`. Do not restore the upstream five-tool surface, and do not add `max_tokens`, `thinking_budget`, `video_url`, or model fields to the public schema.

Agent-facing errors must stay redacted. There are tests asserting no key, path, or `oss://` leaks — keep them passing.

## Backend

- Endpoint: Bailian (DashScope) OpenAI-compatible mode, `${DASHSCOPE_BASE_URL}/chat/completions` (default `https://dashscope.aliyuncs.com/compatible-mode/v1`).
- Model: `qwen3.5-omni-flash` for `analyze_video`. The call must jointly read picture and embedded audio. Do not add client-side frame or audio extraction.
- Requests use `stream: true`, `modalities: ["text"]`, and `stream_options.include_usage`. Do not send Thinking or audio-output parameters.
- Local files are authorized FileHandles streamed to Beijing temporary upload (48h). Do not Base64 whole videos.
- The Anthropic-compatible `/apps/anthropic` endpoint does NOT support video input. Do not switch to it.

## Testing

- Unit + mocked e2e use **msw** to mock `fetch` — no real API calls, no cost. Keep it that way.
- Live tests (`test/live.test.ts`) run only with `LIVE=1` and a real `DASHSCOPE_API_KEY`. They hit the real API and cost tokens. Run locally to verify behavior; never make them part of the default `npm test`.
- Every new tool or branch of logic gets a test. Coverage threshold is 85%.

## Filesystem

- Delete files with `trash`, never `rm` (per global policy).
- `ref/` is vendored reference material — read-only, do not modify, do not import from.

## Fragile assumptions (verify before relying on)

1. The OpenAI-compatible endpoint accepts a `video_url` content block for `qwen3.8-max` (verified live; previously verified for `qwen3.7-plus`). If a live call rejects it, the fallback is the native DashScope `video` content type or switching to `qwen-vl-max-latest`. Change `contentBlock()` in `src/bailian.ts`.
2. The exact model id strings `qwen3.8-max` and `qwen3.5-omni-plus`. Verify against the Bailian model list if a call returns a model-not-found error.
3. Local files up to the 25MB guardrail in `src/media.ts` can be sent as base64 data URLs — verified live (14MB video / ~18MB body, HTTP 200 on `qwen3.7-plus`; base64 image + video path re-verified on `qwen3.8-max`; 8.8MB video / ~11.7MB base64 body, HTTP 200 on `qwen3.5-omni-plus`). Larger files must be hosted at a public URL. Local input is validated by extension + magic-byte signature before encoding (see `toDataUrl` / `toAudioData`).
4. **Qwen-Omni `stream=True` is NOT mandatory.** The official doc claims all Qwen-Omni requests must set `stream=True`, but live testing shows non-streaming calls succeed (text/audio/video, HTTP 200 + JSON). The omni tools therefore reuse the same non-streaming `analyze` path as `qwen3.8-max`. If a future endpoint revision starts rejecting non-stream omni calls, add a streaming variant in `src/bailian.ts` and route omni tools through it.
5. **`input_audio.data` must be `data:;base64,<b64>` + `format`, not raw base64.** Raw base64 is rejected with `"The provided URL does not appear to be valid"`. Verified live for mp3/wav. If other formats (flac/ogg/m4a/aac) are rejected, change `toAudioData()` in `src/media.ts` (e.g. to a full `data:audio/<fmt>;base64,` data URL) — single point of change, no tool-schema impact.
6. The default `dashscope.aliyuncs.com/compatible-mode/v1` endpoint serves `qwen3.5-omni-plus` (verified live). No workspace-specific MaaS URL is needed. If a future key/region rejects omni, add an optional `QWEN_OMNI_BASE_URL` env and route omni calls through it.
7. **`thinking_budget` works on `qwen3.8-max` and `qwen3.5-omni-plus` (live-verified) although the official applicability list only names Qwen3.7 and earlier.** Verified semantics: upper bound on reasoning tokens (`thinking_budget: 10` → exactly 10 reasoning tokens), thinking tokens are billed but do NOT count against `max_tokens` (answer budget). It is optional and omitted unless the caller passes it. If a future endpoint revision rejects it, drop the passthrough in `buildPayload()` — tool schemas keep accepting the field, it just becomes a no-op until fixed.
8. MCP server `instructions` (returned in `initialize`) are surfaced to the model by Claude Code (loaded at session start, truncated at 2KB) and pi (leading ~150 chars in the mcp tool description). Some hosts (e.g. Claude.ai web) ignore them — tool descriptions carry the same guidance as a fallback. Keep both layers in sync when the guidance changes.
