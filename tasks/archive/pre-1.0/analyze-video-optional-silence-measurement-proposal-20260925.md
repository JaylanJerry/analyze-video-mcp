> **历史归档（2026-09-26）：** 本文保留当时的计划、结论和未验证项，不作为当前实施指令或发布状态。当前入口见 [开发交接](../../../DEVELOPMENT_HANDOFF.md)，发布事实见 [1.0.0 发布记录](../../../tasks/release-1.0.0.md)。

# `analyze_video` 可选数字静音核对提案（2026-09-25）

状态：**已由独立 [ADR 0022](../../../docs/decisions/0022-analyze-video-optional-silence-check.md) 批准并已实现；2026-09-25 五项质量门、本地合成验证和安装版 smoke 均通过**。这只批准现有 `analyze_video` 的默认关闭 opt-in，不改变 ADR 0019 仍 Proposed 的其它 v0.7 决策。目标是给当前 MCP Tool 一个显式、可撤销的本机数字静音交叉检查，使已知静音上的模型 `heard` 误报可被揭示。

## 不变契约

- 保持 Tool 名 `analyze_video`、输入 schema `video, question?`、公开默认模型、当前允许根和本地文件大小/时长上限不变。
- 不新增 Tool 字段、structuredContent 键或新的成功/错误顶层 schema；复用当前 `content[0].text`、`audio_observations`、`coverage.audio_observed`、`coverage.evidence_conflicts` 与 `coverage.coverage_limitations`。
- 默认完全关闭，不探测、不调用 FFmpeg。此 opt-in 不替用户改 `QWEN_MODEL`，不跳过常规模型分析，不修改问题或抽样策略。
- 只有全部可读音轨完整解码且每条音轨正样本数大于零、peak 为 `-inf`，才判定文件的 PCM 样本全零。非零电平不能判断是否可听或属于哪种声音；也不判断歌曲、演唱者、歌词或音效。

## 安装级 opt-in 草案

新增环境变量 `QWEN_AUDIO_SILENCE_CHECK=off|on`，缺省 `off`，不进入 Tool schema。`on` 表示在本地授权 MP4/MOV 上尝试确定性数字静音测量；依赖用户自行安装 FFmpeg。不得捆绑、自动下载或隐式安装。当前不做版本探测，固定参数无法执行或统计缺失时 fail-soft。未知配置值按本地配置警告处理：跳过测量，继续原流程并在现有 coverage limitation 中注明，不能静默宣称已做测量。

本设置只控制“测量并按已知数字静音校正模型直接听音冲突”这一行为。工具仍把视频按当前流程提交给同一默认模型；不会因测到静音而跳过 upload/provider 请求。设置关闭时的代码路径、输出文本、请求次数与已有结果完全不变。

## 执行时序与授权句柄

1. 先照现有流程完成本地文件授权、FileHandle 打开、轨道/codec/文件大小/时长探测和原有硬上限校验。HTTPS 继续不下载测量。
2. `QWEN_AUDIO_SILENCE_CHECK=on` 且本地轨道探测完整确认至少一条支持音轨时，**在上传与模型推理前**执行测量。用现有容器 probe 获取音轨数；对整条输入只启动**一个** FFmpeg 子进程，并在固定 graph 中独立统计所有音轨，避免同一 handle 多次以 `fd:` 打开时读指针留在 EOF。不额外启动 ffprobe。仅向 FFmpeg 传递 `resolveVideo` 保持打开的同一个只读 `FileHandle.fd`：Node `stdio[0]` 继承该 fd，FFmpeg 用固定 `fd:` 和 `-protocol_whitelist fd`。不把原路径作为 FFmpeg 参数、不按原路径重开、不修改原文件；子进程使用固定绝对可执行文件、固定参数、`shell:false` 和无 Key 的最小环境。
3. 子进程完成并回收后，父进程仍从同一 FileHandle 上传原视频；上传流显式从 offset 0 开始。发生用户取消时，取消测量、等待进程退出并关闭句柄，不继续上传或付费请求。超时是测量降级，不等于用户取消。
4. 该全轨解码是一次额外本机工作：CPU 随文件时长、声道和 codec 增长，响应会多出一次本机完整解码耗时。此数字测量**额外 provider 调用数为 0**，正常 `analyze_video` 模型请求及现有纠错策略照旧。没有长片基准，不能预先承诺解码倍率或具体耗时。

原型已在 Windows Node 24 / FFmpeg 8.1.1 的三个固定合成文件上通过，但没有 Node 22、Linux/macOS、长媒体、复杂 MOV 和多音轨生产证据。继承 fd 避免路径被替换；它不阻止同一打开文件被外部进程原地修改，也不能由便携 Node API 硬性限制子进程读取的字节范围。预启动以同一 handle `fstat` 检查上限，结束后核对 identity/size/mtime；检测到变化即判测量 incomplete。若维护者要求抵御恶意并发写入或要不可变 byte snapshot，需另选并审议具备 Windows 私有 ACL 的快照副本/OS 机制，不能把 fstat 复核描述成绝对保证。

