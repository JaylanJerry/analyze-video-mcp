# 1.0 媒体分析网关规格

> **更名发布（2026-09-26）：** `media-analysis-mcp@2.0.0` 已在官方 npm 发布，展示名为 **Media Analysis MCP**；registry 全新安装与 stdio 握手通过，Trusted Publisher 已绑定新仓库。GitHub tag/Release 的执行状态以发布记录及 GitHub Actions 为准。历史 `analyze-video-mcp@1.0.0` 保留；下文 1.0.0 验收仅为原包基线。进度见 [发布记录](../tasks/release-2.0.0.md)。

> **2026-09-26 正式发布更新：** `1.0.0` 已通过 Node 24 远程 CI 与 Secret Scan，并经 Trusted Publishing 发布；官方 npm 的 `latest` 为 `1.0.0`，registry 全新安装/stdio 握手与关键构建哈希核对通过。当前安装示例为 1.0.0 / MEDIA_*；下文旧日期状态仅为历史记录。完整证据见 [`tasks/release-1.0.0.md`](../tasks/release-1.0.0.md)。

状态：**1.0.0 已正式发布**，Node 24 远程 CI、Secret Scan 与 registry 安装验证已通过。当前契约见 [API_CONTRACT.md](API_CONTRACT.md)，正式证据见 [发布记录](../tasks/release-1.0.0.md)，历史实施过程见 [任务归档](../tasks/archive/README.md)。历史 npm 0.6.1 保留旧 Tool；架构取舍见 [ADR 0024](decisions/0024-agent-directed-media-gateway.md)。

**运行时支持：** Node.js 24.x only（ADR 0025）。其他主版本暂不承诺，不额外添加启动硬阻断。历史 npm 0.6.1 保留原有 `>=22` 声明。1.0.0 的 Node 24 远程 CI 已通过，未来变更须重新验证。

## 目标与非目标

用户把 MP4、MOV 或 MP3 交给 Agent，说明想知道什么；Agent 组织问题并调用 MCP，媒体模型分析后返回回答，Agent 再与用户交流。MCP 负责安全、可靠地把媒体和问题送达模型，而不替 Agent 决定报告结构或业务结论。

首批目标：本地 MP4/MOV 的画面与内嵌音频、独立本地 MP3 的声音语义分析；保留现有公开 HTTPS **视频** URL 的直连能力。HTTPS 输入不由本机下载或上传，服务商能否读取及其格式/时长限制须在结果或错误中如实体现。公开 HTTPS 音频 URL 暂不属于首批契约：服务端不抓取远端内容，不能仅凭 URL 后缀可靠判断音频格式；以后若支持，须另定路由与失败行为。

首批不做：图片分析、字幕/OCR/抽帧/转写流水线、LUFS/true peak 综合审核、发布通过判定、视频站点下载、自动转码、自动切换服务商、自动批量分析、跨调用的模型对话记忆。现有可选本地数字静音核对随旧报告管线退出下一大版本；迁移说明见文末。

## 设计决定与验证边界

| 项目       | 1.0 范围                                                         | 验证边界                                                                                                       |
| ---------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Tool 表面  | 恰好一个核心 Tool：`analyze_media(media, prompt)`；`prompt` 必填 | 契约测试和安装握手已验证；历史 0.6.1 的 `analyze_video` 不变                                                   |
| 包/启动    | 沿用 `media-analysis-mcp` 包名、CLI 与现有 Host 配置键           | 1.0.0 安装和握手已验证；包名不代表只接受视频                                                                   |
| 本地格式   | `.mp4`、`.mov`、`.mp3`，按文件内容验证，不能只看后缀             | MP4/MOV 的受支持编解码组合、MP3 的魔数/时长/协议逐项验收；不承诺所有 MOV 编码都可分析                          |
| 服务商     | 首发只接百炼，模型由安装配置决定                                 | MP3 的 `input_audio` 与本地临时上传 URL 组合已在 `qwen3.8-omni-flash` 实测可用；其它模型的音频能力不能据此推定 |
| 输出       | 模型回答为主，独立附加可信文件/请求元数据                        | 不把本地音轨存在或非零信号写成“模型听到了”                                                                     |
| 第二服务商 | 保留清晰的内部适配边界，不在首发接入                             | 只有对照样本证明收益并明确上传、费用、密钥与错误策略后另定规格                                                 |

