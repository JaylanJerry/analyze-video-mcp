# ADR 0019：v0.7 本机音频测量运行时

- Status: Deferred (never accepted; outside the next-major core)
- Date: 2026-09-22
- Spec: [`SPEC_V07_PROPOSAL.md`](../SPEC_V07_PROPOSAL.md)

> 2026-09-25：本地 FFmpeg 综合测量不属于 [ADR 0024](0024-agent-directed-media-gateway.md) 的单入口重构主线。本文件保留研究证据；已独立接受的可选数字静音核对仍见 ADR 0022。

## Context

v0.6.1 明确不做本地抽音轨、FFmpeg 或 LUFS/true peak 测量，且仓库目前不增加生产依赖。v0.7 的音频与媒体审核如果报告确定性技术数值，必须有独立于模型的解码和测量来源。当前的 Node MP4 `mvhd` 探测只负责轻量时长边界，不能代替音频解码。FFmpeg 官方提供 loudness、true peak 和静音等滤镜，但具体命令、版本和部署方式仍需验证。

## Proposed Decision

1. 优先采用由用户自行安装的 FFmpeg 与 ffprobe 可执行文件，程序只检测受支持版本并以固定参数数组调用。既不随 npm 包捆绑二进制，也不在安装或运行时自动下载。此方案虽不增加 npm 生产依赖，但增加了**外部运行时要求**，接受本 ADR 才可实施。
2. 本地输入先经过现有允许根和文件身份授权。进程不得使用 shell 字符串或用户/model 提供的参数、协议或滤镜；必须限制耗时、输出量与并发，只传满足所需 DLL 搜索的最小环境变量，不继承 `DASHSCOPE_API_KEY`。原媒体只读；首选解码到 null 并只保留有限统计，不生成完整临时 WAV。**研究建议**让 Node 把已授权 `FileHandle.fd` 继承为子进程 stdin（`stdio[0]` 传该 fd），并用固定 `fd:` 输入协议及 `-protocol_whitelist fd` 调用 FFmpeg。FFmpeg 将其视为可 seek 的常规文件；不把路径交给 FFmpeg，避免授权后路径替换。Windows Node 24 + FFmpeg 8.1.1 的合成 MP4/MOV 实测完成，包括 `moov` 在 EOF 的文件；同一 FileHandle 完成测量和取消后仍可从 offset 0 读取。`pipe:0` 从同一 handle 顺序供数也在这些样本成功，但不可 seek，当前仅代表小型合成样本结果。若平台/容器无法走继承 fd，失败应为 `incomplete`；不得悄悄退回按原路径重开。受限临时副本可作为另行审议的兼容方案，但需额外完整输入大小的磁盘空间、复制与解码两轮 I/O、权限 ACL、取消清理及崩溃残留策略。FileHandle fd 继承解决路径替换，但没有冻结同一文件上的原地并发写入；检查前后 identity/size/mtime 可检测常见变化，不能证明不可变快照。如果威胁模型要求硬性 byte-range 上限或不可变快照，应采用可安全创建且 ACL 经验证的受限副本，或另找 OS 文件锁/快照能力后再决定。
3. 测量结果附来源、版本、滤镜/阈值、单位、时间范围和完整性状态。容器中发现轨道不等于完整解码；解码成功且样本数大于零、每个样本恰为零，才可确认数字静音。非零只证明存在信号。解码失败、缺音轨、缺 FFmpeg、空样本、超时、取消、超限输出或只测到部分时段时，静音状态必须是 `unknown`、测量 `incomplete`，不能返回伪造数字，也不把模型听感当作 `measured`。
4. HTTPS 媒体暂不在本机下载测量；如后续需要，须先单独设计下载大小、SSRF、缓存与清理边界。Provider 对 URL 的语义分析可以继续，但审核须披露本机技术测量缺席。
5. 先用无私密内容的合成夹具验证 Windows/Node 22/24、Linux/macOS、中文与空格路径、长媒体 RSS、多音轨、取消及子进程回收。当前研究原型仅在 Windows Node 24 + FFmpeg 8.1.1 验证合成静音 AAC/音调、MOV 与 MP4（均含 EOF `moov`）、stdin pipe 与继承 fd；100ms 取消后 child 已回收，临时副本也可清理。正式实现还应有界宽限终止再强制 kill，随后 await child close 才关闭 handle/清理临时文件。没有 Node 22、Linux/macOS、长媒体、复杂 MOV/多音轨和生产授权路径证据。安装说明、doctor 能力探测与错误映射在实现前写入任务计划。

接受本 ADR 后，仅为 v0.7 的新音频/审核能力豁免“无外部运行时”的旧约束；`analyze_video` 不强制依赖 FFmpeg，其现有本地 MP4 上限与上传流程不变。对于 v0.7 新 Tool，完整解码确认数字静音而模型又报告 `heard` 时，应保留两种来源并标记冲突，将语义 finding 降为 `uncertain`；不得仅凭有非零样本提升或否定任何声音语义。具体公开结构仍由 ADR 0018/API 契约审阅决定。

