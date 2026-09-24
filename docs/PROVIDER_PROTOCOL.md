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
GET https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen3.8-omni-flash
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
- 这两个字段官方字段表写成字符串、示例响应写成数字，因此实现接受**数字或数字字符串**（`"300"` 与 `300` 等价），只拒绝空值、非数字和 ≤0。
- 上传与推理必须使用同一个模型 id、同一账号的 API Key。
- policy API 有每账户每模型 100 QPS 限制；不缓存 credential，也不并发预取。已成功上传的 `oss://` 可在同一进程内按文件身份 + 模型复用约 47 小时，见 [ADR 0013](decisions/0013-upload-cache-and-host-server-name.md)。

2026-08-15 真实验证：`qwen3.5-omni-flash` 返回的 `max_file_size_mb` 为 `1024`，因此 500 MiB 项目上限可行。实现仍须动态检查，不能把 1024 当常量。

## 1b. 取凭证失败的诊断码

`UPLOAD_POLICY_FAILED`（`stage=policy_acquired`）只是一个对外错误码，实际原因放在结构化错误的 `diagnostics` 里，便于区分而不泄露 Key、凭证或路径：

| `parse_reason`        | 含义                                      | 附加字段      |
| --------------------- | ----------------------------------------- | ------------- |
| `request_failed`      | fetch 抛错（DNS/TLS/网络/超时）           | —             |
| `http_error`          | HTTP 非 2xx                               | `http_status` |
| `invalid_json`        | 响应体不是 JSON                           | —             |
| `shape_mismatch`      | 缺少字段或结构不符                        | `field`       |
| `field_type_mismatch` | 字段存在但类型/取值不符（含两个数字字段） | `field`       |
| `upload_host_invalid` | `upload_host` 不是可用的 HTTPS 地址       | `field`       |

`field` 只允许 `data.<小写下划线字段名>` 形状；原始响应体、credential、API Key 与绝对路径永远不进诊断。

300 秒 credential 对慢速上行是现实约束：500 MiB 若要在 300 秒内传完，持续有效上行约需 14 Mbit/s，且还需协议开销。Gate 4 必须记录真实上传耗时；若用户网络无法满足，不应通过重复重试掩盖，后续改用正式 OSS 预签名上传。

## 1c. 本地容器与编码（MOV 直传）

2026-09-22 结论（**文档检索所得，未用真实调用验证**，付费 live 未获授权）：

- 百炼视频输入的支持格式列表包含 MOV（错误码文档写“视频支持 mp4、avi、mov”），因此本项目按**直传**实现：`.mov` 原样上传，multipart 文件名 `video.mov`、Content-Type `video/quicktime`，对象 key 用随机 UUID + `.mov`。不调用外部转码器，也不引入 FFmpeg 运行时依赖。
- 编码只在本地做抽样 fourcc 校验（`moov/trak/mdia/hdlr` + `stbl/stsd`）：视频 `avc1`/`avc3`/`hvc1`/`hev1`，音频 `mp4a`。其它组合以 `UNSUPPORTED_VIDEO_CODEC` 在上传前拒绝并点名 fourcc；未做真实解码验证，允许集取自常见支持范围，参考样本 `星空.mov`（`qt  ` + `avc1` + `mp4a`，16.1 秒）走真实校验通过。
- **兜底方案（人工，不在产品里）**：若真实调用拒绝 MOV 或某个编码，用户可先无损转封装再调用：`ffmpeg -i input.mov -c copy -movflags +faststart output.mp4`。依赖与清理要求：ffmpeg 由用户自行安装（不是本包依赖，缺失时不影响其它功能）；输出写到用户指定目录，失败或中断时由用户删除临时文件；本项目不自动创建、清理或上传转码产物。真实验证需要用户明确授权的一次付费调用。
- 待验证项：MOV 与 `hvc1` 是否被真实接口接受（本次只验证了本地校验与上传元数据）；建议首次真实验证用一个短 MOV 片段，观察 `PROVIDER_*` 错误码。

