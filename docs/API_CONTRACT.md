# MCP Tool 契约

> **2026-09-26 正式发布更新：** `1.0.0` 已通过 Node 24 远程 CI 与 Secret Scan，并经 Trusted Publishing 发布；官方 npm 的 `latest` 为 `1.0.0`，registry 全新安装/stdio 握手与关键构建哈希核对通过。当前安装示例为 1.0.0 / MEDIA_*；下文旧日期状态仅为历史记录。完整证据见 [`tasks/release-1.0.0.md`](../tasks/release-1.0.0.md)。

> **状态（2026-09-25，下一大版本分支）：** 本文件描述本工作区**已实现但尚未发布**的 `analyze_media(media, prompt)`。npm 上的 `analyze-video-mcp@0.6.1` 仍是旧契约 `analyze_video(video, question?)`，其行为见文末 [迁移表](#迁移表旧契约--新契约) 与 git 历史。发布前本文不得被当成已上线证据。目标与边界见 [`SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md`](SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md) 与 [ADR 0024](decisions/0024-agent-directed-media-gateway.md)。

本文件定义 Agent 可见的稳定接口。Provider、模型与上传实现可以替换，但不得修改此契约，除非新增 ADR 并经用户批准。

## Tool 列表

Server 只注册：

```text
analyze_media
```

不注册上游的 `analyze_image`、`analyze_audio`、`analyze_audio_video` 或 `check_endpoint_status`，也不保留 `analyze_video` 作为别名（ADR 0001、ADR 0024 备选方案 3）。

## 输入 schema

```json
{
  "media": "C:\\Users\\user\\Videos\\example.mov",
  "prompt": "只分析 00:30 附近画面与声音是否对应；不确定时直接说明"
}
```

| 字段     | 类型   | 必需 | 默认 | 约束                                                                |
| -------- | ------ | ---- | ---- | ------------------------------------------------------------------- |
| `media`  | string | 是   | 无   | 本地绝对 MP4/MOV/MP3 路径，或无凭证的公开 HTTPS 视频 URL            |
| `prompt` | string | 是   | 无   | trim 后 1–8000 字符；问题本身不重写、不扩写、不截断，只去掉首尾空白 |

Tool schema 不得出现：`max_tokens`、`model`、`provider`、`thinking_budget`、`stream`、`upload`、`audio`、`frames`、`oss_url`、`question`。回答长度按模型自身上限，不给 Agent 旋钮。

`media` 的拒绝规则：相对路径、目录、伪装后缀、`http:`、`file:`、`data:`、含用户名/密码的 URL、localhost 与 obvious loopback/private 字面量。**路径明显以 `.mp3` 结尾的 HTTPS URL 拒绝为未支持的远端音频**（`UNSUPPORTED_MEDIA`，`diagnostics.input_kind=remote_audio`）：本机不抓取远端内容，后缀不构成远端格式证明。其它无法判别的 HTTPS URL 仍按视频直连，这**不代表**其远端格式已被验证。

## Tool 描述语义

描述文本应让 Agent 明确：

```text
只在用户明确要求用 MCP（本工具）分析媒体时才调用；用户只是要你处理媒体而没点名本工具时走宿主自己的流程，不要自动调用。
它把本地 MP4/MOV 视频（画面与内嵌声音一起）、本地 MP3 音频或公开 HTTPS 视频 URL 交给媒体模型分析，返回文本回答。
不要先自行抽帧或抽音频。
prompt 必填：把用户的分析要求写进去；服务端不补写分析提纲，也不改写你的问题。
一次最多 1 小时、本地最大 1024 MiB；这是抽样理解，不是帧级或逐字核验。精确转场请先提供 5–30 秒片段。
本地文件须已获授权：位于 MEDIA_ALLOWED_ROOTS 内，或该安装已开启 MEDIA_ALLOW_ANY_LOCAL_FILE（被拒绝时提示用户改配置，不要换路径重试）。同一本地文件会复用已上传地址；未命中则全量上传。
```

Server-level instructions 与 Tool 描述保持同义，第一句表达“仅在用户明确要求时调用”。

两层指引也要求 Agent 在宿主支持时先保存完整工具结果，只读取 `content` 文本或 `structuredContent.answer` 中的一份；显示截断后先分段读取已保存结果，不要仅因显示截断重新分析。宿主无法保留或取回完整结果时，应明确说明交付限制。这是 Agent 操作指引，不能保证所有宿主执行，也不能提高宿主输出额度。

Codex code-mode 示例（`store` / `load` 为宿主能力，不属于本 MCP）：调用一次后先 `store("media_result", result)`，只打印状态与答案长度；之后 `load("media_result")`，从 `structuredContent.answer` 或文本 content 选择一份，每次读取约 1500 字符并按偏移继续。不要把含两份答案的完整对象直接打印，也不要将显示缺失等同于服务商生成失败。需要原文交付时可由 Agent 写入用户授权的本地文件；本服务端不自动落盘分析正文。

**服务端不注入业务提纲。** 每个请求只附带一条固定的协议性系统说明（`src/bailian.ts` 的 `PROTOCOL_NOTE`）：要求文本回答、只写实际看到或听到的内容、不确定就说明、不要编造。它不规定时间线、构图、色彩、音乐、优缺点、用途建议或任何条数/字数，也不随 prompt 变化。宽泛问题（例如“分析一下”）与具体问题（例如带时间码的核对要求）都按原意发送，服务端不展开、不重写、不追加模板。

调用条件属于**提示词层面的引导**，不是强制机制：宿主是否加载 instructions、模型是否遵守都不由本服务决定。真正可控的是服务端校验与安装配置（`MEDIA_ALLOWED_ROOTS`、`MEDIA_ALLOW_ANY_LOCAL_FILE` 默认关闭、宿主的工具可见性与审批模式），文档不得把提示词写成“保证不会被调用”。

## 成功结果

```json
{
  "content": [{ "type": "text", "text": "模型的回答（经敏感信息脱敏）" }],
  "structuredContent": {
    "ok": true,
    "answer": "模型的回答（经敏感信息脱敏）",
    "media": {
      "kind": "video",
      "container": "mov",
      "duration_seconds": 42,
      "audio_track_present": true
    },
    "request": { "provider": "dashscope", "model": "本次实际模型 ID", "upload_reused": false },
    "usage": { "prompt_tokens": 100, "completion_tokens": 30, "total_tokens": 130 },
    "limitations": [
      "画面与内嵌音频由模型分析，本机未逐帧核验；本地轨道探测只证明文件含可解码音轨，不代表模型确认听到声音。"
    ]
  },
  "isError": false
}
```

规则：

- `content[0].text` 与 `structuredContent.answer` 必须是**同一份**脱敏文本，即模型回答本身；不附加固定审核报告、分项观察、模型名、request id 或耗时。
- 脱敏只在单一出口移除内部 `oss://` 地址、凭证形态与本地绝对路径：先按本次 Agent 传入的确切路径（含两种斜杠与 Windows 大小写变体）做字面替换，再用通用规则补充未传入的路径形状；`普通 HTTPS 链接与媒体语义保留`，不做句子删除、重排、纠错或结论升级。
- 空白回答是错误（`PROVIDER_RESPONSE_INVALID`）。
- **本地 MP3 协议已于 2026-09-25 用真实百炼调用验证**（非私密合成 9 秒样本 + 890 秒真实 MP3，均为 `qwen3.8-omni-flash`；证据见 [`PROVIDER_PROTOCOL.md`](PROVIDER_PROTOCOL.md) §3b）。仍未验证：`MEDIA_MODEL_UNSUPPORTED` 的服务商真实错误码措辞、宿主 GUI、费用金额。
- **已知限制（2026-09-25 实测）：** 只有音频轨、没有视频轨的 MP4 经视频路径提交会被服务商以 **HTTP 400** 拒绝（`MEDIA_ANALYSIS_FAILED` + `http_status=400`，无 SSE 事件与用量）。请为纯音频使用 `.mp3`；不要把它当视频提交。服务端不做自动转封装。
- `media` 只放本次**确实建立**的本地事实；字段缺席表示未知，不能填 `false` 冒充已检查：
  - `kind`：`video` 或 `audio`。本地由已验证的文件内容决定；首批 HTTPS 输入按视频处理。
  - `container`：仅本地格式识别成功时出现（`mp4` / `mov` / `mp3`）。
  - `duration_seconds`：仅本地可靠求出时出现（MP4/MOV 读 `mvhd`；MP3 需流自己声明 Xing/Info/VBRI 帧数）。**不做码率估算**：采样无法证明整个文件恒定码率，错误数字还会驱动一小时门禁；没有声明帧数就不出现。求不出就不出现，也不猜一个数字。
  - `audio_track_present`：仅本地视频轨道探测**完整**时出现（`true` 表示发现受支持音轨，`false` 表示轨道结构完整但确无音轨）。探测不完整时不出现。MP3 不设视频轨或轨道缺失结论，因此该字段不出现。
- `request.provider` 固定为 `dashscope`（首发唯一服务商，不自动跨云回退）。`request.model` 是本次实际模型 id。`request.upload_reused` **仅对本地文件出现**，只陈述本地上传缓存命中，不表示模型记忆、也不表示本次分析免费（每次分析仍可能计费）。HTTPS 没有上传，因此不出现该字段。
- `usage` 只填服务商实际返回的值；缺失字段不补 0，全部缺失时整个 `usage` 不出现。
- 成功结果**不返回 `request_id`**：该字段只在错误结果与 stderr 诊断行中出现（错误路径才需要向服务商核对）。
- `limitations` 只写与本次媒体和已执行检查相符的限制，并按媒体类型区分：视频写“未逐帧核验”，音频写“未逐字转写核验”，HTTPS 写“本机未下载或探测远端内容”。不得把“文件有音轨/已提交音频”写成“模型确实听到”；模型自己说听到也只是模型报告。
- Tool 不流式向 Agent 暴露 provider chunk；内部 SSE 只用于满足 provider 协议并聚合结果。
- 若 Host 在调用时提供 `progressToken`，会依次收到四步进度：`正在校验媒体` → `媒体校验完成` → `上传完成`（HTTPS 跳过）→ `正在等待模型回答` → `分析完成`，`total` 恒为 4。消息不含路径或密钥；无 token 的 Host 仍只收到最终结果。
- 取消（Host 取消请求或进程收到 SIGINT/SIGTERM）返回 `MEDIA_ANALYSIS_CANCELLED`，并释放文件句柄、停止未完成的上传与推理；不会把宿主 60 秒等待超时写成服务商失败。

**每次调用只发起一次模型请求。** 不存在“证据纠错”式第二次付费分析；允许的自动重试只有传输层在**尚未收到任何文本**时对 429/502/503 的一次有限重试（沿用旧契约的同一上限）。

## 错误结果

```json
{
  "content": [{ "type": "text", "text": "MEDIA_TOO_LONG: 媒体时长超过 1 小时上限。" }],
  "structuredContent": {
    "ok": false,
    "code": "MEDIA_TOO_LONG",
    "stage": "authorized",
    "retryable": false
  },
  "isError": true
}
```

允许的 Agent 错误码：

| 错误码                      | 含义                                                                                                                                                                                               | 是否建议 Agent 重试 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `INVALID_MEDIA_INPUT`       | schema 之外的输入问题（含空白/超长 `prompt`、非法 `media` 形式）                                                                                                                                   | 否                  |
| `MEDIA_PATH_NOT_ALLOWED`    | 本地路径未被授权：不在 `MEDIA_ALLOWED_ROOTS` 内，且安装未开启 `MEDIA_ALLOW_ANY_LOCAL_FILE`                                                                                                         | 否                  |
| `MEDIA_NOT_FOUND`           | 文件不存在、不可读或身份复核失败                                                                                                                                                                   | 否                  |
| `UNSUPPORTED_MEDIA`         | 容器/内容无效或类型不支持（含非 MP4/MOV/MP3、MP3 无有效音频帧、远端 `.mp3` URL）                                                                                                                   | 否                  |
| `UNSUPPORTED_MEDIA_CODEC`   | 已识别媒体中的编码组合不支持；`diagnostics.codec` 给出 fourcc（如 `ipcm`）或 MPEG 层（如 `mpeg1-layer2`）。若点名 PCM 且视频轨已受支持，可只把音频转为 AAC 并复制视频轨                            | 否                  |
| `MEDIA_FILE_TOO_LARGE`      | 超过本地或动态 policy 上限                                                                                                                                                                         | 否                  |
| `MEDIA_TOO_LONG`            | 已知时长大于 3600 秒；正好 3600 允许；时长未知则放行（不猜）                                                                                                                                       | 否                  |
| `UPLOAD_POLICY_FAILED`      | 取上传凭证失败或凭证不可用；`diagnostics.parse_reason` 区分 `request_failed` / `http_error`（带 `http_status`）/ `invalid_json` / `shape_mismatch` / `field_type_mismatch` / `upload_host_invalid` | 可稍后重试          |
| `MEDIA_UPLOAD_FAILED`       | 本地上传失败；应改用公开 HTTPS，不要重传原文件                                                                                                                                                     | 否                  |
| `PROVIDER_UNAUTHORIZED`     | API Key 或接口地址无效                                                                                                                                                                             | 否                  |
| `MEDIA_ANALYSIS_BUSY`       | 已有一个媒体任务正在上传或分析                                                                                                                                                                     | 稍后重试            |
| `PROVIDER_RATE_LIMITED`     | 429                                                                                                                                                                                                | 按提示稍后重试      |
| `PROVIDER_TIMEOUT`          | 推理超时                                                                                                                                                                                           | 可重试              |
| `PROVIDER_UNAVAILABLE`      | 502/503 等暂时故障                                                                                                                                                                                 | 可重试              |
| `PROVIDER_RESPONSE_INVALID` | SSE/JSON 不符合契约、中途截断、仅有 reasoning 或空回答                                                                                                                                             | 可重试              |
| `PROVIDER_CONTENT_REJECTED` | 百炼返回 `DataInspectionFailed` / `data_inspection_failed`，表示内容检查拦截；不能据此判定媒体违规。原始服务商消息不透传                                                                           | 否                  |
| `MEDIA_MODEL_UNSUPPORTED`   | 已核对的模型能力配置或服务商**明确**的模态/模型拒绝证明所选模型不支持该输入                                                                                                                        | 否                  |
| `MEDIA_ANALYSIS_CANCELLED`  | 用户或 Host 取消（`stage: aborted`）；已释放资源                                                                                                                                                   | 否                  |
| `MEDIA_ANALYSIS_FAILED`     | 其他已脱敏错误                                                                                                                                                                                     | 视情况              |
| `CONFIG_MISSING`            | 启动后调用时仍缺 Key 等配置；`missing` 列出变量名                                                                                                                                                  | 否                  |

补充规则：

- 已知内容检查拒绝保持**不可自动重试**，也不自动触发重复上传或分析；不根据拒绝推断用户媒体违规。
- `MEDIA_MODEL_UNSUPPORTED` 只在服务商明确返回已核对的模态/模型拒绝错误码时使用（`src/provider-error.ts` 的固定 allowlist）。未知模型能力**不等于**已证明不支持；不得靠“回答没提到声音”推断此错误。该 allowlist 目前只由 mock 固定，真实服务商措辞仍需 live 核对。
- SSE 的 `id`（如 `chatcmpl-…`）是补全 ID，**不当作 Request ID**；只有响应 Header 或正文中显式且符合安全格式的 `request_id` 才会出现在 `structuredContent.request_id`。
- 内容检查拒绝的 `diagnostics.inspection_side` 仅为 `input` / `output` / `unknown`，只从已知固定措辞判断。
- 缺 Key 或坏配置不得阻止 MCP `initialize` / `listTools`；工具调用时返回 `CONFIG_MISSING`。
- `analyze-video-mcp --doctor --json` 与运行时共用同一配置解析器，绝不打印 Key，并报告旧媒体变量已失效。

Agent 错误文本禁止包含：API Key 或任何首尾片段、policy/signature/临时 AccessKey、`oss://` 全路径、上传 host 的 query、本地绝对路径、provider 原始响应体。完整诊断只能写 stderr，且同样必须脱敏；允许记录错误码、HTTP 状态、阶段、request id、耗时和文件大小。

## 迁移表：旧契约 → 新契约

| 旧（`analyze-video-mcp@0.6.1`）                          | 新（本分支，未发布）                                       | 条件                              |
| -------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------- |
| `analyze_video(video, question?)`                        | `analyze_media(media, prompt)`，`prompt` 必填              | Tool 名称与字段均变更，不并列保留 |
| 省略 `question` 时用服务端默认问题                       | 无默认问题；`prompt` 空则 `INVALID_MEDIA_INPUT`            | 服务端不再替 Agent 提问           |
| 宽泛请求追加九段分析提纲                                 | 只追加固定协议说明，无业务提纲                             | 服务端不再展开问题                |
| 强制证据 JSON + 失败时二次纠错请求                       | 不做 JSON 强制解析，不产生第二次付费请求                   | 旧报告层与纠错已移除              |
| `INVALID_VIDEO_INPUT`                                    | `INVALID_MEDIA_INPUT`                                      | 输入无效、路径/URL 形式错误       |
| `VIDEO_PATH_NOT_ALLOWED`                                 | `MEDIA_PATH_NOT_ALLOWED`                                   | 本地访问未授权                    |
| `VIDEO_NOT_FOUND`                                        | `MEDIA_NOT_FOUND`                                          | 不存在、不可读或身份复核失败      |
| `UNSUPPORTED_VIDEO`                                      | `UNSUPPORTED_MEDIA`                                        | 容器/内容无效或类型不支持         |
| `UNSUPPORTED_VIDEO_CODEC`                                | `UNSUPPORTED_MEDIA_CODEC`                                  | 已识别媒体中的编码组合不支持      |
| `VIDEO_FILE_TOO_LARGE`                                   | `MEDIA_FILE_TOO_LARGE`                                     | 本地文件超过有效上限              |
| `VIDEO_TOO_LONG`                                         | `MEDIA_TOO_LONG`                                           | 已知时长超过上限                  |
| `VIDEO_UPLOAD_FAILED`                                    | `MEDIA_UPLOAD_FAILED`                                      | 本地上传失败                      |
| `VIDEO_ANALYSIS_BUSY`                                    | `MEDIA_ANALYSIS_BUSY`                                      | 已有分析占用当前服务实例          |
| `VIDEO_ANALYSIS_FAILED` + `stage=aborted`                | `MEDIA_ANALYSIS_CANCELLED`（`retryable:false`）            | 用户或 Host 取消                  |
| 其它 `VIDEO_ANALYSIS_FAILED`                             | `MEDIA_ANALYSIS_FAILED`                                    | 未归入更具体错误                  |
| （无）                                                   | `MEDIA_MODEL_UNSUPPORTED`                                  | 已证明模型不支持该模态            |
| `UPLOAD_POLICY_FAILED` / `PROVIDER_*` / `CONFIG_MISSING` | 同码保留                                                   | 行为不变                          |
| `coverage` / `subtitle_audit` / 分项观察等结构化字段     | `media` / `request` / `usage` / `limitations`              | 旧报告层字段整体移除              |
| `QWEN_ALLOWED_ROOTS`                                     | `MEDIA_ALLOWED_ROOTS`（旧变量不再授予访问，doctor 会提示） | 显式迁移，不静默继承              |
| `QWEN_ALLOW_ANY_LOCAL_VIDEO`                             | `MEDIA_ALLOW_ANY_LOCAL_FILE`（默认 `off`）                 | 显式迁移；不再有“任意视频”语义    |
| `QWEN_MAX_LOCAL_VIDEO_MB`                                | `MEDIA_MAX_LOCAL_MEDIA_MB`                                 | 上限仍为 1024 MiB 硬顶            |
| `QWEN_AUDIO_SILENCE_CHECK`                               | 移除；该变量不再生效                                       | 本地 FFmpeg 数字静音核对已退出    |

## 兼容性规则

- 后续更换模型或上传器时，Tool 名称、输入字段与成功输出不变。
- 增加可选字段也视为公开 API 变更，需要 ADR 和兼容性测试。
- 如果所选模型不能处理某种输入，适配器不得默默声称分析过该模态；应返回 `MEDIA_MODEL_UNSUPPORTED` 或保留模型自己的不确定性表述，不得把“没读到音频”包装成成功结论。
- 不承诺兼容上游五 Tool schema；这是独立专项产品接口。

## 契约测试

必须断言（见 `test/tools.test.ts`、`test/boundary-matrix.test.ts`）：

1. `listTools()` 恰好一个工具且名称为 `analyze_media`。
2. JSON schema 只有 `media` 与 `prompt`，且两者都必需；不出现 provider/model/预算类字段。
3. instructions 与 Tool 描述都不含业务提纲关键词，且都包含“仅在用户明确要求时调用”与“prompt 必填”。
4. 宽泛问题与具体问题都逐字送达 provider，且每次调用只请求一次。
5. 空白与超长 `prompt` 被拒且不调用 provider。
6. Tool 只返回一个 text content，且 `content[0].text === structuredContent.answer`。
7. 路径、Key、`oss://` 不出现在文本或结构化结果中。
8. 本地 MP4/MOV 与 MP3 端到端（mock provider）成功，MP3 走 `input_audio` + OSS resolve Header。
9. HTTPS 只收到校验与等待/完成进度；本地文件额外收到上传完成。
10. 第二个并发调用稳定返回 `MEDIA_ANALYSIS_BUSY`，不会同时启动另一条大文件上传。
11. 取消返回 `MEDIA_ANALYSIS_CANCELLED` 且 `stage=aborted`。
12. `MEDIA_MODEL_UNSUPPORTED` 只在明确模态拒绝时出现，未知错误码保持 `MEDIA_ANALYSIS_FAILED`。
