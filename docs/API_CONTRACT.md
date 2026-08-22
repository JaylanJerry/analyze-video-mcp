# MCP Tool 契约

本文件定义 Agent 可见的稳定接口。Provider、模型与上传实现可以替换，但不得修改此契约，除非新增 ADR 并经用户批准。

## Tool 列表

Server 只注册：

```text
analyze_video
```

不得注册上游的 `analyze_image`、`analyze_audio`、`analyze_audio_video` 或 `check_endpoint_status`。这是专项 fork 的有意破坏性收敛，见 ADR 0001。

## 输入 schema

```json
{
  "video": "C:\\Videos\\example.mp4",
  "question": "画面里发生了什么？音频说了什么？"
}
```

| 字段       | 类型   | 必需 | 默认                               | 约束                              |
| ---------- | ------ | ---- | ---------------------------------- | --------------------------------- |
| `video`    | string | 是   | 无                                 | 本地绝对 MP4 路径或公开 HTTPS URL |
| `question` | string | 否   | `画面里发生了什么？音频说了什么？` | trim 后 1–8000 字符               |

Tool schema 不得出现：`max_tokens`、`model`、`provider`、`thinking_budget`、`stream`、`upload`、`audio`、`frames`、`oss_url`。回答长度按模型自身上限，不给 Agent 旋钮。

## Tool 描述语义

描述文本应让 Agent 明确：

```text
当你需要理解视频而当前模型不能直接观看时，调用此工具。
它会联合分析视频画面和视频内嵌音频，并返回文本回答。
不要先自行抽帧或抽音频；直接传入视频路径或 HTTPS URL。
一次最多 1 小时；本地还受 1024 MiB 与当场上传政策约束。
这是抽样理解，不是帧级剪辑定位。精确转场请先提供 5–30 秒片段。
本地文件必须位于 QWEN_ALLOWED_ROOTS。同一本地文件会复用已上传地址；未命中则全量上传。
把用户的分析要求写入 question：具体则原样转发，空话则先整理再调用。
```

Server-level instructions 与 Tool 描述保持同义，第一句优先表达“视频画面 + 音频”。

## 成功结果

MCP `CallToolResult`：

```json
{
  "content": [{ "type": "text", "text": "模型回答" }],
  "structuredContent": {
    "ok": true,
    "visual_observations": [],
    "audio_observations": [],
    "inferences": [],
    "uncertainties": []
  },
  "isError": false
}
```

规则：

- 文本必须是完整中文回答（模型 JSON 的 `answer`，或模型未返回 JSON 时的原文）。
- 不加固定标题、模型名、request id 或耗时。不得把原始 JSON 当作唯一可见结果。
- 若模型返回了合格的证据 JSON，可附加安全的 `structuredContent`（无路径、无 Key、无 OSS）。旧 Host 忽略该字段。
- 空白回答视为错误。
- Tool 不流式向 Agent 暴露 provider chunk；内部 SSE 只用于满足 provider 协议并聚合结果。
- 若 Host 在调用时提供 `progressToken`，本地路径会在上传开始、上传结束、推理开始各发一次 `notifications/progress`；HTTPS 只发推理开始。消息为中文通用句，不含路径或密钥。无 token 的旧 Host 仍只收到最终纯文本。

## 错误结果

```json
{
  "content": [{ "type": "text", "text": "VIDEO_FILE_TOO_LARGE: 视频超过本地允许上限。" }],
  "structuredContent": {
    "ok": false,
    "code": "VIDEO_FILE_TOO_LARGE",
    "stage": "authorized",
    "retryable": false
  },
  "isError": true
}
```

允许的 Agent 错误码：