## 1d. 默认模型与思考模式（2026-09-22）

- 默认模型改为 `qwen3.8-omni-flash`（可用 `QWEN_MODEL` 覆盖；Tool 字段不变）。检索结果称该 id 支持文本/图片/音频/视频输入、仅文本输出，并且可用 `dashscope.aliyuncs.com/compatible-mode/v1` 调用；北京地域另有业务空间专属域名 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，本项目仍用公共端点。**API Key 按地域绑定**，跨地域调用返回 401（对应 `PROVIDER_UNAUTHORIZED`）。
- 该模型**思考默认开启**。两种流形态都要能处理：`delta.reasoning_content` 单独字段（本项目忽略它，只取 `delta.content`），以及把思考写进 `delta.content` 的 `<think>…</think>` 包裹（本项目在聚合后剥掉该块；若剥完没有正文，返回 `PROVIDER_RESPONSE_INVALID` / `parse_reason=reasoning_only`）。
- 未添加任何思考相关参数（不加 `enable_thinking`、`thinking_budget`、`video_fps` 等）；payload 仍是 `video_url` + `modalities:["text"]` + `stream:true` + `stream_options.include_usage`，与官方 OpenAI 兼容示例一致。
- 待验证项：新默认模型的真实调用（含思考流下的正文完整性、`usage` 是否有值）需要用户授权的付费 live；本次只有 mocked SSE 覆盖。

## 1e. 音频未被利用与原始 JSON（2026-09-22 实测发现）

