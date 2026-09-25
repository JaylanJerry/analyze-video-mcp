# 本地媒体安全边界

> 本文件描述本工作区**已实现但尚未发布**的 `analyze_media(media, prompt)` 版本（下一大版本分支）。旧 `analyze_video` 授权变量不再生效，见下方迁移说明。

## 目标

Agent 可以主动调用 MCP。恶意提示或错误推理可能诱导它读取本机文件，因此“扩展名是 MP4/MP3”不等于用户授权。默认（未设置 `MEDIA_ALLOWED_ROOTS`）拒绝所有本地路径，只允许公开 HTTPS 视频；设置后仍按根目录 containment 拒绝根外文件。

例外：安装者可以在自己的 MCP `env` 或配置文件中设置 `MEDIA_ALLOW_ANY_LOCAL_FILE=on`（[ADR 0021](decisions/0021-allow-any-local-video-opt-in.md) 的安装级开关）。打开后**不再要求位于允许根内**，Agent 写出的任意绝对媒体路径都会被上传；该模式把“路径文本”当作授权，因此上面这条威胁模型对它不成立，只在用户主动接受该代价的安装上使用。默认保持关闭，且该变量不参与 Windows 用户环境变量的静默回退。

## 旧变量迁移（不静默继承）

| 旧变量                       | 现状                                                      |
| ---------------------------- | --------------------------------------------------------- |
| `QWEN_ALLOWED_ROOTS`         | 不再读取；改用 `MEDIA_ALLOWED_ROOTS`                      |
| `QWEN_ALLOW_ANY_LOCAL_VIDEO` | 不再读取；改用 `MEDIA_ALLOW_ANY_LOCAL_FILE`（默认 `off`） |
| `QWEN_MAX_LOCAL_VIDEO_MB`    | 不再读取；改用 `MEDIA_MAX_LOCAL_MEDIA_MB`                 |
| `QWEN_AUDIO_SILENCE_CHECK`   | 已移除（本地 FFmpeg 数字静音核对退出），该变量不再生效    |

原因是旧“任意视频路径”的授权不得被静默扩大到 MP3，也不得让一个只针对视频的开关继续影响新 Tool。`--doctor` 会识别这些变量并给出替代名；被识别到不等于被采用。

## 威胁模型

需要防御：

- Agent 请求上传允许根目录之外的私人媒体（默认模式下）；
- `..`、大小写、Unicode、短路径等路径绕过；
- symlink 或 Windows junction 从允许根跳到外部（默认模式下）；
- 先检查 A、上传时路径已被换成 B 的 TOCTOU；
- 伪装扩展名（文本文件改名 `.mp3`）、目录、设备、管道或空文件；
- 错误和日志泄露密钥、临时凭证、OSS URL 或绝对路径；
- 大文件触发内存耗尽；
- HTTP URL 降级或非预期 scheme；
- 远端 `.mp3` URL 被当作“已验证的远端音频”。

不防御（`MEDIA_ALLOW_ANY_LOCAL_FILE=on` 时明确放弃）：

- 提示注入或错误推理让 Agent 写出用户没有选择过的本地路径：该模式下路径即授权。

## 调用条件不属于安全机制

Server instructions 与 Tool 描述要求 Agent“只在用户明确要求用 MCP 分析媒体时才调用”。这是**提示词层面的引导**：宿主可以忽略 instructions，模型也可以不遵守，因此它不构成任何保证，不能在安全说明里写成“不会被自动调用”。可用的实际手段只有服务端校验、`MEDIA_ALLOW_ANY_LOCAL_FILE` 默认关闭、允许根限制，以及宿主自己的工具可见性与审批模式。

不承诺完全防御：

- 已控制当前 Windows 用户、能修改进程内存或调试进程的攻击者；
- DashScope 服务端自身安全事件；
- 用户主动允许并传入的合法媒体中的隐私内容。

## Allowed roots

配置：

```text
MEDIA_ALLOWED_ROOTS=C:\Users\user\Videos;D:\Project\Media
```

使用 Node `path.delimiter` 分隔。规则：

- 未配置时，拒绝所有本地路径；HTTPS URL 不受影响。
- 已配置时，根外本地路径拒绝。
- 每个 root 必须为绝对路径、启动时存在且是目录。
- 启动时对 root 做 `realpath()` 并保存规范结果。
- 输入本地路径必须为绝对路径；不根据 cwd 猜测相对路径。
- containment 使用 `path.relative(root, candidate)`：结果不得为空、不得以 `..` 开头、不得是绝对路径。不能用字符串 `startsWith()`。
- Windows 比较使用平台规范化后的真实路径，并加入大小写、UNC、盘符和 junction 测试。

## 授权与打开顺序

```text
validate absolute path and .mp4/.mov/.mp3 extension
  -> realpath(requested)
  -> containment against real allowed roots (unless MEDIA_ALLOW_ANY_LOCAL_FILE=on)
  -> stat identity snapshot
  -> open real path read-only
  -> fstat same handle: regular file, size, identity
  -> realpath + stat recheck
  -> read small header from same handle
  -> container probe from same handle (bounded)
  -> upload from same handle
  -> close in finally
```

