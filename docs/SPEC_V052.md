# v0.5.2：上传缓存、百炼模型配置与安装名

状态：已批准（用户 2026-08-17）。不改 `analyze_video(video, question?)`。不发 npm，除非另说。

实战复盘：同一大文件连问会重复上传；时间戳/音效是模型抽样，不能当帧级剪辑；人要能换百炼同协议视频模型；Host 安装名不要写死。DSH 别名、热更、别家模型不做。

## 1. 保持不变

- 唯一 Tool：`analyze_video(video, question?)`。schema 仍不得出现 `model`。
- 默认推理模型：`qwen3.5-omni-flash`。必须联合看画面、听内嵌音轨。
- 不增加生产依赖、不抽帧、不取音频、不加 JSON 分镜字段。
- npm 包名与 `npx -y analyze-video-mcp` 不变。

## 2. 要做

### 2.1 进程内上传缓存

本地 MP4 上传成功后，按 **文件身份 + 当前 `QWEN_MODEL`** 缓存本次 `oss://`。同一进程内、同一模型、同一文件的后续提问跳过上传，只改 `question` 再推理。

- 身份：`realpath`（Windows 小写）+ `size` + `mtimeMs`。不做整文件 hash（避免为查缓存再读一遍 555 MiB）。
- TTL：47 小时（临时对象官方约 48 小时，留余量）。过期或进程退出则失效。
- 换模型不算命中（policy 按模型签发）。HTTPS 不走缓存。分析正文不缓存。
- 仍不缓存上传 **credential**（policy 300 秒那套）。只复用已上传对象 URL。
- 同大小原地覆盖且 mtime 不变时可能脏命中：接受为残余；不为此做内容 hash。

### 2.2 能力边界（文档 + 发给模型的约束）

README / Tool 说明 / server instructions 写明：抽样理解，不是帧级定位；未命中缓存会全量上传。

发给视频模型：声音区分「音轨里听到的」与「根据画面推断的」；没听到就写没听到；时间戳正序、不越界，吃不准写大约。不保证切点一张不漏。

### 2.3 `QWEN_MODEL`

已存在于 `loadConfig`。README 环境变量表公开。人在 Host `env` 填写；Agent 不可见。

允许换成百炼/DashScope 上、与当前 `video_url` + 临时上传协议兼容的视频模型。无代码白名单。VL-only 能设上去但会听不见声音——文档写清。别家云不做。

### 2.4 安装名

- Host 配置键示例改为 `mcp_analyze_video`（Cursor / Claude / Codex / VS Code 模板）。用户仍可改成任意键。
- 协议 `initialize.name` 默认仍是 `analyze-video-mcp`。可选 `QWEN_MCP_SERVER_NAME`（1–64，`[A-Za-z0-9][A-Za-z0-9._-]*`）。
- Tool 名仍是 `analyze_video`。不在本仓库伪造 DSH 的 `mcp__…__…` 别名。

## 3. 完成标准

- 同一本地 MP4、同一模型、两次不同 `question`：内层 uploader 只调用一次。
- 换 `QWEN_MODEL` 或过 TTL：再上传。
- `listTools` 仍只有 `analyze_video`，无 `model` 字段。
- 未设 `QWEN_MCP_SERVER_NAME` 时 initialize name 仍为 `analyze-video-mcp`。
- 质量门：`typecheck` / `lint` / `format:check` / `test` / `build`。
- 不默认跑 `LIVE=1`。