上表描述 1.0.0 的范围及验证边界；历史 npm 0.6.1 不支持 MP3 或新 Tool。技术限制若与目标冲突，先记录证据并调整规格，不用未经验证的隐式转码或另一家服务商掩盖失败。

## Agent 与 MCP 的职责

1. 用户提出分析要求；Agent 结合对话把要求写入 `prompt`。宽泛请求由 Agent 自己整理，例如“概括内容，并分别说清你能确认的画面和声音”；服务端不替它展开九段模板。
2. MCP 对 `media` 做输入校验与本地访问授权。它可以加入最小的协议性说明，例如请求文本输出和不要编造未见内容，但**不能**附加规定时间线、构图、音乐、优缺点或发布建议的业务提纲，也不能改写 Agent 的实质问题。
3. MCP 探测本地文件事实、按格式构造服务商请求并流式上传本地文件；内部可使用 SSE 聚合完整回答。Agent 不需要指定帧率、音频提取方式、上传 URL 或模型参数。
4. MCP 对模型文本只做必要的协议解析与敏感信息脱敏，不做 `seen`/`heard` JSON 强制解析、句子删除、自动纠错再问、报告重排或结论升级。回答为空、仅有 reasoning、流截断等仍是错误。
5. Agent 可用同一 `media` 再调用并提出新 `prompt`。有效上传可复用，但服务商没有因此获得跨请求记忆；需要的前文由 Agent 自行携带。

建议实现中的内部边界：`authorize/inspect -> upload/cache -> provider request/response -> safe MCP result`。这不是要求新增通用插件框架；先让百炼的视频与 MP3 路径通过同一窄接口，避免复制整套错误与缓存逻辑。

## 公开契约

```json
{
  "media": "C:\\Users\\user\\Videos\\example.mov",
  "prompt": "只分析 00:30 附近画面与声音是否对应；不确定时直接说明"
}
```

- `media`：非空字符串；本地绝对 MP4/MOV/MP3 路径，或无凭证的公开 HTTPS 视频 URL。拒绝相对路径、目录、伪装后缀、`http:`、本地/内网 URL 字面量和含用户信息的 URL。HTTPS 视频沿用现有不下载、不探测的直连路径；路径明显以 `.mp3` 结尾的 URL 拒绝为未支持的远端音频，其它无法判别的 HTTPS URL 仍按视频直连，不能因此声称已验证其远端格式。URL 后缀不构成远端格式证明，远端 MP3 不自动改走音频协议。HTTPS 的重定向、DNS 与服务商抓取仍以当前安全边界为基线；不声称本机已检查远端内容。
- `prompt`：必填非空字符串，trim 后不得超过现行 8000 字符上限；不提供服务端默认分析问题。可以使用原有边界更严格的校验，但不能无声截断或替换问题。
- 不公开 `provider`、`model`、Key、上传凭证、`oss://`、`thinking_budget`、帧率、任意命令/路径或费用旋钮。服务商与模型由安装配置管理，避免一次调用意外发往另一云或重复上传。
- 只在用户明确要求调用该 MCP 分析媒体时由 Agent 选择本 Tool；这是 instructions/description 引导，不是服务端可证明的授权。MCP 的真实访问边界由安装配置与 Host 审批决定。

成功结果继续提供单个可直接阅读的 `content[0].text`；它应是模型回答经必要敏感信息脱敏后的文本，不附加固定审核报告。`structuredContent` 只放确定来源的运行信息，建议最小形状如下；可选字段缺失表示未知，不能填 `false` 冒充已检查：

