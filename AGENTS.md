# AGENTS.md — Rules for AI agents working on this repo

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

CI runs the same on Node 22 and 24. Local green ≠ CI green if you skip a step.

## Scope

- v1 任务在 `tasks/todo.md`，已收尾。v0.5.0 已发布（[`docs/SPEC_V05.md`](docs/SPEC_V05.md)）。v0.5.2 见 [`docs/SPEC_V052.md`](docs/SPEC_V052.md)。默认安装 `npx -y analyze-video-mcp`；GitHub 回退钉 `#v0.5.0`，npm 12 需 `--allow-git=all`。
- 不改变 `analyze_video` 的名称与字段。默认值与本地上限只有在通用规格批准后才能改。
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

This specialized fork exposes exactly one MCP tool: `analyze_video(video, question?)`. See ADR 0001, ADR 0009, and `docs/API_CONTRACT.md`. Do not restore the upstream five-tool surface, and do not add `max_tokens`, `thinking_budget`, `video_url`, or model fields to the public schema.

Agent-facing errors must stay redacted. There are tests asserting no key, path, or `oss://` leaks — keep them passing.

## Backend

- Endpoint: Bailian (DashScope) OpenAI-compatible mode, `${DASHSCOPE_BASE_URL}/chat/completions` (default `https://dashscope.aliyuncs.com/compatible-mode/v1`).
- Model: default `qwen3.5-omni-flash` for `analyze_video`, overridable with env `QWEN_MODEL` (not a Tool field). The call must jointly read picture and embedded audio. Do not add client-side frame or audio extraction.
- Requests use `stream: true`, `modalities: ["text"]`, and `stream_options.include_usage`. Do not send Thinking or audio-output parameters.
- Local files are authorized FileHandles streamed to Beijing temporary upload (48h). Same file + same model may reuse the `oss://` URL in-process for ~47h; do not cache upload credentials. Do not Base64 whole videos.
- The Anthropic-compatible `/apps/anthropic` endpoint does NOT support video input. Do not switch to it.

## Testing

- Unit + mocked e2e use **msw** to mock `fetch` — no real API calls, no cost. Keep it that way.
- Live tests (`test/live.test.ts`) run only with `LIVE=1` and a real `DASHSCOPE_API_KEY`. They hit the real API and cost tokens. Run locally to verify behavior; never make them part of the default `npm test`.
- Every new tool or branch of logic gets a test. Coverage threshold is 85%.

## Filesystem

- Delete files with `trash`, never `rm` (per global policy).
- `ref/` is vendored reference material — read-only, do not modify, do not import from.

## Fragile assumptions (verify before relying on)

1. The OpenAI-compatible endpoint accepts a `video_url` content block for `qwen3.5-omni-flash` (verified live). If a live call rejects it, the fallback is the native DashScope `video` content type. Change `contentBlock()` in `src/bailian.ts`.
2. The default model id string is `qwen3.5-omni-flash`. `QWEN_MODEL` may point at another DashScope id that accepts the same `video_url` protocol; VL-only models will not hear embedded audio. Verify against the Bailian model list if a call returns a model-not-found error.
3. Local MP4s are streamed to Beijing temporary upload (48h). Do not Base64 whole videos. Authorization is extension + ftyp magic + size + optional allowed-root containment + `mvhd` duration probe (`resolveVideo` in `src/media.ts`). Duration **greater than** 3600 seconds is `VIDEO_TOO_LONG`; exactly 3600 is allowed; unknown duration is allowed. HTTPS is not probed.
4. Production `analyzeVideo` always sends `stream: true`, `modalities: ["text"]`, and `stream_options.include_usage`.
5. The default `dashscope.aliyuncs.com/compatible-mode/v1` endpoint serves `qwen3.5-omni-flash` (verified live). No workspace-specific MaaS URL is needed.
6. MCP server `instructions` (returned in `initialize`) are surfaced to the model by Claude Code (loaded at session start, truncated at 2KB) and pi (leading ~150 chars in the mcp tool description). Some hosts (e.g. Claude.ai web) ignore them — tool descriptions carry the same guidance as a fallback. Keep both layers in sync when the guidance changes.
