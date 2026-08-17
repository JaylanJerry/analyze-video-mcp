# ADR 0014：tag 触发 npm Trusted Publishing

- Status: Accepted
- Date: 2026-08-17

## Context

本机 `npm publish` 每次都要 2FA / 浏览器授权。GitHub Release 已经由 `release.yml` 在推 `v*` 时自动创建。用户要同一条路径发 npm，不要长期 `NPM_TOKEN`，也不要 Bypass 2FA 令牌（npm 正在收紧这类令牌）。

ADR 0012 / SPEC_V05 写过「不发 npm」：那是 v0.5.0 当时的范围。0.5.1 / 0.5.2 已用手发过。本 ADR 只改发版通道，不改 Tool。

## Decision

1. 推已授权的 `v*` 标签时，`release.yml` 在 pack/npx probe 通过后执行 `npm publish --access public`，再 `gh release create`。仍不改工作树、不 push、不移动 tag。
2. 认证用 npm Trusted Publishing（OIDC）：`id-token: write`。不设 `NPM_TOKEN`，不把密钥写入仓库。
3. 人在 npm 包设置里把 Trusted Publisher 指到 GitHub 用户 `JaylanJerry`、仓库 `analyze-video-mcp`、workflow 文件名 `release.yml`，允许 `npm publish`。
4. 本机仍可手动发（2FA）。Agents 不得本机 `npm publish`，除非用户明确要求；默认通道是推 tag。
5. 不在每次 push `main` 时发包。tag 仍须等于 `v${package.version}` 且与 `PACKAGE_VERSION` 一致。

## Alternatives

1. GitHub secret 里放 Bypass 2FA granular token：拒绝；长期写权限令牌，且 npm 正在限制 bypass 令牌的发包能力。
2. push `main` 自动发 npm：拒绝；误合会发出版本。
3. 只做 staged publish、仍要人 2FA 批准：拒绝；用户要的是推 tag 即发布，与 GitHub Release 同级。

## Consequences

- 首次 CI 发布前必须在 npmjs.com 配好 Trusted Publisher，否则 `npm publish` 会 `ENEEDAUTH`。
- provenance 在公开仓库 + Trusted Publishing 下由 npm 自动生成。
- 打 tag 仍须另一次明确授权（推 tag 也是 push）。
- 已存在的 npm 版本（如 `0.5.2`）若再推同名 tag，publish 会失败；不要重发。
