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

| 字段       | 类型   | 必需 | 默认                               | 约束                                  |
| ---------- | ------ | ---- | ---------------------------------- | ------------------------------------- |
| `video`    | string | 是   | 无                                 | 本地绝对 MP4/MOV 路径或公开 HTTPS URL |
| `question` | string | 否   | `画面里发生了什么？音频说了什么？` | trim 后 1–8000 字符                   |

Tool schema 不得出现：`max_tokens`、`model`、`provider`、`thinking_budget`、`stream`、`upload`、`audio`、`frames`、`oss_url`。回答长度按模型自身上限，不给 Agent 旋钮。

## Tool 描述语义

描述文本应让 Agent 明确：

```text
只在用户明确要求用 MCP（本工具）分析视频时才调用；用户只是要你处理视频而没点名本工具时走宿主自己的流程，不要自动调用。
它会联合分析视频画面和视频内嵌音频，并返回文本回答。
不要先自行抽帧或抽音频；直接传入视频路径或 HTTPS URL。
一次最多 1 小时；本地还受 1024 MiB 与当场上传政策约束。
这是抽样理解，不是帧级剪辑定位。精确转场请先提供 5–30 秒片段。
本地文件（MP4 / MOV，ISO BMFF）须已获授权：位于 QWEN_ALLOWED_ROOTS 内，或该安装已开启 QWEN_ALLOW_ANY_LOCAL_VIDEO。被拒绝时提示用户改配置，不要换路径重试。同一本地文件会复用已上传地址；未命中则全量上传。
把用户的分析要求写入 question：具体则原样转发，空话则先整理再调用。
```

Server-level instructions 与 Tool 描述保持同义，第一句表达“仅在用户明确要求时调用”，随后说明“视频画面 + 音频”。

宽泛请求（省略 `question`，或「分析一下」「看看这个视频」这类短而笼统的说法）由服务端补上默认分析要求：时间线分段（单一场景/循环画面可不分段）、构图与画面元素（前景/主体/背景分层）、动态与特效（镜头运动、元素运动、光效与转场及时间）、色彩与光影（主色、冷暖、光源与轮廓光、质感；不猜制作软件）、实际听到的声音与推断声音分开并说明是否与画面同步、节奏与情绪、有依据的优点与问题、用途建议、不确定处；并声明这是抽样理解而非逐帧或逐字核验。要求里不设固定条数或字数，也不要求编造内容。问题里带时间码或「只核对…」这类限定词时按具体问题原样发送，不套用模板。

调用条件属于**提示词层面的引导**，不是强制机制：宿主是否加载 instructions、模型是否遵守都不由本服务决定。真正可控的是服务端校验与安装配置（允许根、`QWEN_ALLOW_ANY_LOCAL_VIDEO` 默认关闭、宿主的工具可见性与审批模式），文档不得把提示词写成“保证不会被调用”。

## 成功结果

MCP `CallToolResult`：

```json
{
  "content": [
    {
      "type": "text",
      "text": "模型回答\n\n分项观察（抽样）：\n画面：\n- 00:05 （看到）标题卡\n声音：\n- 00:06 （模型报告听到）女声朗读…\n（以上为抽样观察，不是逐帧、逐字或全量核验。）"
    }
  ],
  "structuredContent": {
    "ok": true,
    "coverage": {
      "video_strategy": "sampled_multimodal",
      "ocr_performed": false
    },
    "subtitle_audit": {
      "mode": "sampled",
      "complete_verification": false
    },
    "visual_observations": [],
    "audio_observations": [],
    "inferences": [],
    "uncertainties": []
  },
  "isError": false
}
```

规则：

