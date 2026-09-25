# Media MCP 架构（下一大版本分支）

> 本文件描述本工作区**已实现但尚未发布**的 `analyze_media(media, prompt)` 版本。npm 上的 `0.6.1` 仍是 `analyze_video` 单 Tool 版本；两者的公开差异见 [`API_CONTRACT.md`](API_CONTRACT.md) 的迁移表。

## 总体数据流

```text
Agent
  │ analyze_media(media, prompt)
  ▼
MCP server.ts
  │ validate public schema + prompt
  ▼
Media resolver / authorizer (media.ts)
  ├─ 公开 HTTPS 视频 URL ─────────────────────┐
  └─ 本地绝对路径（.mp4 / .mov / .mp3）        │
       │ allowed roots + realpath             │
       │ FileHandle + 身份复核                 │
       ├─ ISO BMFF：ftyp + mvhd + 轨道 fourcc  │
       └─ MPEG 音频：有界帧头解析（mpeg-audio.ts）
       ▼                                      │
     DashScope 临时上传器（upload.ts + upload-cache.ts）
       │ 同一句柄流式 multipart               │
       ▼                                      │
     oss:// URL + requiresOssResolve=true     │
                                              ▼
                          Qwen provider adapter (bailian.ts)
                            │ qwen3.8-omni-flash（默认）
                            │ video_url / input_audio 内容块
                            │ stream:true, modalities:["text"]
                            ▼
                          SSE aggregator (sse.ts)
                            │ 完整回答
                            ▼
                    统一脱敏出口 (sanitize.ts)
                            ▼
                MCP text + 安全 structuredContent
```

Agent 不知道路径授权、上传器、`oss://`、模型 id 或 SSE 的存在；服务端也不知道 Agent 想问什么之外的业务结构。

## 模块职责

### `src/server.ts`

- 只注册 `analyze_media`，输入为 `media` 与必填 `prompt`。
- 维护 Agent-facing schema、Server instructions、Tool 描述、进度消息与错误映射。
- 不拼装 provider HTTP，不读取文件，不记录原始错误体，不注入业务提纲，不发起第二次纠错请求。
- 缺 Key 时仍完成握手并注册 Tool；调用时再 `loadConfig()`。
- 把成功结果转换为单个 text content 与安全 `structuredContent`（`ok`/`answer`/`media`/`request`/`usage?`/`limitations`）。
- 一次进程只允许一个活跃调用；第二个调用立即返回 `MEDIA_ANALYSIS_BUSY`。

### `src/config.ts`

- 启动时只取 `initialize.name`；完整配置在 tool 调用时读取。
- `MEDIA_ALLOWED_ROOTS` 解析为绝对真实目录；`MEDIA_ALLOW_ANY_LOCAL_FILE`（默认 `off`）跳过根判定。
- 旧的 `QWEN_ALLOWED_ROOTS`、`QWEN_ALLOW_ANY_LOCAL_VIDEO`、`QWEN_MAX_LOCAL_VIDEO_MB`、`QWEN_AUDIO_SILENCE_CHECK` 只被**识别并报告**（`legacyMediaVars`），绝不用于授权。
- 验证固定上限、超时、重试数与 HTTPS 端点。不打印 API Key。

### `src/media.ts`

- 把输入分类为 HTTPS 视频或本地绝对路径；远端 `.mp3` URL 直接以 `UNSUPPORTED_MEDIA` 拒绝。
- 对本地路径执行 [`SECURITY.md`](SECURITY.md) 的授权流程：扩展名 → 绝对路径 → 根包含 → realpath → stat 快照 → 只读打开 → fstat 身份比对 → realpath+stat 复核。
- ISO BMFF（MP4/MOV）：`ftyp` magic、`mvhd` 时长（box header + seek，非全文件扫描）、`moov/trak/mdia/hdlr/stbl/stsd` fourcc 白名单（视频 `avc1`/`avc3`/`hvc1`/`hev1`，音频 `mp4a`）。
- MPEG 音频（MP3）：交给 `mpeg-audio.ts`，只接受 MPEG Layer III 帧。
- 返回一个已打开、已验证的 `FileHandle`；不返回可被重新打开的“可信字符串路径”作为上传依据。

### `src/mpeg-audio.ts`

- 有界探测：跳过 ID3v2（声明长度超界即拒绝）、在有限窗口内找首帧、验证连续帧、采样最多 16 帧判断恒定码率。
- 只读帧头与 Xing/Info/VBRI 头部，不做全文件扫描、不缓冲整文件、不依赖任何解码器。
- 时长只在可靠时给出：Xing/VBRI 帧数，或确认恒定码率后的字节估算；并做合理性校验，声明帧数与文件大小矛盾时不产出数字。
- 非 Layer III 返回编码名（如 `mpeg1-layer2`），无有效帧返回 `invalid`。

### `src/bytes.ts`

- 共享的定位读取助手与探测字节预算；任何越预算读取直接失败，避免畸形头部把有界探测变成全文件扫描。

### `src/upload.ts`

