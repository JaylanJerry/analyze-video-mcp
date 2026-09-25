# DashScope 上传与 Qwen Provider 协议

> **下一大版本分支（未发布）变更：** 本文件既记录仍有效的传输协议，也保留旧报告层的历史实测。当前代码（`analyze_media`）的推理请求见下方 [§3 推理请求](#3-推理请求) 与新增的 [§3b 音频输入](#3b-音频输入input_audio)；`EVIDENCE_POLICY` 系统提示、证据 JSON 门禁、纠错二次请求与 FFmpeg 数字静音核对**已从代码移除**，相关小节仅作历史记录，不代表当前行为。

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
- **兜底方案（人工，不在产品里）**：若只有音频为 PCM、视频已是支持的 H.264/H.265，可保留视频流并将音频转成 AAC：`ffmpeg -i input.mov -map 0:v:0 -map 0:a:0? -c:v copy -c:a aac -b:a 192k -movflags +faststart output.mp4`。`-c copy` 只转封装，不会把 PCM 转成 AAC。若视频编码也不受支持，需重新编码视频轨。ffmpeg 由用户自行安装（不是本包依赖）；输出写到用户指定目录，本项目不自动创建、清理或上传转码产物。
- 待验证项：MOV 与 `hvc1` 是否被真实接口接受（本次只验证了本地校验与上传元数据）；建议首次真实验证用一个短 MOV 片段，观察 `PROVIDER_*` 错误码。

## 1d. 默认模型与思考模式（2026-09-22）

- 默认模型改为 `qwen3.8-omni-flash`（可用 `QWEN_MODEL` 覆盖；Tool 字段不变）。检索结果称该 id 支持文本/图片/音频/视频输入、仅文本输出，并且可用 `dashscope.aliyuncs.com/compatible-mode/v1` 调用；北京地域另有业务空间专属域名 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，本项目仍用公共端点。**API Key 按地域绑定**，跨地域调用返回 401（对应 `PROVIDER_UNAUTHORIZED`）。
- 该模型**思考默认开启**。两种流形态都要能处理：`delta.reasoning_content` 单独字段（本项目忽略它，只取 `delta.content`），以及把思考写进 `delta.content` 的 `<think>…</think>` 包裹（本项目在聚合后剥掉该块；若剥完没有正文，返回 `PROVIDER_RESPONSE_INVALID` / `parse_reason=reasoning_only`）。
- 未添加任何思考相关参数（不加 `enable_thinking`、`thinking_budget`、`video_fps` 等）；payload 仍是 `video_url` + `modalities:["text"]` + `stream:true` + `stream_options.include_usage`，与官方 OpenAI 兼容示例一致。
- 待验证项：新默认模型的真实调用（含思考流下的正文完整性、`usage` 是否有值）需要用户授权的付费 live；本次只有 mocked SSE 覆盖。

## 1e. 音频未被利用与原始 JSON（2026-09-22 实测发现）

> **历史记录：** 本节及下方第 7、8 节的修复都针对**已移除**的旧证据报告层（强制证据 JSON、纠错二次请求、coverage 判定、静音文案改写）。其中关于模型是否利用内嵌音轨的实测观察仍有参考价值，但描述的重写逻辑不再存在于代码中。

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
- 2026-09-23 当前工作树 MCP 原片实测（用户授权的一次调用）：`qwen3.8-omni-flash`，约 62 秒，MP4 / H.264 (`avc1`) + AAC (`mp4a`)，request id `chatcmpl-cde1cb69-aa49-97be-8c5d-a6b7da27cd4d`，耗时 181,178 ms、2,673 个 SSE 事件。明确询问对白、旁白、音乐和音效后，模型返回 `audio_analyzed=true`、`audio_observed=false`，唯一音频条目为 `uncertain`，说明对白、旁白、音乐、音效均无法判断，且不能断言静音；画面为直接观察。结果文本也把枪响、脚步、配乐等明确标为画面推断，未冒充实听。另一次较宽泛提问耗时 234,420 ms（request id `chatcmpl-362268de-11e1-9fdb-94f7-7fd42c552514`），用于确认完整 MCP 调用时长，不把首 240 字的脚本预览作为内容证据。本节下方的短片和换模型对照补充了差异：工具链能传入可识别的控制语音，qwen3.5 也对原音短片报告了声音观察；qwen3.8 对原音仍只给 uncertain。不能据此判断原片静音，也不能断定 qwen3.5 所述的每种声音都真实存在；准确音轨内容尚待独立复核。
- **2026-09-23 62.9 秒素材短片对照**（当前 `dist`，同一明确音频问题；派生文件只在系统临时目录）：从 20–30 秒裁得 10.10 秒 H.264/AAC 原音片段。`qwen3.8-omni-flash` request id `chatcmpl-8395eed5-d802-997f-9651-8be75feaff8e`，141,720 ms、571 个 SSE 事件；`audio_analyzed=true` 但 `audio_observed=false`，只有 `uncertain`，模型称可用数据仅有视频帧。把同一视频码流（两段解复用后的 H.264 SHA-256 均为 `9AF39162CFD635446466953CF85169697E1F455F8077E8362DAF72D39C7F68D7`）配上仓库已验证语音夹具音轨后，再用同一 qwen3.8 调用，request id `chatcmpl-7682b9e0-78ff-9472-a31f-0c9d03fc3c67`，118,483 ms、1,157 个事件；模型报告听到并多次转写 `3.1415926`，`audio_observed=true`。这证明本次本地文件上传与视频输入协议能够传递可识别音频，但不能证明原音轨内容。
- **用户真值、模型报告与本地测量分开记录**：用户确认原片“只有背景音，是一首歌，没有人说话”，这排除口语/对白/旁白，但不排除歌曲中有人声演唱。qwen3.5-omni-plus 的本机任务记录保存了完整结构化音频条目及至 900 字的回答摘要；摘要写“整个视频片段都伴随着一首节奏强劲的电子舞曲，其中包含男声演唱”，结构化条目还将类似激光声、枪械上膛声、多次枪声列为 `heard`。其中“有一首歌”与用户真值一致，“男声演唱”没有被真值确认或排除（不能改写成口语），枪械/激光音效也未被独立核实。qwen3.8-omni-flash 对原音片段只给 `uncertain`，回答摘要称可用数据仅有视频帧，因此漏掉用户确认存在的背景歌曲。FFprobe 确认诊断片段为 10.10 秒 H.264 视频 + 44.1 kHz 双声道 AAC；对该片段只读 `volumedetect` 得 mean −12.3 dB、max 0.0 dB，`silencedetect`（−45 dB、至少 0.5 秒）未报告静音段。这些是轨道/信号事实，不证明歌声、口语或音效内容。结论：qwen3.8 在这次样本漏报背景歌；qwen3.5 的歌曲判断吻合用户确认，但其歌声与音效细节仍待核听，不能宣称完整准确，也不能据目前真值称男声歌唱有误。`audio_observed=true` 仅表示通过规则检查的模型 `heard` 报告存在，不表示与用户真值一致或经过独立听音；文本分项现明确写“模型报告听到”。不对单个样本硬编码内容，也不全局降级 `heard`。
- **2026-09-23《误时铺》长片音频复核**：原始 416.27 秒 MP4 为 H.264 + PCM (`ipcm`)，在上传前按既有编码策略拒绝；临时兼容版 H.264 + AAC（416.277 秒、47.7 MB）由 qwen3.8 完成分析，但 `audio_analyzed=true`、`audio_observed=false`。完整回答明确未确认可听内容，也把匹配画面的对白视作字幕/推断，不能据此断言静音。首 30 秒 MCP 调用列出机械声、脚步和纸张声；这些条目若未被独立听核，仍不能视为真值。34–66 秒对白段 qwen3.8 返回 5 条 `heard`，同时字幕显示对应文字；对同一音频的本地 Whisper base 转写出其中 4 条，说明片段音轨确有语音，但由于字幕与模型内容重合，这不能单独证明 Qwen 的对白结论来自音轨。217–250 秒雨声段仍为 `audio_observed=false`；本地测得的 −24.7 dB 均值是信号电平信息，不足以确认雨声、音乐或静音。此次样本显示长片与局部结果不一致，暂不能归结为单一音量或上传问题；若要分辨字幕泄漏与真实听音，下一项有价值的对照应保留相同音频而遮挡画面文字。临时片段仍在系统临时目录，本轮尚未生成遮字幕版本或发起该对照。

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

### 3b. 音频输入（`input_audio`）

纯音频（本地 MP3）走同一 Chat Completions 端点，但内容块换成音频类型：

```json
{
  "type": "input_audio",
  "input_audio": { "data": "<oss://…>", "format": "mp3" }
}
```

- `data` 使用本地上传得到的 `oss://` 临时引用，因此同样需要 `X-DashScope-OssResourceResolve: enable`。
- `format` 固定为 `mp3`；本版本只接受 MPEG Layer III（见 `src/mpeg-audio.ts`）。
- 本地音频上传的 multipart 文件名为 `audio.mp3`、Content-Type 为 `audio/mpeg`，对象 key 仍是随机 UUID + `.mp3`。
- 仍然不得发送 `thinking_budget`、`enable_thinking`、audio output 配置或第二份媒体。

**验证状态（2026-09-25，已 live 验证组合可用）：** `input_audio` + 临时 `oss://` + `X-DashScope-OssResourceResolve: enable` 已在默认地域用 `qwen3.8-omni-flash` 完成真实调用：

- 非私密合成样本（9.04 秒、440 / 880 / 1760 Hz 三段递增音调、72,559 B）同一进程内连续两次调用都成功（`is_error:false`），模型准确回答“三段、依次升高、每段约 3 秒”；`usage` 188/474/662 与 188/725/913，SSE 事件 179 与 239，request id `2da18856-09e4-9afd-9e0e-1e1546dc3f2f` 与 `d52ed864-89d8-967d-9184-b23bbcfc7b01`；第二次返回 `upload_reused:true` 且仍完成了一次新的分析。**同一份 72,559 B 样本的第三次调用（2026-09-25，ZCode 宿主会话，`usage` 274/1522/1796、`upload_reused:true`——大小一致且缓存键为 `路径|大小|mtime`，说明该文件先前已上传过）把段数报成 4 段、切换点报成 2/5/8 秒。** 本机独立测量（`ffprobe` 的 `aspectralstats=measure=centroid`、8192 窗，纯本地测量，不经过服务端）显示这份文件只有 **3 个平台区 ≈461 / 900 / 1778 Hz**（即上述 440 / 880 / 1760 Hz，centroid 略高于基频），各约 2.79 秒，切换点在 ≈2.9 秒与 ≈5.9 秒。因此模型对“纯正弦音、无人声、依次升高”的判断正确，**但段数与切换时间不可靠**：同一文件先前两次的“三段”结论只是当时的单次结果，不能当作模型的稳定行为。
- 另一份 890 秒真实 MP3（7.12 MiB）成功：`usage` 6350/1541/7891、575 个 SSE 事件、约 22 秒，`media.kind=audio`、`duration_seconds=889.99`，回答与音频内容一致。
- 脱敏核验：这些运行的 stderr 与回答正文都不含 `oss://`、密钥或本地路径；`text_has_path=false`、`stderr_has_oss=false`、`stderr_has_sk=false`。

**仍未验证：** `MEDIA_MODEL_UNSUPPORTED` 的服务商真实错误码措辞（allowlist 目前只有 mock 证据）；Codex 新会话手动拖入与 Codex 宿主 MOV/MP3 调用；费用金额（按服务商计费，本项目不记录账单）。Codex 当前任务已用公开 MP4 夹具、ZCode 宿主会话已用同码流 MOV 与本节这份 72,559 B MP3 各完成过真实 `analyze_media` 调用，见 [`../tasks/todo-next-major-media-gateway.md`](../tasks/todo-next-major-media-gateway.md) D4；这些都不能推定 Codex 侧路径已验收。

**模型能力实测（2026-09-25，同一 MP3 样本，3 次调用）：**

| 配置                                 | 服务商行为                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qwen3.8-omni-flash`（默认）         | 正常读取音频：`prompt_tokens=188`，回答正确                                                                                                                                                                                                                                                                                 |
| `qwen-plus`（纯文本）                | **不报错**：`prompt_tokens=78`、`completion_tokens=3`、回答仅「听不清。」。**对照测量（2026-09-25）**：同一模型、同一 system 说明与问题、**去掉媒体块**的请求得到完全相同的 `prompt_tokens=78`、`completion_tokens=3` 与同一句回答，即该音频块对这个模型/端点**没有贡献任何输入 token**（同模型同问题对照，不是跨模型推断） |
| `qwen-vl-max-latest`（本账号未开通） | HTTP **403** → `PROVIDER_UNAUTHORIZED`（不是模态拒绝；已把该错误文本改为同时提示“模型是否已开通”）                                                                                                                                                                                                                          |

结论：本次 `qwen-plus` 没有产生可用的模态拒绝错误码，因此 `MEDIA_MODEL_UNSUPPORTED` 仍只在服务商明确给出 allowlist 中的措辞时触发（目前尚无真实样本命中）。**有/无媒体块的同模型对照**证明该音频块对 `qwen-plus` 没有贡献输入 token（78 对 78、回答相同），但**跨模型**的 `prompt_tokens` 差异仍不能作为“媒体是否被读取”的通用判据（tokenizer 与提示模板不同）。因此本项目目前的做法是：**不**根据用量猜测模型是否读了媒体，而是把 `request.model` 与 `usage` 如实暴露给调用方，并在 `limitations` 里声明本地校验不证明模型听到；安装者需要自行确认所选模型支持该模态。**补充证据（2026-09-25）：** 同一 72,559 B 样本的第三次调用说明，模型即使确实读到了音频，它的**计数与时间戳仍可能出错**（把 3 段报成 4 段、切换点整体偏移并多报一个）。所以服务端既不能把“模型答出了音频内容”当作已核验事实，也不能把模型给出的段数/时间点当作真值去做纠正或过滤——保持如实透传并声明局限。

**已记录的负例（2026-09-25）：** 只有音频轨、没有视频轨的 MP4（`ftyp isom` + 单个 `soun` trak、890 秒、6.9 MiB）经 `video_url` 提交时，服务商返回 **HTTP 400**，没有 SSE 事件也没有用量（两次复现：request id `0a7e3482-0744-9183-8cc3-5b928c4f91dc`、`2832b8e7-9235-9818-b89b-c186c6a5c0f4`）。同一协议对含视频轨的 MP4 与 MOV 正常（见下），因此该 400 与“音频-only 容器”有关，但**具体原因未定位**（缺视频轨、文件其它属性或服务商策略都可能）。当前实现不会预先拒绝音频-only MP4，使用者会看到 `MEDIA_ANALYSIS_FAILED` + `http_status=400`；若要把“音频-only MP4 自动改走音频路径”做成产品行为，需要另立规格（涉及本地转封装，属于禁止的自动转码范畴，须单独批准）。**关联观察（2026-09-25，未证实）：** 同一部 890 秒源视频的完整音视频版本随后返回了明确带 `data_inspection_failed` 的 HTTP 400（见 [ADR 0023](decisions/0023-provider-inspection-errors.md)），而上面这两次裸 400 的响应正文被旧实现丢弃，原因已不可回溯；内容检查因此是那些 400 的候选原因之一，不要把它们当作“音频-only 容器被拒”的既证事实。

**2026-09-25 其它格式 live 对照（同一模型、默认地域、公开合成夹具）：**

| 样本                                                  | 结果                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| MP4，H.264 + AAC，3 秒（`test/fixtures/live-av.mp4`） | 成功：画面 `24`、语音 `3.1415926`；`usage` 784/213/997、78 事件、约 6.8 秒；`media.audio_track_present=true` |
| MOV，同一码流 `-c copy` 转封装（31,039 B）            | 成功：画面 `24`、语音 `3.1415926`；`usage` 784/223/1007、75 事件、约 6.0 秒；`container=mov`                 |

系统消息只包含固定的 `PROTOCOL_NOTE`（要求文本回答、只写实际看到或听到的内容、不确定就说明、不要编造）。它不规定时间线、构图、色彩、音乐、优缺点或用途建议，也不随问题变化；服务端不再追加业务提纲。

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
12. `finish_reason=length` 表示回答被截断，必须丢弃部分正文并返回安全的 `PROVIDER_RESPONSE_INVALID`；诊断可保留 `parse_reason=truncated`、事件数和可用 token usage，不得把片段作为成功结果。

服务端成功出口会累计首轮与一次证据纠错调用的 token usage（若 provider 未提供则记 unknown），并只在本地诊断中记录请求数、纠错次数、耗时、request id、结束原因和用量。不要记录原始 SSE 或媒体内容。

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

## 7. 2026-09-24 修复与短片对照记录

- 实现：成功结果统一移除模型复述的内部 `oss://` 地址、凭证形态和本机绝对路径；结构化观察、推断、不确定项与正文共用出口脱敏。正常 HTTPS 地址不做整体删除。
- mock：正文声音确定性陈述没有相应 `heard` 条目时，纠错/降级并在文本中注明音频未确认；`MM:SS` 无效、秒值越界、已知本地时长越界会使该观察退出直接观察列表。`finish_reason=length` 拒绝返回部分答案，并保留安全截断诊断与可用 usage。
- 公开夹具 live（qwen3.8，2026-09-24）：14.5 秒，428 SSE events，约 14.5 秒；画面数字与语音数字均命中，结构化音频条目为 `heard` 两项；usage 1349/1171/2520（prompt/completion/total）。request id `chatcmpl-e250bb4c-15f6-9d70-82b8-f98cfb95bb65`。
- 用户指定来源的 20–30 秒短片（H.264/AAC，实测片段时长 10.10 秒；临时文件只在系统 `%TEMP%`，未进入仓库）：相同问题 qwen3.8 完整结束，13.5 秒、326 events，usage 6692/843/7535，request id `chatcmpl-07ad799b-4f32-9812-b3a6-9bdadb6076cd`；报告只有 `uncertain` 音频项、两条 uncertainty。为补充分项摘要重跑同条件一次，耗时 53.4 秒、1184 events、usage 6692/3098/9790，request id `chatcmpl-95d8343f-a6ca-9350-a80d-24ed862616c3`；此重跑无新增判别价值，之后停止 qwen3.8 重复请求。
- 同一短片与问题 qwen3.5-omni-plus：9.7 秒、47 events、usage 6656/426/7082，request id `chatcmpl-6deac8cd-6f32-9812-b3a6-9bdadb6076cd`；报告含 `heard` 一项与一条 uncertainty。仅能得出该短片和提示词下两模型报告不同；没有这段音频的独立听核，不能判定 qwen3.5 条目准确，也不据此改变默认模型。
- 本轮先以 mocked MCP 成功出口验证了含空格 Windows 路径脱敏、普通 HTTPS 保留、声音正文与 `heard` 分项不一致时的本地清理，以及“不确认听到”不触发第二次计费。轻量轨道探测现在区分已发现、完整检查后未发现、未能完成检查三种状态；未知状态不会被写成无音轨。以上仍不是音频语义准确性的证明；修复版 GUI/live MCP 出口待安装后验证。
- 同轮安装检查发现 `--doctor` 在 Windows 默认配置回退下长时间无输出。原因是每次查找都为五个候选字段分别启动 PowerShell，而诊断会重复查找。现在一次批量读取 Windows 用户环境变量，15 秒内复用结果；仍只返回配置来源与布尔状态，不记录或输出变量值。主仓库构建的默认 `--doctor --json` 已返回并通过单 Tool 内存握手。
- 安装包端到端验收：已从主仓库构建并打包为独立本地 tarball，替换旧全局安装；全局 `--doctor --json` 返回 `ok=true`，真实 stdio 客户端只列出 `analyze_video`。公开 3 秒声画夹具经全局安装包调用一次（约 22 秒），`qwen3.8-omni-flash` 返回 `video_observed=true`、`audio_observed=true`，文本命中预设画面数字 24 与语音数字 3.1415926。仅输出上述脱敏摘要；该控制样本不能证明用户原片的音乐识别准确。
- 用户重启 Codex 后，新会话 Tool 列表包含 `mcp__analyze_video_mcp__analyze_video`，并用它对《山姆·奥特曼大战达里奥.mp4》发起完整 MCP 调用。返回 `ok=true`、`model=qwen3.8-omni-flash`、本地 MP4/H.264/AAC 轨道事实、`video_observed=true`；画面时间线给出 19 条 `seen`。声音部分 `audio_analyzed=true` 但 `audio_observed=false`，三个音频分项均为 `uncertain`，主文本明确说不能证实音乐，也不能断言静音。与用户已确认“有一首背景歌”的真值相比，原片音频漏报仍存在；安装、挂载和脱敏说明的改进没有解决默认模型的这项语义失败。输出还附加“回答正文含有未获 heard 分项支持的确定性声音结论”提示，但正文主要是在否定音频可确认性，提示可能由词句规则误触发，需用脱敏样例单独复核，不据此宣称模型曾肯定报告声音。
- 同日继续对照：用安装包和相同原片设置 `QWEN_MODEL=qwen3.5-omni-plus`，一次完整 MCP 调用约 31 秒，返回 `video_observed=true`、`audio_observed=true`、六条 `heard`，其中持续电子舞曲/歌曲判断与用户确认有背景歌一致。另从 20–30 秒截取原音并复制 AAC 码流、将画面替换为纯黑色，得到 10.08 秒诊断片段；qwen3.5 在这段黑画面原音中仍报告背景音乐与歌唱、无清晰对白，`audio_observed=true`。这增强了“qwen3.5 确实利用音轨判断音乐”的证据，但全片回答对是否有歌声与该片段不一致，完整片中若干动作音效也未独立核听，不能将所有 `heard` 当成真值。诊断片段已移入回收站，未加入仓库。用户确认只对其 Codex 安装设置 `QWEN_MODEL=qwen3.5-omni-plus`；公开默认仍是 `qwen3.8-omni-flash`，不引入自动二次付费调用。此前“不能证实存在背景音乐或歌曲”被声音正文关键词门误判的脱敏样例已加入回归测试并修正；这只是输出一致性修复，不提升模型听音能力。

## 8. 2026-09-25 N1 文案修复与合成声音真值集

- N1 修复：当报告正文含有分项 `heard` 不支持的演唱、歌词、性别、音效等细节时，保留有支持的背景音乐句，只移除未支持的逗号分句，并以「其它声音细节本次无法确认」告知范围。若没有 `heard`，则提示本次未能确认音轨中的具体声音。`uncertainties` 使用同类自然措辞，用户正文不出现证据门规则名或清理动作。回归覆盖了背景音乐 + 女声演唱/中文歌词/音效、纯否定句和只有 `uncertain` 的报告。
- 合成样本、生成命令和独立真值见 [`../test/fixtures/README.md`](../test/fixtures/README.md)。固定问题只要求模型基于音轨判断音乐性声音、语音/歌声、独立音效；现有 `live-av.mp4` 提供清晰数字朗读控制，新增三条测试为音乐性和弦（不含歌声）、数字静音 AAC、移动图形 + 静音 AAC。未测试“无音轨”文件，也没有歌曲/歌声真值样本。
- 共 11 次成功付费调用：首轮 2 模型 × 4 样本 8 次；摘要器修正后追加 3 次（qwen3.5 音阶与静音、qwen3.8 朗读）。模型原始回答没有写入仓库；测试日志只输出 request id、模型、样本真值标签、耗时、SSE events、usage、`heard`/`uncertain` 类型和脱敏布尔摘要。布尔摘要只在模型自报 `heard` 的描述中用关键词匹配，不能代替独立真值或人工听核。
- 结果：qwen3.8 对和弦、两种 AAC 静音控制都只有 `uncertain`，没有直接确认声音；对数字朗读控制给出 `heard`，关键词摘要识别语音。qwen3.5 对两种静音控制均出现 `heard`（数字静音复核也出现），属于独立真值下的模型听音误报；对和弦的 `heard` 描述未被关键词摘要识别为音乐，却识别出人声/音效词。两模型都在数字朗读控制报告 `heard` / 语音词，但此问题未要求数字转写，不能据此宣称转写准确。
- 结论仅适用于这几条短样本和该问题。qwen3.5 对原片背景歌的一次已知真值符合，但静音误报显示不能说它“整体更准确”；qwen3.8 对静音样本较保守，但和弦样本漏确认。公开默认仍为 `qwen3.8-omni-flash`，本轮不据此更改默认或 Tool schema。
- 处理静音误报如需独立确认，需要先决定测量/分析能力的产品边界，通过通用规格与 ADR 审议并扩展真值集。当前修复不引入 FFmpeg 生产依赖，不把模型置信度或 `heard` 标签当作独立真值。
- 安装形态：2026-09-25 本地构建打成独立 npm tarball 后安装，stdio 握手仅列出 `analyze_video`；工作区与安装包 14 个 `dist/*.js` 哈希一致。没有再次调用视频。此包版本仍是本地构建的 `0.6.1`，npm 公共版本未变。桌面 Codex 新会话原片回归未重复，以免为同一现象再次付费。

## 2026-09-25 现有 Tool 的可选数字静音核对

> **历史记录：** 该可选 FFmpeg 数字静音核对已在下一大版本移除，`QWEN_AUDIO_SILENCE_CHECK` 不再生效，代码与 `src/audio-silence.ts` 已删除。本节与 [`tasks/analyze-video-optional-silence-measurement-proposal-20260925.md`](../tasks/analyze-video-optional-silence-measurement-proposal-20260925.md) 仅作证据留存。

[ADR 0022](decisions/0022-analyze-video-optional-silence-check.md) 已单独批准并接入现有 `analyze_video` 的默认关闭开关 `QWEN_AUDIO_SILENCE_CHECK=off|on`。启用时只对授权本地文件使用现存只读 FileHandle fd 做一次 FFmpeg 全音轨统计；不改变模型、请求数、schema 或大小/时长上限。完整 PCM 全零与模型 `heard` 冲突时降级声音 observation 并保留可读视觉结果。非零信号不是可听内容真值；不判断歌曲或歌声。失败/缺 FFmpeg/不支持参数 fail-soft，用户取消 fail-stop。该实现目前只在 Windows Node 24 + FFmpeg 8.1.1 的本地合成 fixture 上验证，没有跨平台/版本矩阵结论，不包含私人媒体或付费 live。