- 文本必须是完整中文回答（模型 JSON 的 `answer`，或模型未返回 JSON 时的原文），且 `answer` 是文本的第一段。
- 模型返回合格证据 JSON 时，文本还要带上分项观察：按 `画面` / `声音` / `推断` / `不确定` 分节，每项写成 `- 时间（证据类型[, 置信度]）描述`，置信度低于 0.6 时才显示。这样只读文本、不读 `structuredContent` 的宿主也能看到分段证据，而不是只剩一段摘要。
- 观测数量与单条长度只受**展示上限**约束（`src/evidence.ts` 的 `DEFAULT_TEXT_LIMITS`：每节 12 条、单条 220 字）。超出条数时，文本按输入列表的原顺序分成连续索引组，每组选择一条代表项；首组和末组分别保留该组首尾，内部组优先选择 `seen` / `heard` / `measured` 直接观察，否则选择靠近组中点的条目。此策略不解析或重排时间戳，不保证按真实时间等距覆盖；输入若乱序，输出也保持原列表顺序。结构化结果保留完整列表。被截断时附一行「另有 N 项未在此展开」，不向模型要求固定条数或固定字数。
- 报告里没有任何分项观察时，文本写明「本次没有可列出的分项观察」，不补造小节。
- 不加固定标题、模型名、request id 或耗时。不得把原始 JSON 当作唯一可见结果。
- 若模型返回了合格的证据 JSON，可附加安全的 `structuredContent`（无路径、无 Key、无 OSS）。成功结果还带 `coverage` 与 `subtitle_audit`；本版 `complete_verification` 恒为 `false`。旧 Host 忽略未知字段。
- 成功回答和所有结构化描述在单一出口统一去除内部 `oss://` 地址、凭证形态和本机绝对路径（包括含空格的 Windows 视频路径）；普通 HTTPS 链接与媒体描述保留。无法解析为结构化报告的散文不产生分项证据或“已核实”语义。正文声音结论由 `heard` 分项校验；无法对应的确定性声音句在本地清理，不为此单独发起第二次付费请求。该词句校验是保守规则，不等同于语义真值验证。
- 分项时间码须为 `MM:SS`（分钟可超过两位、秒为 `00–59`），本地媒体上不得晚于已知时长；缺失、格式无效或越界的直接观察降为不确定项。时间码仍是模型抽样位置，不代表精确帧定位。
- 正文里的确定性声音结论必须有正向 `heard` 观察支持；仅在本地确认有音轨且已完整测得数字静音时，明确否定的 `heard` 描述（如“未检测到声音”“无对白、无音乐”）才会规范为 `uncertain`、不计入 `audio_observed` 或声音冲突，并清除匹配否定句中的内联 `(evidence=heard)` 标记。默认关闭、HTTPS、无音轨或测量不完整时不做此规范化。按分句识别，像“没听到音乐，但听到枪声”仍包含正向 heard 声明。只有 `uncertain` / `inferred` 音频项时，会移除正文中无支持的确定性声音句，并明确本次未能确认声音内容。`audio_observed` 表示存在符合门槛的正向模型报告，不等于独立核听或准确率。
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

| 错误码                      | 含义                                                                                                                                                                                                                     | 是否建议 Agent 重试 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| `INVALID_VIDEO_INPUT`       | schema 之外的输入问题                                                                                                                                                                                                    | 否                  |
| `VIDEO_PATH_NOT_ALLOWED`    | 本地路径未被授权：不在允许根内，且安装未开启 `QWEN_ALLOW_ANY_LOCAL_VIDEO`                                                                                                                                                | 否                  |
| `VIDEO_NOT_FOUND`           | 文件不存在或不可读                                                                                                                                                                                                       | 否                  |
| `UNSUPPORTED_VIDEO`         | 非 MP4/MOV、magic 不符或不是普通文件                                                                                                                                                                                     | 否                  |
| `UNSUPPORTED_VIDEO_CODEC`   | 编码不在支持集（视频 H.264/H.265，音频 AAC）；`diagnostics.codec` 给出检测到的 fourcc。若点名 PCM 且视频轨已受支持，可只将音频转为 AAC 并复制视频轨；`-c copy` 不会转换 PCM                                              | 否                  |
| `VIDEO_FILE_TOO_LARGE`      | 超过本地或动态 policy 上限                                                                                                                                                                                               | 否                  |
| `VIDEO_TOO_LONG`            | 本地 MP4 时长大于 3600 秒；正好 3600 允许                                                                                                                                                                                | 否                  |
| `UPLOAD_POLICY_FAILED`      | 取上传凭证失败或凭证不可用；`diagnostics.parse_reason` 区分 `request_failed` / `http_error`（带 `http_status`）/ `invalid_json` / `shape_mismatch` / `field_type_mismatch` / `upload_host_invalid`，`field` 指向具体字段 | 可稍后重试          |
| `VIDEO_UPLOAD_FAILED`       | 本地上传失败；应改用公开 HTTPS，不要重传原文件                                                                                                                                                                           | 否                  |
| `PROVIDER_UNAUTHORIZED`     | API Key 或接口地址无效                                                                                                                                                                                                   | 否                  |
| `VIDEO_ANALYSIS_BUSY`       | 已有一个视频任务正在上传或分析                                                                                                                                                                                           | 稍后重试            |
| `PROVIDER_RATE_LIMITED`     | 429                                                                                                                                                                                                                      | 按提示稍后重试      |
| `PROVIDER_TIMEOUT`          | 推理超时                                                                                                                                                                                                                 | 可重试              |
| `PROVIDER_UNAVAILABLE`      | 502/503 等暂时故障                                                                                                                                                                                                       | 可重试              |
| `PROVIDER_RESPONSE_INVALID` | SSE/JSON 不符合契约或中途截断                                                                                                                                                                                            | 可重试              |
| `PROVIDER_CONTENT_REJECTED` | 百炼返回 `DataInspectionFailed` / `data_inspection_failed`，表示内容检查拦截；不能据此判定视频违规。原始服务商消息不透传                                                                                                 | 否                  |
| `VIDEO_ANALYSIS_FAILED`     | 其他已脱敏错误                                                                                                                                                                                                           | 视情况              |
| `CONFIG_MISSING`            | 启动后调用时仍缺 Key 等配置；`missing` 列出变量名                                                                                                                                                                        | 否                  |