## 结果与呈现规则

### 完整数字静音且模型报告 `heard`

- 以模型原始报告中的 `heard` 条目为冲突来源；将这些声音条目的现有 `evidence` 降为 `uncertain`，保留时间码和经过现有脱敏的描述，并在条目中清楚注明“模型报告”与“本地完整解码测得数字静音”的矛盾。不能把 `heard` 留在 structuredContent 里而只改文本。
- `coverage.audio_observed=false`，因为现在没有通过校正门槛的直接听音条目；`audio_analyzed`、`audio_track_present`、现有 `audio_strategy` 保持原义，不解释成没有提交音轨。
- 在现有 `coverage.evidence_conflicts` 加一条稳定、通用的数字静音冲突说明；在 `coverage.coverage_limitations` 说明“本地完整解码确认样本为全零；模型听音报告冲突并已降为待确认”。不增加新的 measurement/track 层字段。
- `content[0].text` 保留完整视觉回答和有效 `seen` 观察，只移除或替换与冲突 `heard` 条目对应的确定性声音分句；附加自然说明：“本地完整解码测得音轨样本均为零；模型报告的声音内容与测量冲突，相关描述仅供复核。”不能使用现有会整段覆盖 `answer` 的通用冲突回答，避免一条声音冲突遮掉有依据的画面结果。混合视听句需只改声音分句，并保留同句中有支持的画面描述。
- 若模型没给任何 `heard`，但测量确认数字静音：不创建冲突；在现有 coverage limitation 和文本中报告所测事实，替换默认“`audio_observed=false` 不代表静音”的通用 audio note，避免新旧说明互相矛盾。数字静音表示 PCM 样本全零，不扩写成“媒体绝对无声”。

### 其它情况

| 情况                                                                        | 测量/报告行为                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| opt-in 缺失或 `off`                                                         | 完全沿用现有行为，不探测/启动 FFmpeg。                                                                                                                                                                                           |
| opt-in `on`，FFmpeg 缺失、版本不支持、启动失败                              | 继续正常上传与同一次模型分析；不改任何 `heard`；以现有 coverage limitation 和自然文本说明“本地静音核对不可用”，绝不把缺测解释为非静音或静音。                                                                                    |
| 输入 HTTPS URL                                                              | 不下载、不启动 FFmpeg；继续原模型 URL 分析并表明本地数字静音核对未执行。                                                                                                                                                         |
| 完整本地探测确认无音轨                                                      | 跳过解码；沿用现有 `audio_track_present=false` 与已有轨道冲突行为，不增加“已测静音”。                                                                                                                                            |
| 轨道存在性或 codec 探测未知/不完整                                          | 不判 `digital_silence`，继续现有分析；追加测量未完成限制。                                                                                                                                                                       |
| FFmpeg 部分解码、非零退出、无样本、统计缺失、超时、stderr 超限或 fstat 变化 | 结果记为内部 `unknown/incomplete`；不降级任何模型 `heard`、不改 `audio_observed` 以表示静音，不作静音声称；继续正常上传和一次模型分析，并以限制说明测量失败。超时清理需先终止，宽限期后强制终止，等待 child close 后再关闭句柄。 |
| 用户通过 MCP 取消                                                           | 终止/回收解码子进程，关闭句柄并终止本次 Tool；不得继续上传或请求 provider。                                                                                                                                                      |
| 任一音轨含非零样本，或多音轨不全为零                                        | 不触发冲突改写，不声称可听或有音乐/歌曲；模型报告保持现有处理。只有所有轨道完整且全零才满足冲突门槛。                                                                                                                            |

测量失败采用 fail-soft（回到现有模型分析），用户取消除外。这样可选工具不会因本地运行时故障中断既有视频分析；失败细节只进入安全诊断和现有限制字段，不输出路径、原始 FFmpeg stderr、模型原文副本、OSS、Key 或可执行路径。

## 实施前需维护者批准

1. 是否接受 `QWEN_AUDIO_SILENCE_CHECK=off|on` 及默认关闭，并在 Proposed ADR 0019 中把它列为“对现有 `analyze_video` 的可选接线”，或另建 ADR。
2. 是否接受“不完整/不可用时继续原模型分析但披露测量缺失；只有完整全零才重写直接声音证据”的 fail-soft 语义，以及 MCP 用户取消停止整个 Tool 的行为。
3. 是否接受复用现有字段、增加 `evidence_conflicts`/`coverage_limitations` 文本而不增加 `structuredContent` 键；是否批准 conflict-answer 专用处理以保留有效视觉句和观察。
4. 是否接受当前有限威胁边界：继承授权 FileHandle fd + 预后 fstat 能防路径替换并发现常见改变，但不提供不可变快照/硬读取范围；若不接受，应先选 ACL/OS 快照方案。
5. 是否批准自带 FFmpeg 用户的安装要求、受支持版本矩阵、可执行路径定位、最小子进程环境、命令/协议白名单、CPU 超时、输出/并发上限、取消宽限期及跨平台实现测试。缺少 FFmpeg 时默认继续正常模型分析。