要求：

- pre-stat 与 fstat 可用时比较 `dev`、`ino`、size 和文件类型。
- 打开后再次解析路径并比较，发现变化立即拒绝。
- symlink/junction 最终目标位于 allowed root 内可以接受；最终目标越界必须拒绝。`MEDIA_ALLOW_ANY_LOCAL_FILE=on` 时不做根判定，但仍以 `realpath` 后的目标文件做身份键与上传，改指仍会被打开前后复核发现。
- 容器验证至少检查 ISO BMFF `ftyp` box；只读取固定小块，不推进上传流的起始位置或在上传前重置到 0。本地可接受 `.mp4` 与 `.mov`，上传时按容器给出固定文件名（`video.mp4` / `video.mov`）与 Content-Type（`video/mp4` / `video/quicktime`）；对象 key 始终是随机 UUID，不含原文件名。
- 视频编码校验：解析 `moov/trak/mdia/hdlr` 与 `stbl/stsd` 只读 fourcc，视频仅接受 `avc1`/`avc3`/`hvc1`/`hev1`，音频仅接受 `mp4a`；其它组合在**上传前**以 `UNSUPPORTED_MEDIA_CODEC` 拒绝并在诊断里给出 fourcc。理由是：无法解码的音轨会变成误导性的“没听到声音”结论。
- MP3 识别必须有有界解析（`src/mpeg-audio.ts`）：跳过 ID3v2（声明长度超过 1 MiB 上限即拒绝）、在有限窗口内定位首帧、要求连续有效帧。仅 ID3 的文件、伪造后缀的文本、Layer I/II 流、保留字段非法的帧、自由格式码率帧都会被拒绝。上传元数据固定为 `audio.mp3` / `audio/mpeg`，对象 key 仍为随机 UUID + `.mp3`。
- 时长边界：MP4/MOV 读 `mvhd`，大于 3600 秒拒绝（正好 3600 允许）；MP3 只在流自己声明帧数（Xing/Info/VBRI）时给出时长，大于 3600 秒拒绝；没有声明帧数就按未知放行（**不做码率估算**），不猜数字。不得为探测顺序读完整文件，也不得引入 ffprobe。
- 大小同时满足：大于 0、≤用户配置上限（默认且硬顶 1024 MiB）、≤动态 policy 上限。
- 上传必须使用这个句柄；不得通过字符串路径重新 `createReadStream(path)`。
- 上面的顺序里只有 `containment against real allowed roots` 这一步会因 `MEDIA_ALLOW_ANY_LOCAL_FILE=on` 跳过；其余步骤在两种模式下都执行。

Node/Windows 无法提供完全可移植的 `openat + O_NOFOLLOW` 等价保证，因此同账户主动竞态仍是残余风险。实现通过重复 realpath、身份比较和同句柄上传降低风险；不得宣称“完全无 TOCTOU”。

## URL 输入

- 只允许 `https:`。
- URL 必须能由标准 `URL` 解析，且不得包含用户名/密码。
- 拒绝 localhost 字面量和明显的 loopback/private IP 字面量；不自行 DNS 解析，也不下载 URL。
- 路径明显以 `.mp3` 结尾的 HTTPS URL 以 `UNSUPPORTED_MEDIA` 拒绝（`diagnostics.input_kind=remote_audio`）：本机不抓取远端内容，后缀不构成类型证明，也不自动改走音频协议。其它无法判别的 HTTPS URL 仍按视频直连，但不代表其远端格式已验证。
- Provider 端 URL 抓取仍由 DashScope 安全边界控制，这是已记录的残余风险。
- URL query 不写日志。

## 时长探测残余

官方内容分析单媒体上限 1 小时。本产品只对**本地**文件做轻量探测；HTTPS 不下载、不探测。下列情况时长视为 unknown，**放行**（可能把超长文件交给 Provider）：

- fragmented MP4 / fMP4：时长在 `moof`/`tfdt` 里，`moov/mvhd` 可能缺失、为 0，或只覆盖初始化段；
- malformed box、非法 size、`timescale == 0`、探测字节或 box 数量触顶；
- `moov` 在超大 `mdat` 之后且 box 链无法安全跳过时；
- MP3 没有 Xing/Info/VBRI 帧数声明（含纯 CBR：字节估算无法证明全文件同码率）。

这是有意残余，避免误杀合法文件。未知时长不得报 `MEDIA_TOO_LONG`。

## 最小披露