当服务商在 SSE 错误事件或 HTTP 错误正文中返回内容检查错误时，结果会给出 `PROVIDER_CONTENT_REJECTED`、`retryable:false`，不会把它误报为无效 SSE。`diagnostics.error_code` 保留经过形状校验的服务商错误码，`diagnostics.inspection_side` 仅为 `input` / `output` / `unknown`：只从已知固定错误措辞判断，无法判断时用 `unknown`。如响应正文的显式 `request_id` 或 Header 提供符合安全格式的 Request ID，错误 `structuredContent.request_id` 会带上它；SSE 的 `id`（如 `chatcmpl-…`）是补全 ID，不当作 Request ID。原始错误消息、路径、密钥和 OSS URL 不透传。其他明确的 SSE 服务商错误归为不可直接重试的 `VIDEO_ANALYSIS_FAILED`，保留安全错误码；HTTP 429/502/503 的既有重试策略不变。内容检查拒绝不自动触发重复上传或分析调用。参见 [ADR 0023](decisions/0023-provider-inspection-errors.md)。

`coverage` 字段分三组语义，不要混用：

| 组                                           | 字段                                                                                      | 含义                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本地事实（仅本地文件；HTTPS 为 `undefined`） | `container`、`video_track_present`、`audio_track_present`、`video_codecs`、`audio_codecs` | 由容器轻量探测得出；轨道存在性为 `true`（找到受支持编码）、`false`（轨道结构完整但未发现该轨）或缺席（探测不完整、无法判断）。fourcc 不证明整条轨道可解码。                                                                                                                                                                                       |
| 请求层                                       | `video_analyzed`、`audio_analyzed`                                                        | 该模态随视频请求提交。本地文件按轨道存在性取值：**没有音轨时 `audio_analyzed=false`**；HTTPS 未探测，恒为 `true`。对本地文件，`audio_analyzed=true` 只说明音轨存在并随视频提交，不证明模型听清或完整核听                                                                                                                                          |
| 报告层                                       | `video_observed`、`audio_observed`、`evidence_conflicts`                                  | `observed` 表示模型**直接确认**该类内容：画面需 `seen`、声音需 `heard`（`inferred`/`uncertain`/`cross_validated` 都不算），且本地探测未与之矛盾；散文路径无分项，均为 `false`。`evidence_conflicts` 列出**模型声明与本地探测冲突**的情形（例如声称听到、但本地未发现音轨），这类声明**不计入** `observed`，必须显式呈现给用户，不得当作已确认观察 |

`audio_observed=true` 只表示模型返回了至少一条通过规则检查的正向 `heard` 报告，且本地轨道探测未与其冲突；明确否定内容即使被模型标成 `heard`，也会降为 `uncertain`。混合肯定/否定描述按分句判断，任一正向子句仍算模型声称听到。此标记是模型报告层信号，不是独立听音、转录或与用户确认真值比对后的准确性结论。文本结果会将声音分项里的 `heard` 标为“模型报告听到”，画面、推断和待确认条目仍使用各自的证据标签。此措辞不改变结构化证据字段或公共 schema。