- 通过目标模型获取一次临时上传 policy，用 Zod 验证响应；未知字段忽略，必需字段缺失则失败并按稳定 `parse_reason` 分类。
- 在传输前检查本地上限和 policy 动态上限。
- 生成不含原文件名的随机对象 key；从同一 `FileHandle` 生成 multipart 文件段，禁止整文件缓冲。
- 返回 `UploadedMedia`，不向上层暴露 policy 凭证；`reused` 只表示缓存命中。

### `src/upload-cache.ts`

- 缓存键隔离文件身份、**有界内容指纹**（首尾各 64 KiB）、模型、上传端点与**凭证身份指纹**（域分隔 SHA-256 前缀）。百炼临时 URL 绑定上传账号，换 Key 后旧项不可复用；内容改变同样不复用。
- 只持久化短期 `oss://` 引用与到期时间；不保存 Key 或上传凭证；上传失败或取消不留“成功”项。

### `src/sse.ts`

- 只负责字节流到结构化 event 的增量解码；未完成 event 与累计回答各有 4 MiB 硬顶。
- 正确处理 CRLF、任意 TCP 分块、多个 `data:` 行、UTF-8 跨块、usage-only chunk 与 `[DONE]`。
- 剥离 `<think>` 推理块与独立 `reasoning_content`；只有 reasoning 时返回 `parse_reason=reasoning_only`。
- 区分 SSE 补全 `id` 与真正的 `request_id`。

### `src/bailian.ts`

- 构造固定 provider payload 与 header：视频 `video_url`、音频 `input_audio`（`format: "mp3"`）；本地临时 URL 追加 `X-DashScope-OssResourceResolve: enable`。
- 系统消息只含固定 `PROTOCOL_NOTE`（要求文本回答、不要编造），不含业务提纲。
- 分开控制 analysis timeout；只在尚未收到任何 SSE 内容时对 429/502/503 做至多一次有限重试。
- 把 provider 异常转换为内部错误，不把原始 detail 交给 Server。

### `src/sanitize.ts`

- Agent 可见回答的**唯一**改写出口：移除内部 `oss://`、凭证形态与本地绝对路径。不改变媒体语义。

### `src/errors.ts`

- 稳定错误码、阶段、可重试标记、可选 HTTP status / request id 与白名单诊断键。
- Agent message 与 diagnostic detail 分开；构造时即脱敏，不允许把 `unknown` 直接 `JSON.stringify()` 返回给 Agent。

### `src/doctor.ts`

- 报告版本、Node、Key 是否配置（不打印值）、模型、允许根、`local_media_policy.mode`、端点、单 Tool 握手结果。
- 报告旧媒体变量已失效及替代名。

### `src/index.ts`

- 建立 stdio transport；stdout 不写任何普通日志。
- SIGINT/SIGTERM 或 stdin 结束时 abort 活跃上传/推理并关闭 Server 与文件句柄。
- 退出错误写 stderr，内容遵循脱敏规则。

## 关键内部状态

一次 Tool 调用只能按以下单向状态推进：

```text
received
  -> authorized
  -> policy_acquired        本地文件才有
  -> uploaded               本地文件才有
  -> analyzing
  -> completed | failed | aborted
```

状态不得倒退。临时上传成功、推理失败时复用该 `oss://` 做一次允许的推理重试，不重新上传；上传失败不自动从头重传。

进程只允许一个活跃调用。锁必须在所有成功、失败、超时和取消路径的 `finally` 中释放。

## 资源所有权

- 本地 `FileHandle`：授权函数打开；最外层调用 `finally` 关闭。
- 上传 response/body：无论成功失败都释放或取消。
- 推理 response/body：完成、错误、超时和进程退出都取消。
- AbortController：每阶段一个 timeout controller，并与外部取消信号（Host 请求取消、进程信号）合并。
- 临时远程对象：无显式删除 API，48 小时由 DashScope 自动删除；文档和日志不得声称即时清理。

## 内存不变量

对于大小为 `N` 的本地媒体：

- 禁止存在 `O(N)` 的 Buffer、字符串、Blob 内存副本或 JSON body。
- 本地格式探测只读固定窗口，预算由 `bytes.ts` 强制。
- multipart 前后缀可以小块 Buffer 保存；读取块和 fetch 内部队列必须有背压。
- 500 MiB mock 上传 RSS 增量目标 ≤128 MiB，硬上限 ≤192 MiB（`test/upload.test.ts`）。

代码审查中出现以下调用应默认阻断，除非证明不在大文件路径：

```text
readFile(mediaPath)
buffer.toString("base64")
new Blob([wholeMedia])
JSON.stringify({ ... wholeMedia ... })
```

## Agent 集成

构建后由 Host 以 stdio 启动：

```json
{
  "mcpServers": {
    "video-understanding": {
      "command": "node",
      "args": ["C:\\absolute\\path\\analyze-video-mcp\\dist\\index.js"],
      "env": {
        "DASHSCOPE_API_KEY": "…",
        "MEDIA_ALLOWED_ROOTS": "C:\\Users\\user\\Videos"
      }
    }
  }
}
```

API Key 由用户写入本机 Host `env`，不要提交。模板见 `examples/`（其中的 npm 安装示例仍钉已发布的 0.6.1，并标注了下一大版本对应的 Tool 名与变量名）。