- OSS 对象 key 使用随机 UUID，不包含原文件名。
- multipart `filename` 使用固定安全名（`video.mp4` / `video.mov` / `audio.mp3`）。
- Agent 错误只包含稳定错误码和通用说明。
- Agent 可见的回答与结构化字段在单一出口做**两层**路径脱敏：① 本次调用 Agent 传入的确切路径（含两种斜杠风格与 Windows 大小写变体）按字面替换，因此文件名里的空格、假名、标点都能覆盖；② 通用规则作为补充，覆盖本次未传入的 Windows 盘符/UNC（两种斜杠）、前斜杠 UNC 与 POSIX 路径（含非 ASCII 段）。普通 HTTPS 链接、时间码与「画面/声音」这类散文保留。**界限**：通用规则不跨空白，因此“本次未传入、且文件名含空格”的路径可能只被部分脱敏；已传入的路径由第一层完整覆盖。
- stderr 中本地文件只记 `size_bytes`，必要时记不可逆短 hash，不记绝对路径。
- API Key 不做“首尾脱敏展示”；只允许布尔状态 `configured`，且不需要成为 Agent Tool。
- policy 所有 credential 字段为 secret 等级，不得持久化。
- 上传缓存键包含：文件身份（真实路径、大小、mtime）、**该文件的有界内容指纹**（大小 + 首尾各 64 KiB 的 SHA-256 前缀，读自同一只读句柄）、模型、上传端点和 **API Key 的单向指纹**（域分隔 SHA-256，取前 16 位十六进制，不可还原 Key）。因此换 Key、或改动文件首尾各 64 KiB 内的任何字节（重新导出、重新编码、加片头等都会命中），都不会复用旧对象；**首尾指纹不保证发现只改中段的就地改写**。缓存文件本身不含 Key、上传凭证或可还原它们的材料。**残余风险（独立类别，与请求内的 TOCTOU 竞态不同）：** 若文件仅中段被就地改写且大小与 mtime 都不变，指纹不会变化，两次调用之间可能复用上一次的 `oss://`，于是模型分析的是旧内容——这是**跨请求的陈旧内容**问题（用户得到的内容分析可能不是当前文件），不是请求内的检查/使用竞态。**本轮处置：按已声明限制接受**（2026-09-26，独立审核确认其为独立类别）。若将来要求收紧，候选方案为全文件哈希（代价是整文件读取）、加入 inode/ctime（平台差异）或缩短缓存有效期（牺牲上传复用）。

## stdout 与日志

- stdout 仅 MCP JSON-RPC。
- 诊断写 stderr 或 MCP logging。
- 日志对象必须由白名单字段构造，不能直接序列化 error detail、Request、Response、config 或 policy。
- 测试必须用 canary 值断言 Agent 结果与 stderr formatter 均不泄露敏感字段。
- 结构化错误的 `diagnostics` 只允许白名单键：`http_status`、`request_id`、`elapsed_ms`、`input_kind`、`size_bytes`、`retry_count`、`received_sse_events`、`parse_reason`、`error_code`、`event_shape`、`field`、`codec`、`inspection_side`、`prompt_tokens`、`completion_tokens`、`total_tokens`。字符串值默认过 `looksSensitive`；`field` 只允许 `data.<小写下划线字段名>` 形状；`codec` 只允许编码 token；`event_shape` 只回显合规键名并限制数量，避免异常端点用键名把长文本送进 Agent 上下文。

## 大文件拒绝服务

- 在网络传输前检查本地文件大小。
- policy 不足时不上传任何字节。
- 所有网络阶段都有 timeout 和 AbortSignal。
- 流必须尊重背压；禁止整文件缓冲。
- 一次进程只允许一个活跃任务；第二个调用快速返回 `MEDIA_ANALYSIS_BUSY`，不排队、不读取文件。

## 密钥操作

- 只读取进程环境变量 `DASHSCOPE_API_KEY`。
- 不读取仓库外的 `.key`、`.env` 或用户文档文件。
- 不在测试命令行参数中放 key，避免 shell history 和进程列表泄露。
- Live test 必须由用户在外部注入环境变量并明确授权。
- 发现密钥进入 diff、日志或 fixture 时立即停止，移除并通知用户轮换。

## 安全验收用例

至少包含：

- allowed root 内正常中文 MP4；
- sibling-prefix 绕过，如 root `C:\Media` 与目标 `C:\Media-private`；
- `..` 跳出；
- 允许根内 symlink/junction 指向外部；
- symlink/junction 指向允许根内部；
- 检查后替换路径的可控竞态测试；
- `.mp4` 文本文件、目录、空文件、超大文件；
- `.mov`（`qt  ` brand）接受；ProRes/`mp4v`/PCM/ALAC 拒绝并点名 fourcc；`.mkv`/`.avi`/无扩展名拒绝；
- `.mp3`：真实 MPEG 帧结构接受；仅 ID3、文本改名、Layer II、自由格式帧、截断单帧拒绝并可点名编码；
- 根外 MP3 默认拒绝，且旧 `QWEN_ALLOW_ANY_LOCAL_VIDEO=on` 不授予访问；
- `file://`、`data:`、`http://`、带凭据 HTTPS、远端 `.mp3` URL 拒绝；
- provider 错误含 canary secret、policy、OSS URL、绝对路径时的脱敏；
- 500 MiB 流式上传内存上限；
- `MEDIA_ALLOW_ANY_LOCAL_FILE=on`：根外路径可上传，同时坏 MP4、超大小、超时长、junction 改指、非受支持扩展名仍被拒绝；同一路径在开关关闭时仍返回 `MEDIA_PATH_NOT_ALLOWED`；`--doctor` 报告生效模式；
- 缓存身份隔离：换 Key 后不命中旧 `oss://` 项，缓存文件不含 Key。