```json
{
  "ok": true,
  "answer": "模型的回答（经敏感信息脱敏）",
  "media": {
    "kind": "video",
    "container": "mov",
    "duration_seconds": 42,
    "audio_track_present": true
  },
  "request": {
    "provider": "dashscope",
    "model": "本次实际模型 ID",
    "upload_reused": false
  },
  "usage": { "prompt_tokens": 100, "completion_tokens": 30, "total_tokens": 130 },
  "limitations": ["视频画面由模型分析，未作逐帧核验"]
}
```

`media.kind` 为 `video | audio`：本地由已验证的文件类型确定，首批 HTTPS 输入按视频处理。`container` 只在本地格式识别成功时出现；`duration_seconds` 只在本地可靠求出时出现；`audio_track_present` 只在本地视频轨道探测完整时出现，不能用探测不完整填 `false`。MP3 不设置视频轨或视频缺失结论，HTTPS 不伪造容器、时长或轨道事实。`limitations` 只写与本次媒体和已执行检查相符的限制，不给 MP3 套用“逐帧”措辞。`upload_reused` 仅陈述本地上传缓存命中，不表示模型记忆或本次分析免费。`usage` 只填服务商实际返回的值。`answer` 与 `content[0].text` 必须是同一份脱敏后的文本；对两处及日志都测试模型回显的本地路径、Key、`oss://` 和临时凭证，脱敏不应重写媒体语义。不得把“文件有音轨/已提交音频”写成“模型确实听到”；模型自己说听到，也只是模型报告。

错误结果保留 `isError: true`、安全的 `content[0].text` 与 `structuredContent` 中 `ok: false`、稳定 `code`、`stage`、`retryable`。视频专名错误码按下表迁移；`stage` 保留阶段语义，不用模糊的“失败”吞掉取消。A1 契约测试和迁移说明必须逐项覆盖；若实现发现确需调整命名，应先同步本表、ADR 与测试。已知内容检查拒绝保持不可自动重试；不根据拒绝推断用户媒体违规。只展示经验证的服务商 Request ID，绝不把 SSE 补全 ID 冒充 Request ID。

| 0.6.1 错误码                               | 1.0 错误码                 | 条件                                |
| ------------------------------------------ | -------------------------- | ----------------------------------- |
| `INVALID_VIDEO_INPUT`                      | `INVALID_MEDIA_INPUT`      | 输入无效、路径/URL 形式错误         |
| `VIDEO_PATH_NOT_ALLOWED`                   | `MEDIA_PATH_NOT_ALLOWED`   | 本地访问未授权                      |
| `VIDEO_NOT_FOUND`                          | `MEDIA_NOT_FOUND`          | 文件不存在、不可读或身份复核失败    |
| `UNSUPPORTED_VIDEO`                        | `UNSUPPORTED_MEDIA`        | 容器/内容无效或类型不支持           |
| `UNSUPPORTED_VIDEO_CODEC`                  | `UNSUPPORTED_MEDIA_CODEC`  | 已识别媒体中的编码组合不支持        |
| `VIDEO_FILE_TOO_LARGE`                     | `MEDIA_FILE_TOO_LARGE`     | 本地文件超过有效上限                |
| `VIDEO_TOO_LONG`                           | `MEDIA_TOO_LONG`           | 已知时长超过上限                    |
| `VIDEO_UPLOAD_FAILED`                      | `MEDIA_UPLOAD_FAILED`      | 本地上传失败                        |
| `VIDEO_ANALYSIS_BUSY`                      | `MEDIA_ANALYSIS_BUSY`      | 已有分析占用当前服务实例            |
| `VIDEO_ANALYSIS_FAILED` 且 `stage=aborted` | `MEDIA_ANALYSIS_CANCELLED` | 用户或 Host 取消；`retryable=false` |
| 其它 `VIDEO_ANALYSIS_FAILED`               | `MEDIA_ANALYSIS_FAILED`    | 未归入更具体错误的分析失败          |

`UPLOAD_POLICY_FAILED`、`PROVIDER_*` 和 `CONFIG_MISSING` 保留原码；服务商超时、限流、不可用、鉴权、无效/空响应与内容检查拒绝仍须分别报告。未知时长或未完成轨道探测不应伪装成超限、无音轨或内容不支持。

