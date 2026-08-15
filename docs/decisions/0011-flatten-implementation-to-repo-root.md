# ADR 0011：实现目录提到仓库根

- Status: Accepted
- Date: 2026-08-15

## Context

v0.4.0 发布时，公开仓库是双 package：根目录 `analyze-video-mcp` 只做 `npx` 包装，实现仍在 `qwen-omni-mcp/`。这是 ADR 0006 为保留上游目录约定而留下的。安装链修通之后，这个嵌套变成负担：CI 处处 `working-directory`，`bin` 指向 `qwen-omni-mcp/dist/index.js`，`files` 白名单和两层 `.npmignore` 都是为嵌套 dist 服务的。

`v0.4.0` 标签必须保持旧布局。扁平化只上 `main` 和之后的标签。

## Decision

- 源码、测试、文档、husky、tsconfig 提到仓库根。
- 根 `package.json` 的 `name` 仍是 `analyze-video-mcp`，`bin` 指向 `dist/index.js`。
- 删除根包装脚本 `scripts/prepare-root.mjs`。`prepare` 只在 git 源码树里装 husky 并 build；安装已打好的 tarball 时因没有 `.git` 而空操作。
- 本 ADR 取代 ADR 0006「实现保持在 `qwen-omni-mcp/`」和 ADR 0010「git 根提供 bin、实现仍在子目录」。工作区仍是唯一 git 根。

## Alternatives

1. 继续双 package：拒绝；安装已经验证，嵌套不再有产品价值。
2. 把根包装改成 npm workspace：拒绝；只有一个包，workspace 增加安装复杂度。
3. 改 `v0.4.0` 标签内容：拒绝；已发布标签不可变。

## Consequences

- `npx github:JaylanJerry/analyze-video-mcp#main` 装到 `node_modules/analyze-video-mcp/dist/index.js`。
- `#v0.4.0` 仍是旧布局，路径带 `qwen-omni-mcp/dist`。
- 根 `.gitignore` 的 `**/dist/` 仍会挡住 pack，所以继续用 `.npmignore` 打断它，`files` 白名单只含 `dist`。
