# Video MCP v1 规格

状态：Ready for implementation

范围批准依据：用户已确认“一个 Agent、一个 MCP、视频画面与音频联合分析、只返回结果，暂不需要花哨功能”。

实现状态：未开始。

## 1. 目标

构建一个本地 stdio MCP Server，让不具备原生视频理解能力的 Agent 可以调用一个工具分析视频。对 Agent 而言，体验应等价于新增一种原生能力：传入视频和问题，等待后直接获得模型文本回答。

当前默认模型为 `qwen3.5-omni-flash`。它应直接读取视频文件中的画面和内嵌音轨，不在客户端抽帧或抽音频。

### 目标使用场景

- 单用户、本机 Agent。
- Windows 11 为主要环境，Node.js 22 为发布验收环境。
- 本地 MP4 常见时长约 7 分钟，最大 500 MiB。
- Agent 只关心最终文本，不需要看到上传、模型或存储细节。

## 2. 公开功能

只注册一个 Tool：

```text
analyze_video(video, question?, max_tokens?) -> text
```

详细 schema、默认值和错误契约见 [`API_CONTRACT.md`](API_CONTRACT.md)。

### 行为

1. `video` 为本地路径时，验证路径权限、文件身份、MP4 类型和大小。
2. 从同一个已验证文件句柄流式上传到 DashScope 临时存储。
3. 用返回的 `oss://` 地址调用 `qwen3.5-omni-flash`。
4. 请求固定为文本输出和 SSE 流式响应。
5. 聚合完成后只向 Agent 返回回答文本。
6. `video` 为 HTTPS URL 时不在本机下载，直接交给模型服务解析。

## 3. 非目标

v1 明确不做：

- 图片分析、独立音频分析、状态查询等额外 Agent Tool；
- 视频编辑、播放、转码、抽帧、抽音轨、字幕烧录；
- GUI、Web 控制台、进度面板；
- Agent 可选模型、供应商或上传方式；
- TTS、音频输出、Thinking、函数调用、联网搜索；
- WebSocket 实时会话；
- 多租户、高并发、生产级对象生命周期管理；
- SDK v2 迁移、Bun 二进制发布、npm 发布；
- 自动下载任意 URL 再上传；
- 自动重试整个 500 MiB 上传。

这些功能只有在 v1 验收后、用户另行批准才能进入范围。

## 4. 输入约束

### 本地文件

- v1 只接受 MP4。
- 最大 `500 MiB = 524288000 bytes`。
- 必须位于 `QWEN_ALLOWED_ROOTS` 的某个真实根目录下。
- 路径可以包含中文、空格和 Windows 反斜杠。
- 空文件、目录、设备、管道、无权限文件、越界路径、非 MP4 magic 必须在上传前拒绝。
- 禁止把整个文件读入 Buffer、Blob 内存副本、Base64 字符串或 JSON。

### 远程文件

- 只接受 `https://`。
- 拒绝 `http://`、`file://`、`data:`、`ftp://` 及无协议输入。
- Server 不主动抓取远程 URL；可访问性和内容限制由 DashScope 验证。

### 问题与输出

- `question` 缺省时要求同时描述画面和声音。
- `max_tokens` 缺省 1024，允许 1–8192。
- 输出只包含模型回答文本；不拼接 provider、request id、OSS URL、绝对路径或用量。

## 5. 配置

| 环境变量 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DASHSCOPE_API_KEY` | 是 | 无 | 只从进程环境读取 |
| `QWEN_ALLOWED_ROOTS` | 本地路径时是 | 空 | 用 `path.delimiter` 分隔；为空时拒绝所有本地路径 |
| `QWEN_MODEL` | 否 | `qwen3.5-omni-flash` | 内部配置，不进入 Tool schema |
| `DASHSCOPE_BASE_URL` | 否 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 北京区推理端点 |
| `DASHSCOPE_UPLOAD_URL` | 否 | `https://dashscope.aliyuncs.com/api/v1/uploads` | 北京区临时上传 policy 端点 |
| `QWEN_MAX_LOCAL_VIDEO_MB` | 否 | `500` | 本地策略上限，不可大于 500 |
| `QWEN_UPLOAD_TIMEOUT` | 否 | `900` | 上传超时，秒 |
| `QWEN_ANALYSIS_TIMEOUT` | 否 | `900` | 推理/SSE 超时，秒 |
| `QWEN_ANALYSIS_RETRIES` | 否 | `1` | 首字节前可重试次数，只允许 0 或 1 |

配置解析失败应在 Server 启动阶段快速失败；错误不得包含密钥值。