本提案只让新 v0.7 Tool 有能力识别上述静音冲突；它不会让现有 `analyze_video` 的静音误报自动消失。若要把本地测量接入既有 Tool，须另行审阅兼容性、运行时可选/必需策略、失败时是否继续模型分析，以及是否允许覆盖旧 `heard` 输出；该问题未决前不得改旧 Tool。

## Alternatives

1. 捆绑 FFmpeg npm 二进制依赖：暂不采用；包体、平台、许可和供应链维护成本尚无评估。
2. 由模型给出 LUFS、dBTP、削波数量：拒绝提案；这些值没有确定性测量来源。
3. 用 Node 自研多格式解码和测量：暂不采用；格式、容器和算法范围过大，无法快速建立可信夹具。
4. 缺运行时仍给完整审核通过：拒绝提案；关键技术证据缺失必须标为 `incomplete`。

## Consequences

- 用户若要本机确定性测量，需要自行提供 FFmpeg/ffprobe；缺席时语义分析仍可用，但技术审核降级。
- 要维护跨平台命令、解析和版本测试，并清楚区分解码、测量与模型推断。
- 此 ADR 尚未授权安装 FFmpeg、加入生产依赖、打包二进制或运行付费 live 试验。

### 授权文件输入实验（Windows / Node 24 / FFmpeg 8.1.1）

研究脚本 `scripts/research/file-handle-audio-input.mjs` 仅枚举仓库内三段合成 fixture。三个容器顶部 atom 均为 `moov` 在 EOF：8 秒 AAC 静音 MP4（9,611 B）、2 秒 AAC 静音 MOV（4,087 B）和 8 秒音乐性合成音调 MP4（56,661 B）。路径读取、同一 `FileHandle` 喂给 `pipe:0`、同一 fd 继承为子进程 stdin 后用 `fd:`、以及从 handle 复制后按临时路径读取，均完整解码；全零样本为 `-inf`，音调仍测得非零 peak。没有把和弦称为歌曲。

| 输入路径                            |                              小样本耗时 |                     额外父进程 RSS 观测 |   磁盘代价 | 清理/边界                                                                              |
| ----------------------------------- | --------------------------------------: | --------------------------------------: | ---------: | -------------------------------------------------------------------------------------- |
| `FileHandle` fd 继承 + FFmpeg `fd:` |                                46–69 ms | 0–246 KiB RSS delta（非峰值，噪声较大） |     无副本 | 取消时约 133 ms 后 child 已回收；平台需单独验证                                        |
| `FileHandle` → `pipe:0`             |                                61–85 ms |          60 KiB–1.5 MiB delta（非峰值） |     无副本 | 取消时约 134–143 ms 后 child 已回收；输入不可 seek，复杂输入格式仍未知                 |
| 限权临时副本 → 路径                 | 60–106 ms（含本样本复制耗时不单独稳定） |        -372 KiB–241 KiB delta（非峰值） | 与输入等大 | 取消后子进程关闭再删除通过；Windows `mode 0600` 不代表已验证的私有 ACL；崩溃可能留副本 |
| 原路径 → FFmpeg                     |                               60–100 ms |            -196–417 KiB delta（非峰值） |     无副本 | 功能成功，但有授权后按路径重开的 TOCTOU，拒绝用于生产                                  |

毫秒数基于极小文件，只能证明路线可跑，不可据此推断长视频性能/RSS。FFmpeg 文档描述 `fd:` 对常规文件支持 seek、`pipe:` 是 pipe 协议；当前有限样本中 pipe 成功并不能证明复杂媒体都无需 seek。当前推荐是继承已打开的常规文件句柄 + `fd:`，固定协议白名单，并把每个轨道的统计结果写到单独日志流；测量前检查授权句柄 identity/size，限制许可的媒体大小，结束后再次检查 identity/size/mtime，变化时降级 `incomplete`，取消/错误后等待子进程退出再关闭原句柄。这个方式避免重新按路径打开，但不能阻止同一文件被并发写入，且若同尺寸替换并还原时间戳，元数据检查不能发现。若必须强保证字节范围/不可变快照，需要私有临时副本/操作系统快照路线另做审议；当前无法在 Node 跨平台接口中给继承 regular-file fd 加硬字节上限。长媒体/子进程峰值 RSS 仍无证据。

Node 支持把父进程打开的 fd 作为子进程 stdio 项传递，[Node child_process 文档](https://nodejs.org/api/child_process.html#optionsstdio)；FileHandle 绑定流支持限定 `start`/`end` 的范围和背压高水位，[Node fs 文档](https://nodejs.org/api/fs.html#fscreatereadstreampath-options)。Node 文档注明 Windows 上 `mode` 不能表达 POSIX 的 owner/group/other ACL 区别，因此临时副本不能只靠 `0o600` 声称私有，[Node fs 文件模式说明](https://nodejs.org/api/fs.html#file-modes)。FFmpeg 的 `fd:` 协议对常规文件具备 seek 支持，而 `pipe:` 是不可 seek 的 pipe 协议，具体格式能力仍以实测为准，[FFmpeg protocols 文档](https://ffmpeg.org/ffmpeg-protocols.html#fd)、[pipe](https://ffmpeg.org/ffmpeg-protocols.html#pipe)。
