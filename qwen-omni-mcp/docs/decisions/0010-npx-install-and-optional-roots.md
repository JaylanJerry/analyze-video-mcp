# ADR 0010：npx 安装与可选允许目录

- Status: Accepted
- Date: 2026-08-15

## Context

V2 已经能在本机分析视频，但安装仍是 clone、`npm run build`、填写 `dist` 绝对路径，并且必须配置 `QWEN_ALLOWED_ROOTS`。用户要的是普通 MCP：推到 GitHub 后用 `npx` 装上，填 Key 就能分析这次对话带上的视频。

ADR 0004 规定未配置允许根时拒绝全部本地路径。这对「拖进窗口的一条路径」过严：工具并不会扫盘，只读本次传入的路径。用户级 MCP 的进程 cwd 也不等于当前项目，不能拿来当默认根。

## Decision

1. 产品安装改为 `npx -y github:<账号>/<仓库>`。git 根提供 `bin`，实现仍在 `qwen-omni-mcp/`。不发 npm。
2. `QWEN_ALLOWED_ROOTS` 改为可选。未设置时，允许本次传入的本地绝对 MP4；仍校验绝对路径、扩展名、magic、大小。设置后，0004 的 containment 规则保持不变。
3. Tool 描述要求：具体评审原样写入 `question`；空话先整理成画面与声音问题再调用。
4. 本 ADR 取代 ADR 0004 / 0009 中「未配置允许根则拒绝全部本地路径」和「标准安装必须填写允许目录」的部分。MP4 only、realpath containment（当根已设置）、脱敏、流式上传仍然有效。

## Alternatives

1. 默认允许 cwd：拒绝；用户级 MCP 的 cwd 过宽且不透明。
2. 继续强制允许根：拒绝；拖入工作区外的视频会失败，装完不能直接用。
3. 立刻发 npm：暂缓；先 GitHub `npx`，发布另批。

## Consequences

- 普通人 Host 配置可以只含 Key。
- Agent 若改传另一条它知道的本地 MP4 路径，未设允许根时服务器会读。这是单人本机可接受的残余，不是扫盘。
- 想收紧的人仍可填写 `QWEN_ALLOWED_ROOTS`。
- `npx` 首次会在缓存里安装并 build，需要 Node 20+ 和网络。
- 根 package 必须自己声明 SDK、dotenv、zod。`prepare` 装进子目录的 `node_modules` 不会进入 npm 包。
- 根 `files` 必须显式包含完整 `qwen-omni-mcp/dist`。根目录和 `qwen-omni-mcp/` 都要有 `.npmignore`，否则 `npm pack` 会沿用两层 `.gitignore` 的 `dist/`，把已构建的 JS 全部滤掉。
- `prepare` 只在 git 源码树里安装并构建子包；安装已经打好的 tarball 时必须是空操作。