- 实测：MOV 直传成功（`qwen3.8-omni-flash`，约 196 秒、811 个流式事件）；同批另一条 MP4 真实调用返回了时间线，但**回答称无法确认音轨**，而文件确有 AAC 音轨且本地测得非零信号，同时 `coverage.audio_analyzed=true`。三条可能原因（模型未利用音轨 / 采样忽略 / 提示词过保守）无法从现有证据区分，因此本轮只做“不再超额声明 + 明确告知模型 + 写出限制”，不宣称根因。
- 措施一：把本地已确认的容器与轨道事实写进 user 轮（`buildUserQuestion` 的本地事实行），并明确要求“音轨存在却没听到时，说清是近似静音还是无法判断，不要写成没有声音”。
- 措施二：`coverage` 拆成三组（本地事实 / 请求层 / 报告层，见 [`API_CONTRACT.md`](API_CONTRACT.md)），`audio_analyzed` 在无音轨时为 `false`；新增 `audio_observed` / `video_observed`；不匹配时写入 `coverage_limitations`。
- 措施三：真实调用中出现过“文本以原始 JSON 开头”，成因是证据 JSON 不完整时走了散文兜底（`src/server.ts`）。现改为：先 `salvageJsonAnswer` 取回 `answer` 与可解析的分项，再考虑真正的散文，最后才是 `PROVIDER_RESPONSE_INVALID` / `parse_reason=json_without_answer`——原始 JSON 不再作为用户可见回答。
- 2026-09-23 补充实测与修正：同文件《AE海-通义.mp4》重跑（109 秒）显示 `model=qwen3.8-omni-flash`、文本已不再以 JSON 开头，但模型仍只给出 `evidence=uncertain` 的音频条目。**发现并修复了本项目自己的判定错误**：`buildCoverage` 原来按“数组是否非空”判 `audio_observed` / `video_observed`，现在改为按证据类型（画面需 `seen` 或 `cross_validated`，声音需 `heard` 或 `cross_validated`；`inferred` / `uncertain` 不算），限制文案也区分“完全没有条目”与“只有待确认/推断类条目”。
- 同批受控证据：仓库 3 秒夹具的真实调用**同时**识别出预设画面数字与语音数字，说明当前链路（`qwen3.8-omni-flash` + `video_url` + 内嵌音频）并非读不到音频。因此《AE海-通义.mp4》仍表述为未定位：该素材 ffmpeg 测得 mean −30.5 dB、max −17.1 dB，偏安静，需一次同文件对照（例如裁 5–15 秒或明确静音段）才能区分“模型未利用音轨 / 采样忽略 / 音量偏低”。
- 2026-09-23 Codex 三条件付费对照（同一问题、`qwen3.8-omni-flash`、当前 `dist`；素材全长约 5.37 秒）：原片返回 `audio_observed=false`，音频条目均为 `uncertain`；画面码流不变、音轨提高 12 dB 的临时版本（mean −18.5 dB、max −5.1 dB）仍返回 `audio_observed=false`；画面码流不变、临时换入已验证的夹具语音音轨后，模型给出 `heard` 并准确转写“三点一四一五九二六”，`audio_observed=true`。三份视频的画面码流 SHA-256 相同；原片和增强版均有 AAC 音轨及非零音频信号。**结论限于本素材与这次提示词**：简单增益不能使原音轨被模型确认；相同画面与上传链路可以传递并识别清晰语音。原音轨究竟是什么声音、为何未被模型确认仍未定位；不能由该对照推定原片静音，也不能推定模型完全忽略音频。临时派生文件位于系统临时目录，未加入仓库。
- 同日无付费反例复核：仅有一条 `visual=uncertain` 与一条 `audio=cross_validated` 时，`collectViolations=[]` 且 `audio_observed=true`。当前 `cross_validated` 只要求另一侧数组非空，缺少确认性声画配对校验；此项仍是待修的判定缺口，不把 `cross_validated` 计入可靠观察的验收结论。
- 2026-09-23 同一反例的修复：`cross_validated`（声画一致）此前只要求另一侧数组非空，因此“`visual=uncertain` + `audio=cross_validated`”能通过校验且被判为观察。现收紧为**确认性配对**——`cross_validated` 条目要求对面模态存在直接确认条目（画面需有 `seen`，声音需有 `heard`）；不满足时就地降级为 `inferred`（保留信息、不再作为观察依据）；两侧互相 `cross_validated` 而没有任何确认条目按循环论证处理。同时 `audio_observed` / `video_observed` **不再把 `cross_validated` 计入**——该标记只表示直接确认的观察，`cross_validated` 在配对校验被真实证据证明可靠之前不进验收结论。
- 同日在系统提示（`EVIDENCE_POLICY`）里补上配对规则：`cross_validated` 必须由对应模态的直接 `seen`/`heard` 条目支撑，否则写 `inferred`/`uncertain`——避免模型产出无配对依据的条目而白吃一次纠错重试。
- 2026-09-23 清理顺序漏检（用户无付费复核发现）：配对校验原先用**清理前**的确认集合，因此“一条 `seen` 因描述含『似乎』被清除 + 同报告 `audio=cross_validated`”会出现清理前 `collectViolations=["visual"]`、清理后反而 `["audio"]` 的顺序不一致。已修：确认集合改为只认**清理后仍有效**的条目（自洽判定抽成 `itemIsSelfConsistent`，校验与清理共用），`sanitizeEvidenceReport` 改为两阶段（先各自清理、再按幸存者判配对），输出成为不动点（再收集无违规、再清理结果不变），并用清理顺序回归测试守住。
- 2026-09-23 证据冲突信号（用户复核发现）：容器无音轨时模型仍可能报告 `heard`，此前 `audio_observed=true` 且没有任何矛盾提示，作为用户可读的覆盖结果会误导。现新增 `coverage.evidence_conflicts`：本地探测与模型声明矛盾时（声称听到但无音轨、声称看到但无视频轨），该声明不计入 `observed`，写入冲突列表并附一条限制提示；措辞同时保留“文件确实没有该轨道”与“本地探测未能读取轨道结构”两种可能，不据此断定模型编造。HTTPS 不做本地探测，不产生冲突判定。
- 取凭证 `request_failed` 本轮再次出现两次，均重试后恢复；仍记为瞬时网络失败，未定位。

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
