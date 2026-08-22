# v0.6：宿主稳定挂载、证据门禁与安全默认

状态：已批准（用户 2026-08-22 实战复盘）。不发 npm、不推 tag，除非另说。

结论：MCP 上传、协议、SSE 与基本脱敏已经可用，不推倒重做。本版修两件事：Codex 等宿主要能稳定看到 `analyze_video`；模型回答要过可验证的实测/推测门禁。

## 1. 保持不变

- 唯一 Tool：`analyze_video(video, question?)`。schema 仍不得出现 `model`、`max_tokens`、`start_seconds`、`end_seconds` 或 FFmpeg 字段。
- 不增加生产依赖，不抽帧、不取音频、不在客户端切段。
- 不 Base64 整段视频。不缓存上传 credential。
- Agent 错误仍禁止路径、Key、`oss://`、policy、signature。
- npm 包名不变。默认安装仍是 `npx`；本版模板钉 `analyze-video-mcp@0.6.0`。

## 2. 要做

### 2.1 Codex / 安装模板

Windows Codex 模板：

```toml
[mcp_servers.mcp_analyze_video]
command = "cmd"
args = ["/c", "npx", "--prefer-offline", "-y", "analyze-video-mcp@0.6.0"]
startup_timeout_sec = 120
tool_timeout_sec = 1200

[mcp_servers.mcp_analyze_video.env]
DASHSCOPE_API_KEY = "YOUR_DASHSCOPE_API_KEY"
QWEN_MODEL = "qwen3.5-omni-plus"
QWEN_ALLOWED_ROOTS = "C:\\Users\\用户名\\Videos"
```

`--prefer-offline` 只降低访问注册表的概率。稳定环境可先全局安装固定版本，再让 Host 启动本地 `dist/index.js`。

安装文档增加：

```powershell
codex mcp list
codex mcp get mcp_analyze_video
```

MCP 新增后应开新任务；创建于配置之前的旧任务可能不会重新挂载工具。

### 2.2 配置错误不得让工具从清单消失

`createServer()` 在缺 Key、坏 URL 或坏允许根时仍必须完成 MCP 握手并注册 `analyze_video`。API Key、端点、允许根在**调用工具时**再验证。失败返回 `CONFIG_MISSING`，进程不退出。

增加 CLI：

```text
analyze-video-mcp --doctor
analyze-video-mcp --doctor --json
```

检查 Node 版本、Key 是否存在（布尔）、允许根是否配置且可解析、端点是否为 HTTPS、包版本、以及内存握手（initialize + listTools）。绝不打印 Key、路径、OSS URL。

启动时 stderr 可写 `analyze-video-mcp 0.6.0`，不得写 stdout。

### 2.3 默认模型

默认 `QWEN_MODEL=qwen3.5-omni-plus`（质量档）。省钱档：`QWEN_MODEL=qwen3.5-omni-flash`。仍须联合看画面、听内嵌音轨。不进 Tool schema。

### 2.4 证据约束与结构化门禁

Provider payload：

1. `system`：证据政策（实测/推测分界、用户纠正压过视觉先验、JSON 形状）。
2. `user`：`video_url` 块 + 用户问题原文。不要再把证据政策拼进普通 user 文本。

要求模型返回：

```json
{
  "visual_observations": [],
  "audio_observations": [],
  "inferences": [],
  "uncertainties": [],
  "answer": ""
}
```

观察项 `evidence` 仅限 `heard` | `seen` | `inferred` | `uncertain`。

服务器拒绝「`heard`/`seen` 同时带可能/似乎」这类结构，纠错重试一次；仍违规则把该项降为 `uncertain`，不得原样交给 Agent。

Agent 成功文本仍是 `answer` 的完整中文（可附整片抽样提示）。不得把原始 JSON 当唯一可见结果。若 Host 支持，可同时给安全的 `structuredContent`（无路径、无 Key、无 OSS）。

模型若返回纯散文（无 JSON），不为此失败；原样作为 `answer` 返回。这是残余：门禁只在模型遵守 JSON 时生效。

### 2.5 整片 vs 短片段（不改 schema）

精确转场、半秒 J/L-cut、削波、响度不是本工具的承诺。文档与 Tool 说明要求调用者先提供 5–30 秒片段或公开片段 URL。

本地 MP4 若 `mvhd` 时长大于 120 秒，把宏观分析提示追加到发给模型的 user 文本。不引入 FFmpeg，不增加 Tool 字段。客观检测层（True Peak、LUFS、黑帧）不在本版。

### 2.6 持久上传缓存

默认在用户缓存目录持久化已成功的 `oss://`：

- 键：`realpath + size + mtime + model + upload endpoint`
- 值：`oss URL + expiresAt`（TTL 仍 47 小时）
- 原子写入；权限尽量仅当前用户；失败上传不写；体积或 mtime 变化即失效；到期丢弃
- 日志不打印 OSS URL
- `QWEN_UPLOAD_CACHE=off` 关闭内存与磁盘缓存

本版取代 ADR 0013「拒绝磁盘缓存」的那一条。仍不缓存 policy credential，不缓存分析正文。

### 2.7 结构化错误

`isError` 结果的 text 仍是 `CODE: 通用中文`。同时带安全 `structuredContent`：

```json
{
  "ok": false,
  "code": "VIDEO_UPLOAD_FAILED",
  "stage": "uploaded",
  "retryable": false,
  "http_status": 400
}
```

新增 `CONFIG_MISSING`。不得含路径、Key、OSS、policy、signature。

### 2.8 本地文件默认拒绝

未设置 `QWEN_ALLOWED_ROOTS` 时拒绝所有本地路径，只允许公开 HTTPS。安装模板必须包含允许根占位。这恢复 ADR 0004 的默认拒绝，并取代 ADR 0010「未设根则放行本次绝对 MP4」。

## 3. 测试

- 无 Key 时 initialize + listTools 成功；callTool 返回 `CONFIG_MISSING`。
- `--doctor --json` 无 Key 泄露。
- 默认模型为 plus；payload 含 system 证据政策。
- `heard` +「可能存在」触发一次纠错；第二次仍违规则降级。
- 未设允许根的本地 MP4 → `VIDEO_PATH_NOT_ALLOWED`。
- 持久缓存：重启后的新 `Map` 从磁盘命中；`off` 不写盘；失败上传不写。
- 错误 `structuredContent` 无 canary 路径/Key/OSS。
- 语义回归 live（静音、非军队、敲击时刻、画面暗示声音、有声无画面动作）默认跳过，不进 `npm test`。

## 4. 发布卫生

版本 `0.6.0`。GitHub 上缺失的 `v0.5.1` / `v0.5.2` tag **不由本版补打**（已发 npm 的版本不要重发）。本版发布仍走授权 `v0.6.0` tag + Trusted Publishing。在此之前模板钉 `@0.6.0` 会在 npm 出现该版本后才可安装。

## 5. 完成标准

- 质量门：`typecheck` / `lint` / `format:check` / `test` / `build`。
- `listTools` 仍只有 `analyze_video`，字段仍是 `video` 与 `question`。
- 不默认跑 `LIVE=1`。
- 不本机 `npm publish`、不推送。
