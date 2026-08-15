# Video MCP v1 架构

## 总体数据流

```text
Agent
  │ analyze_video(video, question)
  ▼
MCP server.ts
  │ validate public schema
  ▼
Media resolver / authorizer
  ├─ HTTPS URL ───────────────────────────────┐
  └─ Local absolute MP4                      │
       │ allowed roots + realpath             │
       │ FileHandle + fstat + magic + size    │
       ▼                                      │
     DashScope temporary uploader             │
       │ stream multipart from same handle    │
       ▼                                      │
     oss:// URL + requiresOssResolve=true     │
                                              ▼
                                  Qwen provider adapter
                                    │ qwen3.5-omni-flash
                                    │ stream:true, modalities:["text"]
                                    ▼
                                  SSE aggregator
                                    │ complete answer
                                    ▼
                               MCP plain-text result
```

Agent 不知道路径授权、上传器、`oss://`、模型 id 或 SSE 的存在。

## 模块职责

### `src/server.ts`

- 只注册 `analyze_video`。
- 维护 Agent-facing schema、默认 prompt 和错误映射。
- 将成功结果转换为单个 text content。
- 不拼装 provider HTTP，不读取文件，不记录原始错误体。

### `src/config.ts`

- 只在启动阶段读取环境变量。
- 将 allowed roots 解析为绝对真实目录。
- 验证固定上限、超时、重试数和 HTTPS 端点。
- 不打印 API Key；状态输出也不显示首尾片段。

### `src/media.ts`

- 把输入分类为 HTTPS 或本地绝对路径。
- 对本地路径执行 [`SECURITY.md`](SECURITY.md) 的授权流程。
- 返回一个已打开、已验证的 `FileHandle`；不返回可被重新打开的“可信字符串路径”作为上传依据。
- 从同一个句柄读取少量头部判断 MP4 magic。
- 负责关闭策略的所有权必须明确：成功转交 uploader 后由最外层 `finally` 关闭。

建议内部类型：

```ts
type ResolvedVideo =
  | { kind: "https"; url: string }
  | {
      kind: "local";
      handle: FileHandle;
      sizeBytes: number;
      safeUploadName: string;
    };
```

不要把真实绝对路径放入该对象的可日志字段。

### `src/upload.ts`

- 通过目标模型获取一次临时上传 policy。
- 用 Zod 验证 policy 响应；未知字段忽略，必需字段缺失则失败。
- 在传输前检查本地上限和 policy 动态上限。
- 生成不可碰撞、不含原文件名的对象 key。
- 从 `FileHandle.createReadStream()` 生成 multipart 文件段，禁止整文件缓冲。
- 上传成功返回 `UploadedVideo`，不向上层暴露 policy 凭证。

建议接口：

```ts
interface UploadedVideo {
  url: string;
  requiresOssResolve: true;
}

interface MediaUploader {
  upload(video: AuthorizedLocalVideo, signal: AbortSignal): Promise<UploadedVideo>;
}
```

未来生产 OSS 通过另一实现满足同一接口；Tool schema 不变。

### `src/sse.ts`

- 只负责字节流到结构化 event 的增量解码。
- 正确处理 CRLF、任意 TCP 分块、多个 `data:` 行、UTF-8 跨块、usage-only chunk 和 `[DONE]`。
- 用 Zod 做最小运行时校验。
- 输出完整 text、终止状态和内部诊断元数据。
- 不负责 HTTP 重试。

### `src/bailian.ts`

- 构造固定 provider payload 和 header。
- 根据 `requiresOssResolve` 决定是否添加 OSS resolve header。
- 分开控制 analysis timeout。
- 只在尚未收到任何 SSE 内容时，对 429/502/503 做至多一次有限重试。
- 将 provider 异常转换为内部错误，不把原始 detail 交给 Server。

建议 Provider 边界：

```ts
interface VideoAnalyzer {
  analyze(input: ProviderVideo, request: AnalyzeVideoRequest): Promise<AnalyzeVideoResult>;
}
```

以后切换纯视频模型时只替换该层；如果音频能力缺失，适配器必须诚实表达能力限制。

### `src/errors.ts`

- 内部 discriminated union 或 typed error。
- 包含稳定错误码、阶段、可重试标记和可选 HTTP status/request id。
- Agent message 与 diagnostic detail 分开。
- 构造时即脱敏，不允许把 `unknown` 直接 `JSON.stringify()` 返回给 Agent。

### `src/index.ts`

- 建立 stdio transport。
- stdout 不写任何普通日志。
- SIGINT/SIGTERM 时 abort 活跃上传/推理，关闭 Server 和文件句柄。
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

状态不得倒退。临时上传成功、推理失败时复用该 `oss://` 做一次允许的推理重试，不重新上传。上传失败不自动从头重传 500 MiB。

v1 进程只允许一个活跃调用。第二个调用立即返回 `VIDEO_ANALYSIS_BUSY`，不排队、不读取文件、不获取 policy。锁必须在所有成功、失败、超时和取消路径的 `finally` 中释放。

## 资源所有权

- 本地 `FileHandle`：授权函数打开；最外层调用 `finally` 关闭。
- 上传 response/body：无论成功失败都释放或取消。
- 推理 response/body：完成、错误、超时和进程退出都取消。
- AbortController：每阶段一个 timeout controller，并与外部取消信号合并。
- 临时远程对象：无显式删除 API，48 小时由 DashScope 自动删除；文档和日志不得声称即时清理。

## 内存不变量

对于大小为 `N` 的本地视频：

- 禁止存在 `O(N)` 的 Buffer、字符串、Blob 内存副本或 JSON body。
- multipart 前后缀可以小块 Buffer 保存。
- 读取块和 fetch 内部队列必须有背压。
- 500 MiB mock 上传 RSS 增量目标 ≤128 MiB，硬上限 ≤192 MiB。

代码审查中出现以下调用应默认阻断，除非证明不在大视频路径：

```text
readFile(videoPath)
buffer.toString("base64")
new Blob([wholeVideo])
JSON.stringify({ ... wholeVideo ... })
```

## 依赖策略

先用 Node 内置能力做一个可测的 multipart streaming spike。候选实现为：小型边界 Buffer + `FileHandle.createReadStream()` + 带背压的组合流 + `fetch(..., { duplex: "half" })`，并精确设置 multipart `Content-Type`，必要时计算 `Content-Length`。

不得只因为 native `FormData` API 简单就假设它不会缓冲；必须用 500 MiB mock 上传测 RSS。若 Node 20/22 或 Windows 表现不可靠，Gate 1 只提交证据和替代依赖建议，等待批准，不能擅自添加依赖。

## Agent 集成

构建后由 Host 以 stdio 启动：

```json
{
  "mcpServers": {
    "video-understanding": {
      "command": "node",
      "args": ["C:\\absolute\\path\\analyze-video-mcp\\dist\\index.js"],
      "env": {
        "QWEN_ALLOWED_ROOTS": "C:\\Users\\user\\Videos"
      }
    }
  }
}
```

API Key 由用户写入本机 Host `env`，不要提交。模板见 `examples/`。