新增 `MEDIA_MODEL_UNSUPPORTED`（`retryable=false`）：只有已核对的模型能力配置或服务商明确的模态拒绝能证明所选模型不支持该输入时使用。未知模型能力不等于已证明不支持；不得靠回答没有提到声音来推断此错误。

## 文件与上传边界

- 默认拒绝本地路径，除非位于显式允许根，或安装者明确打开“任意本地媒体路径”开关。下一大版本使用 `MEDIA_ALLOWED_ROOTS` 与 `MEDIA_ALLOW_ANY_LOCAL_FILE`；旧 `QWEN_ALLOWED_ROOTS`、`QWEN_ALLOW_ANY_LOCAL_VIDEO` 不再作为新 Tool 的授权来源。已有安装者须显式迁移，doctor 应报告旧变量已失效并给出新变量名。这样不会把旧“任意视频路径”的授权静默扩大到 MP3。新任意路径开关默认 `off`；原有文件身份和脱敏约束不放松。
- 沿用真实路径、允许根、普通文件、只读 `FileHandle`、身份复核、同句柄上传、大小/时长限制、取消回收和 Agent 可见脱敏。MP3 的格式识别必须有有界解析；无有效音频帧时拒绝。MP3 的本地大小硬顶不得高于现有 1024 MiB，已知时长仍以最多 1 小时为边界；时长若无法可靠求出，标记 `unknown` 并在大小边界内交服务商决定，不猜测一个数字。可另设更紧的 MP3 上限，但须有协议或资源证据并同步契约。
- MP4/MOV 首批至少验收当前已支持的 H.264/H.265 + AAC 组合；MP3 验收真实 MPEG 音频流，不能把任意 ID3 文件当成有效 MP3。MOV 中 PCM 等现行拒绝组合须单列实测：服务商原生可处理才放行，不能因扩展名是 MOV 就承诺可用。服务端不自动转码，也不因目标不可读就把整片 Base64 放入请求。
- 缓存键至少隔离文件身份、服务商、模型、上传端点/地域、上传账号或凭证身份与到期时间。百炼临时 URL 绑定上传账号；如果不能安全识别账号或凭证已变更，须使旧缓存失效，不得跨账号复用。只缓存短期媒体引用及必要元数据，不缓存 Key、上传凭证或可还原它们的材料。缓存命中仍可能产生模型推理费用。失效后重新上传；中途取消或上传失败不能留下可复用的“成功”项。缓存开关保持可关闭。
- 进度消息区分校验、上传、等待模型、完成；Host 不支持进度时最终结果仍完整。取消必须停止未完成的本地读取、上传与分析，释放句柄；不要把 Host 60 秒等待超时直接写成服务商失败。

## 服务商能力与发布门

首发只用百炼。内部协议分开处理视频 `video_url` 与 MP3 `input_audio`，共享鉴权、SSE、错误与资源边界。Chat Completions 音频请求的目标形状为 `{"type":"input_audio","input_audio":{"data":"oss://…","format":"mp3"}}`，本地临时上传 URL 的模型调用还需 `X-DashScope-OssResourceResolve: enable`。这两项分别有官方文档依据，且 **2026-09-25 已用非私密小样本完成真实探针**（默认地域、`qwen3.8-omni-flash`：9 秒合成音频两次调用都正确、890 秒真实音频概括正确、`upload_reused` 由 `false` 变 `true`；证据见 [`PROVIDER_PROTOCOL.md`](PROVIDER_PROTOCOL.md) §3b）。该结论只覆盖该模型与地域，**跨模型不外推**——实测纯文本模型会静默忽略音频块而不报错。真实调用及上传仍须逐次获得用户明确授权。若该组合不受支持，带证据提出最小替代方案供审阅；不得悄悄引入整文件 Base64、另一家云或新生产依赖。安装时选用的模型应明确支持所请求的音频或视频输入；已知不支持或服务商明确拒绝时返回 `MEDIA_MODEL_UNSUPPORTED`，不能把未读到音频包装成成功分析。