## 可测试验收清单

- 默认配置与 opt-in 关闭时，FFmpeg/ffprobe spawn 次数为 0；Tool schema、公开默认模型、本地文件大小/时长上限、model 请求数与当前 fixture 行为完全不变。
- opt-in 开启时，所有音频轨全零且模型给 `heard`：音频条目在 text 和 structuredContent 中都转 `uncertain`，有一条 conflict 和 limitation，`audio_observed=false`；结构化音轨存在与 `audio_analyzed=true` 仍保持 true。
- 回归原 N1 混合句：完整视觉描述/`seen` 条目仍在答案和 observations 中；仅不受支持声音分句被降级；音乐、女声、歌词、音效等细节不能因另一个有依据的视觉 claim 一起被删掉。
- 静音但无 `heard`：报告有限的数字静音事实、无虚构 conflict，移除“没观察到不代表静音”的矛盾提示。
- 有非零轨道、不完整探测、多轨部分失败、ffmpeg 缺失、版本不兼容、启动错误、stderr 上限、解码错误、超时、文件大小/mtime/identity 变化：不误称静音、不把 `heard` 降级，限制说明正确，仍只有现有模型调用。
- 无音轨和 HTTPS 路径不被当作已测静音；HTTPS 不触发下载或 FFmpeg。
- 用户取消能回收 FFmpeg、release lock/handle、不再 upload/provider；超时与解码失败 fail-soft，child 和 fd 在 upload 前清理/仍按调用规则持有。
- 覆盖 `fd:` 输入后，上传可从 offset 0 读取同一授权 handle；不按源路径重开、不写源媒体、不把敏感数据送入 child env 或 Agent 输出。一个 FFmpeg invocation 对每条轨道的 astats 必须能独立、一一对应地解析，轨道缺日志或重复标签均判 incomplete；不得以 `amix`/混音后单一统计抵消不同轨道信号。
- 合成夹具需覆盖：完整 AAC 数字静音、非零音调、silent video movement、文件尾 moov MP4/MOV、多音轨全零/混合零与非零、损坏/截断音轨。音调仅验证非零，不作为歌曲/歌声真值。
- 用 mocked 行为验证不增加 provider 请求；默认 `npm test` 不需要 FFmpeg，也不执行 live/付费请求。新增跨平台验收需在 Windows Node 22/24 与 Linux/macOS Node 22/24 执行。

## 非目标

此方案只拦截可独立证实的“数字全零音轨 + 模型声称直接听到声音”冲突。非零但实际静音/不可听、低音量噪声、转码后接近零、歌声/歌曲/歌词细节和声音分类仍依赖模型报告或人工核听；不宣称解决所有音频误报，也不改公开默认模型。

## 实现与验证状态

- 已由 ADR 0022 批准。当前实现不改 Tool 输入 schema、默认模型、文件上限或 provider 调用次数。
- 已实现安装级开关、授权 FileHandle fd 的单 FFmpeg 进程、每轨独立 `astats` context 收集、fstat 前后检查、超时/输出上限/child 回收、取消 fail-stop 和其它测量故障 fail-soft。
- 已加 mock 回归，覆盖默认关闭、无可执行文件、HTTPS、测量超时、stderr 上限、child 错误、句柄 stat/可执行查找失败和用户取消。Tool 回归覆盖全零 + heard 冲突、歌词/女声声音细节降级、视觉前缀保留、HTTPS 不测且只有一次 provider 调用。
- 本机非付费 Windows Node 24 + FFmpeg 8.1.1 合成验证通过：AAC 静音、尾部 moov MOV、双轨全零、双轨静音 + 非零 tone；ffmpeg 使用同一已授权 fd，解码后 handle 仍可从 offset 0 读取。音调只证明存在非零样本，不代表歌曲。
- 版本能力不探测：旧版、不支持 `astats` 或固定命令不兼容时以退出码/缺失 stats 归为 incomplete。本轮不宣称 Node 22、Linux/macOS 或其它 FFmpeg 版本验证。
- 验证完成：`typecheck`, `lint`, `format:check`, `npm test`（296 passed / 10 skipped）和 `build` 通过；合成真实 FFmpeg 子集 4 项通过；`npm run test:pack-install` 本地 tarball 安装与 stdio initialize/listTools 成功，工具名与两字段 schema 不变。未跑付费 live，未发布。

此实现只影响旧 `analyze_video` 的可选静音交叉检查；不会让 ADR 0019 的 v0.7 新 Tool 成为已批准状态，也不覆盖非零但不可听、歌曲/歌声/歌词或声音语义误报。