## 6. 工程命令

遵循现有仓库：

```powershell
npm run dev
npm run typecheck
npm run lint
npm run format:check
npm test
npm run coverage
npm run build
```

付费 live test 必须显式启用并满足前置条件。具体见 [`TESTING_AND_VERIFICATION.md`](TESTING_AND_VERIFICATION.md)。

## 7. 代码与项目结构

目标结构允许在实现中微调文件名，但职责不能混回单文件：

```text
src/
  index.ts          进程生命周期与 stdio
  server.ts         唯一 MCP Tool 及 Agent 错误映射
  config.ts         环境变量和静态上限
  media.ts          URL 分类、路径授权、文件句柄与 magic 校验
  upload.ts         policy 解析与流式 multipart 上传
  sse.ts            增量 SSE 解码与 delta 聚合
  bailian.ts        Provider 请求构造、超时、有限重试
  errors.ts         内部错误类型和安全错误码
test/
  ...               与 src 职责对应
docs/
  ...               规格、协议、ADR 与审核门
tasks/
  plan.md
  todo.md
```

代码继续使用 ESM、严格 TypeScript、Zod 运行时解析和现有格式规范。`src/` 禁止 `any`、`@ts-ignore` 和非空断言。

## 8. 测试策略

必须覆盖四层：

1. 单元：路径、magic、policy schema、multipart 编码、SSE 分块、错误映射。
2. Mock 集成：完整上传和推理 HTTP 契约，不访问外网、不计费。
3. MCP 内存传输 E2E：只暴露一个 Tool，调用结果为纯文本。
4. 人工 live：小型语义 AV、50–100 MiB、450–500 MiB、Windows Host。

默认 `npm test` 不得访问网络。Live 命令缺少 key 或 fixture 时必须失败并说明原因，不能以“全部 skipped”返回绿色。

## 9. 边界与假设

- DashScope 临时上传只支持北京区，文件 48 小时自动删除，适合当前个人/开发场景。
- 真实 policy 已验证 `qwen3.5-omni-flash` 的 `max_file_size_mb = 1024`；实现仍必须每次动态检查。
- Qwen3.5-Omni 文档上限为 URL 视频 2 GB、1 小时；本项目主动收紧到 500 MiB。
- 当前不承诺防御拥有同一 Windows 账户并能在纳秒级替换文件的主动本机攻击者；实现必须采用“realpath 前后复核 + 同一 FileHandle 上传”降低 TOCTOU，残余风险记录在安全文档。
- 临时 OSS 对象没有显式删除接口；不得伪造“上传后已删除”的状态。
- 上传 credential 实测有效期为 300 秒；500 MiB 需要约 14 Mbit/s 的持续有效上行才能在该窗口内完成，慢速网络可能需要后续正式 OSS 方案。
- 后续可替换为纯视频模型，但 Tool schema 不变。若新模型不支持音频，必须在内部能力检查后给出诚实结果，不能伪造听觉理解。

## 10. 完成标准

v1 只有同时满足以下条件才算完成：

- `listTools()` 恰好返回 `analyze_video`。
- 小型真实 AV 语义测试同时命中画面值和音频值。
- 本地文件主路径不生成 Base64，不使用整文件 `readFile()`。
- 500 MiB mock 上传的 RSS 增量目标不超过 128 MiB，发布硬上限不超过 192 MiB。
- policy 上限不足时在上传前失败。
- 任意允许根目录之外的本地路径、symlink/junction 越界均被拒绝。
- SSE 可处理任意网络分块、usage-only chunk、`[DONE]`、UTF-8 跨块和中途截断。
- Agent 可见错误不含密钥、policy 凭证、OSS URL、完整 provider body 或本地绝对路径。
- Windows 11 + Node 22 + 中文路径完成真实 Agent 调用。
- 仓库全部质量门通过，coverage 不低于现有 85% 门槛。
- 四个审核 Gate 全部通过，文档与实际行为一致。

## 11. 开放问题

以下问题不阻断 Task T01–T05，但在对应 Gate 必须有结论：

1. Node 内置 `fetch` + 自定义 multipart 流在 Node 20/22/Windows 的峰值内存是否合格？不合格时才申请依赖。
2. 小型 AV fixture 是否允许复制进仓库？未获许可前只作为仓库外 live fixture 使用。
3. 500 MiB 真实视频由用户提供还是按测试文档生成？
4. 最终接入的是哪一种 Agent Host？核心 MCP 验收不依赖 Host，但 Gate 4 需针对实际 Host 写配置。