| 错误码                      | 含义                                           | 是否建议 Agent 重试 |
| --------------------------- | ---------------------------------------------- | ------------------- |
| `INVALID_VIDEO_INPUT`       | schema 之外的输入问题                          | 否                  |
| `VIDEO_PATH_NOT_ALLOWED`    | 本地路径不在允许根目录                         | 否                  |
| `VIDEO_NOT_FOUND`           | 文件不存在或不可读                             | 否                  |
| `UNSUPPORTED_VIDEO`         | 非 MP4、magic 不符或不是普通文件               | 否                  |
| `VIDEO_FILE_TOO_LARGE`      | 超过本地或动态 policy 上限                     | 否                  |
| `VIDEO_TOO_LONG`            | 本地 MP4 时长大于 3600 秒；正好 3600 允许      | 否                  |
| `UPLOAD_POLICY_FAILED`      | 无法取得或解析上传凭证                         | 可稍后重试          |
| `VIDEO_UPLOAD_FAILED`       | 本地上传失败；应改用公开 HTTPS，不要重传原文件 | 否                  |
| `PROVIDER_UNAUTHORIZED`     | API Key 或接口地址无效                         | 否                  |
| `VIDEO_ANALYSIS_BUSY`       | 已有一个视频任务正在上传或分析                 | 稍后重试            |
| `PROVIDER_RATE_LIMITED`     | 429                                            | 按提示稍后重试      |
| `PROVIDER_TIMEOUT`          | 推理超时                                       | 可重试              |
| `PROVIDER_UNAVAILABLE`      | 502/503 等暂时故障                             | 可重试              |
| `PROVIDER_RESPONSE_INVALID` | SSE/JSON 不符合契约或中途截断                  | 可重试              |
| `VIDEO_ANALYSIS_FAILED`     | 其他已脱敏错误                                 | 视情况              |
| `CONFIG_MISSING`            | 启动后调用时仍缺 Key、端点或允许根配置         | 否                  |

Agent 错误文本禁止包含：

- API Key 或任何首尾片段；
- policy、signature、临时 AccessKey；
- `oss://` 全路径；
- 上传 host 的 query；
- 本地绝对路径；
- provider 原始响应体。

完整诊断只能写 stderr，且同样必须脱敏凭证和本地路径；允许记录错误码、HTTP 状态、阶段、request id、耗时和文件大小。Agent 同时收到安全的 `structuredContent`（`ok`/`code`/`stage`/`retryable`，可选 `http_status`），仍不得含路径、Key、OSS、policy 或 signature。

缺 Key 或坏配置不得阻止 MCP `initialize` / `listTools`。工具调用时返回 `CONFIG_MISSING`。`analyze-video-mcp --doctor --json` 供本机自检，绝不打印 Key。

`VIDEO_TOO_LONG`：`retryable: false`；`stage` 为 `authorized`；Agent 文本与 diagnostic 不得含本地绝对路径。大于 3600 秒拒绝，正好 3600 秒允许。读不出时长（缺 `mvhd`、非法 box、`timescale == 0`）则放行，不得用本错误码。HTTPS 不探测时长。

## 兼容性规则

- 后续更换模型或上传器时，Tool 名称、输入字段与成功输出不变。
- 增加可选字段也视为公开 API 变更，需要 ADR 和兼容性测试。
- 如果后续纯视频模型不能听音频，适配器不得默默声称听到了内容。它可以正常回答视觉问题；当问题明确依赖音频时，返回诚实的能力限制说明，但仍使用同一 Tool。
- v1 不承诺兼容上游五 Tool schema；这是独立专项产品接口。

## 契约测试

必须断言：

1. `listTools()` 恰好一个工具且名称正确。
2. JSON schema 只有 `video` 和 `question`。
3. 本地路径和 HTTPS URL 都能走到同一个 Tool handler。
4. Tool 只返回一个 text content。
5. provider 内部字段不会出现在成功或错误文本。
6. 默认 prompt 明确要求画面和声音联合分析。
7. 第二个并发调用稳定返回 `VIDEO_ANALYSIS_BUSY`，不会同时启动另一条大文件上传。
8. 客户端请求 progress 时，本地路径收到上传开始/结束与推理开始；HTTPS 只收到推理开始；成功结果仍是单一 text content。
