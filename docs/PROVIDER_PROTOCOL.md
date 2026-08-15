# DashScope 上传与 Qwen Provider 协议

本文件是实现协议的单一参考。官方文档可能变化；若 live 结果与本文冲突，保存脱敏证据并在 Gate 停下，不要静默兼容。

官方来源：

- [临时文件上传](https://www.alibabacloud.com/help/en/model-studio/get-temporary-file-url)
- [Qwen-Omni API](https://www.alibabacloud.com/help/en/model-studio/qwen-omni)
- [Omni 模型列表](https://www.alibabacloud.com/help/en/model-studio/omni/)

核对日期：2026-08-15。

## 1. 获取临时上传 policy

请求：

```http
GET https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen3.5-omni-flash
Authorization: Bearer <DASHSCOPE_API_KEY>
Content-Type: application/json
```

需要以 Zod 验证的响应字段：

```text
request_id
data.policy
data.signature
data.upload_dir
data.upload_host
data.expire_in_seconds
data.max_file_size_mb
data.oss_access_key_id
data.x_oss_object_acl
data.x_oss_forbid_overwrite
```

约束：

- `upload_host` 必须是 HTTPS。
- `expire_in_seconds` 必须为正数；实测为 300 秒，不能硬编码。
- `max_file_size_mb` 必须为正数；在上传任何字节前与文件大小比较。
- 上传与推理必须使用同一个模型 id、同一账号的 API Key。
- policy API 有每账户每模型 100 QPS 限制；v1 不缓存 credential，也不并发预取。

2026-08-15 真实验证：`qwen3.5-omni-flash` 返回的 `max_file_size_mb` 为 `1024`，因此 500 MiB 项目上限可行。实现仍须动态检查，不能把 1024 当常量。

300 秒 credential 对慢速上行是现实约束：500 MiB 若要在 300 秒内传完，持续有效上行约需 14 Mbit/s，且还需协议开销。Gate 4 必须记录真实上传耗时；若用户网络无法满足，不应通过重复重试掩盖，后续改用正式 OSS 预签名上传。

## 2. multipart 流式上传

POST 到 `data.upload_host`，字段名必须与官方协议一致：

```text
OSSAccessKeyId        = data.oss_access_key_id
Signature             = data.signature
policy                = data.policy
x-oss-object-acl      = data.x_oss_object_acl
x-oss-forbid-overwrite= data.x_oss_forbid_overwrite
key                   = data.upload_dir + "/" + safe random object name
success_action_status = "200"
file                  = streamed MP4 bytes
```

实现要求：

- `file` 为最后一个 multipart 字段。
- 对象名用随机 UUID 加 `.mp4`，不携带本地目录或原文件名。
- 文件流来自已授权的同一个 `FileHandle`。
- 不使用 Base64，不使用整文件 `readFile()`，不构造整文件 Blob。
- 使用随机、不可从用户输入注入的 boundary。
- 如果设置 `Content-Length`，必须精确包含所有 boundary、CRLF、字段 header 和文件字节。
- 上传 HTTP 200 才算成功；其他状态读取有限长度的错误摘要后立即丢弃，原始响应不得返回 Agent。
- v1 不自动重传失败的大文件。

成功后内部生成：

```text
oss://<key>
```

该 URL 48 小时有效并自动删除；不存在显式删除/查询/下载管理接口。

## 3. 推理请求

端点：

```http
POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
Authorization: Bearer <DASHSCOPE_API_KEY>
Content-Type: application/json
Accept: text/event-stream
X-DashScope-OssResourceResolve: enable   # 仅 oss:// 输入需要
```

请求体：

```json
{
  "model": "qwen3.5-omni-flash",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "<question>" },
        { "type": "video_url", "video_url": { "url": "<https-or-oss-url>" } }
      ]
    }
  ],
  "modalities": ["text"],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

不得发送 `thinking_budget`、`enable_thinking`、audio output 配置、抽帧参数或第二份音频。Qwen3.5-Omni 视频输入本身支持视频内嵌音轨。

官方当前说明：

- `qwen3.5-omni-flash` HTTP 输入支持文本、音频、图像、视频；Thinking 不支持。
- Qwen3.5-Omni URL 视频最大 2 GB、最长 1 小时。
- Base64 编码串必须小于 10 MB，因此不是本项目本地文件主路径。
- 官方示例要求 `stream: true`。

## 4. SSE 聚合

解析器处理字节流，不假设一个网络 chunk 等于一行或一个事件。

算法要求：

1. 用流式 `TextDecoder` 保留 UTF-8 半字符。
2. 以空行分隔 SSE event，兼容 `\n\n` 和 `\r\n\r\n`。
3. 一个 event 内的多个 `data:` 行按 SSE 规则拼接。
4. `data: [DONE]` 标记正常结束。
5. JSON event 用 Zod 最小校验。
6. `choices` 为空但有 `usage` 时记录内部用量并继续。
7. 将 `choices[0].delta.content` 的字符串片段顺序拼接。
8. 空 delta、角色 delta、finish-only chunk 合法。
9. 支持一个读取块包含多个 event，也支持一个 event 跨多个读取块。
10. clean EOF 只有在看到 `[DONE]` 或明确 terminal `finish_reason` 后才成功；否则视为截断。
11. 完成文本 trim 后为空，返回 `PROVIDER_RESPONSE_INVALID`。

若未来 provider 将 `delta.content` 改为数组，必须先增加 schema 和 fixture，再兼容；不能用不受控 cast。

## 5. 超时与重试

### 上传

- 独立 `QWEN_UPLOAD_TIMEOUT`。
- 超时关闭请求和 FileHandle。
- 不自动从头重传。

### 推理

- 独立 `QWEN_ANALYSIS_TIMEOUT`，覆盖连接和整个 SSE 生命周期。
- 仅对 429、502、503 或连接失败，在“尚未收到任何内容”时重试至多一次。
- 尊重 `Retry-After`，等待上限 30 秒；没有 header 时使用带 jitter 的短退避。
- 收到任意有效 delta 后失败，不重试，避免重复计费和拼接重复内容。
- 重试复用已上传的 `oss://`，不重新上传。

## 6. 诊断元数据

内部可记录：

```text
stage
request_id
http_status
elapsed_ms
input_kind
size_bytes
retry_count
received_sse_events
```

禁止记录：API Key、Authorization header、policy、signature、AccessKey、完整 `oss://`、原始绝对路径和 provider 完整错误体。