协议参考：[百炼 Chat Completions 媒体输入字段](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)、[Qwen-Omni 格式与上限](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen-omni)、[临时上传 URL 与地域/过期约束](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/get-temporary-file-url)。这些文档说明接口可能性，不替代本仓库针对目标模型、地域和上传方式的实测。

第二服务商候选可参考 [Gemini 视频](https://ai.google.dev/gemini-api/docs/video-understanding)和[音频](https://ai.google.dev/gemini-api/docs/audio)能力，但不是首发任务。只有同一组 MP4/MOV/MP3、画面/声音、长短样本、费用/时延/拒绝案例的对照测试显示明确收益，才另立设计决策。切换必须由安装者显式配置；禁止失败时自动跨云回退。

## 测试与完成标准

1. Tool 列表恰好一个 `analyze_media`；输入只有 `media` 与必填 `prompt`。宽泛/具体/中文/时间码问题都按原意送达模型，没有固定九段提纲、证据 JSON 强制格式或自动二次提问。旧 `analyze_video` 的迁移行为与错误映射有明确测试及说明。
2. 本地 MP4（有/无音轨）、MOV（受支持组合）、MP3 各至少一份无私密测试夹具走通模拟端到端；坏魔数、伪装后缀、非法 MP3、PCM MOV 或其它不支持编码、超限、文件替换、junction、取消、账号/凭证变化与缓存失效有反例测试。公开 HTTPS 视频维持直连；远端 MP3 不被误路由为视频成功。
3. MP4/MOV 画面和内嵌声音、MP3 声音分别完成**获授权的**真实服务商与宿主验收后，才能宣称“已验证可用”。模型没确认声音时只说没确认；不能用轨道存在或数字测量补成听觉结论。
4. 无密钥、路径、`oss://` 或原始服务商错误正文泄露到 Agent 结果与日志。内容检查拒绝不自动重试；其它重试遵循现有安全上限。第二次提问能报告上传是否复用，且不会声称跨请求记忆。
5. `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm test`、`npm run coverage`、`npm run build` 通过；Node 24 远程 CI 与独立打包安装/stdio 握手通过。Node 22 不再是下一大版本的验收门；不据此声称 Node 22 存在缺陷。默认测试均为模拟请求、零付费。发布、推送、真实付费调用按仓库规则分别授权。

## 实施规则与现有文档关系

代码仍在 `src/`，测试在 `test/`，TypeScript strict、ESM、`msw` 与现有预提交钩子不变。可参照现有判别联合与 `unknown` 解析外部 JSON 的风格：

```ts
type MediaKind = "video" | "audio";
type MediaFact<T> = { status: "known"; value: T } | { status: "unknown" };
```

必须保留：用户本地访问边界、脱敏、可取消资源所有权、使用量与错误透明度。实施前另审：新增生产依赖、外部运行时、跨云上传、付费 live、发布。禁止：硬编码密钥、读/提交 `text/` 或 `.env`、整视频 Base64、自动转码、把模型回答当逐帧或独立核听证据。

本规格替代旧 v0.7 提案中“三 Tool + 确定性测量 + 综合审核”的**产品方向**，但不抹去已实现和已接受的安全修复。历史提案见 [`SPEC_V07_PROPOSAL.md`](archive/specs/SPEC_V07_PROPOSAL.md)、ADR 0018/0019；已发布 `0.6.1` 的数字静音可选能力见 ADR 0022。当前工作区下一大版本已移除该 FFmpeg 静音测量及其对回答的语义改写，迁移表说明 `QWEN_AUDIO_SILENCE_CHECK` 不再生效；数字静音事实若将来仍是独立需求，再另立功能规格。当前分支的 `API_CONTRACT.md`、`ARCHITECTURE.md`、`PROVIDER_PROTOCOL.md`、`SECURITY.md`、README、doctor、Server instructions 和 Tool 描述已随实现更新，1.0.0 已完成验收与发布文案核对；未来发布仍须重新核对，不能沿用本次验收作为新版本证据。