安装可选设置 `QWEN_AUDIO_SILENCE_CHECK=on` 时，工具会在上传前尝试对已授权本地文件的全部音轨作完整解码。只有每轨都产生样本且 peak 为 `-inf` 才确认 PCM 数字全零；此时正向模型 `heard` 声音条目被标为 `uncertain`，并在 `evidence_conflicts` 说明模型原报与本地数字静音冲突；只有描述的所有分句都明确否定（可包括“处于静音状态”的补充句）时，heard 才不产生冲突。若本地已确认存在音轨且 PCM 全零，工具会对少数明确声称“轨道不存在/空白”或“因无信号无法确定轨道存在”的措辞优先呈现本地事实，并窄范围修正“当前/实际音轨缺失”的推断，同时保留无法确认声音语义及视频原本是否应有可听声音的限制；没有完成此测量时不作此类改写。可明确分开的视觉前缀及结构化视觉 observations 会保留；自由文本里以声音开头、又把视觉动作连在同一分句中的句子（例如“听到枪声时男子倒地”）可能为避免保留未确认声音而整句删除。此检查默认关闭；HTTPS、FFmpeg 不存在/不兼容、解码失败或其它不完整情况都不会据此判断静音/非静音，而在 `coverage_limitations` 披露未执行或未完成。它不增加 Tool 参数或 structuredContent 键，也不增加 provider 请求。非零 PCM 不能证明声音可听、属于音乐/歌曲或含有歌声；数字全零也不证明整部媒体在人类感知上绝对无声。细节与威胁边界见 [ADR 0022](decisions/0022-analyze-video-optional-silence-check.md)。

当 `audio_track_present=true` 而 `audio_observed=false`（或视频同理）时，`coverage_limitations` 会显式写出原因，并区分两种情形：完全没有该类条目（“没有给出任何「听到」的观察”），或只有其它类型条目（“没有直接确认听到的内容（现有音频条目为：声画一致、待确认）”）。文本结果也提醒这不表示静音，并建议截取目标处 5–30 秒针对声音复核。画面字幕、标题卡和其它屏幕文字只算 `seen`，不能证明听到对白或旁白。不得把 `audio_observed=false` 读成“文件没有声音”。结构化结果另含 `model`（本次实际使用的模型 id），便于核对是哪次调用产生的结论。

`PROVIDER_RESPONSE_INVALID` 的 `diagnostics.parse_reason` 可能是 `json_without_answer`：模型返回了 JSON 但没有可用的 `answer` 字段，工具不会把原始 JSON 当回答返回。

声画配对校验（`collectViolations` / `sanitizeEvidenceReport`）：`cross_validated` 条目要求对面模态存在**直接确认且自身能通过清理**的条目（画面需有可用的 `seen`，声音需有可用的 `heard`）。只有另一侧为非空数组不够——`uncertain` 不能作担保，**将被清理删除的条目也不能作担保**（例如一条因含“似乎”而被降级的 `seen`），两侧互相 `cross_validated` 而没有任何确认条目属于循环论证。不满足时该条目就地降级为 `inferred`（保留信息，不再是观察依据）。

证据冲突（`coverage.evidence_conflicts`）：当模型报告了本地完整轨道探测未发现的模态内容（如声称听到、但未发现音轨）时，该项声明**不计入** `audio_observed` / `video_observed`，并写入 `evidence_conflicts` 与一条 `coverage_limitations` 提示。用户可见文本和结构化分项会把冲突条目标为 `uncertain`，正文改为冲突说明；`evidence_conflicts` 记录清理前的模型声明。**结构化输出在冲突列表为空时省略 `evidence_conflicts` 字段**；字段缺席表示本次没有检测到这类冲突，不表示做过完整验证，也不能据此证明某个版本是否部署。轨道探测不完整和 HTTPS 输入的 `*_track_present` 缺席，不产生冲突判定，也不能解释为无音轨。

清理与校验使用同一套判定，因此 `sanitizeEvidenceReport` 的输出是**不动点**：对清理后的报告再跑一次 `collectViolations` 必为空、再清理一次结果不变（有回归测试守住这一点）。

Agent 错误文本禁止包含：

- API Key 或任何首尾片段；
- policy、signature、临时 AccessKey；
- `oss://` 全路径；
- 上传 host 的 query；
- 本地绝对路径；
- provider 原始响应体。

完整诊断只能写 stderr，且同样必须脱敏凭证和本地路径；允许记录错误码、HTTP 状态、阶段、request id、耗时和文件大小。Agent 同时收到安全的 `structuredContent`（`ok`/`code`/`stage`/`retryable`，可选 `http_status`、安全格式的 `request_id` 与受限 `diagnostics`）。`CONFIG_MISSING` 另含 `missing`、`suggestion` 与嵌套 `error`，仍不得含路径、Key、OSS、policy 或 signature。

缺 Key 或坏配置不得阻止 MCP `initialize` / `listTools`。工具调用时返回 `CONFIG_MISSING`。`analyze-video-mcp --doctor --json` 与运行时共用同一配置解析器，绝不打印 Key。

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
