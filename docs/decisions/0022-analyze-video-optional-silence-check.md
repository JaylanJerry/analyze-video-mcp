# ADR 0022: `analyze_video` 可选数字静音核对

- Status: Accepted
- Date: 2026-09-25
- Related: [ADR 0019](0019-v07-local-measurement.md), [可选静音核对实现提案](../../tasks/analyze-video-optional-silence-measurement-proposal-20260925.md)

## Context

合成 AAC 静音样本上的付费 live 对照发现，模型可能在全零 AAC 音轨上仍声称听到了声音。ADR 0019 的本机 FFmpeg 测量提案原本只覆盖未来 v0.7 工具，不能修复当前 `analyze_video` 输出。维护者单独批准了一个默认关闭的安装级交叉检查，保持当前 Tool 契约、模型默认值与文件上限不变。此 ADR 仅记录此项授权，不接受 Proposed ADR 0019 的其它新 Tool 或测量规格。

## Decision

1. 新增 `QWEN_AUDIO_SILENCE_CHECK=off|on`，默认 `off`。无效值按关闭处理，并在现有 coverage limitation 中说明核对已跳过；不阻断既有分析。
2. `on` 仅对已授权本地 MP4/MOV、轨道探测完整且发现至少一条受支持音轨的文件生效。HTTPS、不完整探测或无音轨不会下载/启动 FFmpeg。测量在上传和 provider 推理前执行，后续仍按现有路径上传同一个文件并只作原有模型请求。
3. 每次最多启动一个 FFmpeg 子进程。用 PATH 找到的绝对 `ffmpeg` 可执行文件、固定参数数组、`shell:false`、`fd:` 与 `-protocol_whitelist fd`，把现有只读授权 `FileHandle.fd` 作为子进程 stdin；不传入、不重开媒体路径，不启动 ffprobe，不抽取或写出音轨。上传流继续从 offset 0 读取同一 handle。
4. 子进程只继承 `PATH`、Windows 运行所需目录变量及 `TEMP`/`TMP`/`PATHEXT` 等最小环境，不继承 API key。输入轨道分别映射到同一 null 输出，独立套用 FFmpeg `astats`。使用容器中探测到的音轨数量（而非去重后的 codec 数量）逐轨映射；只接受每个独立 filter context 恰好报告一个正样本数和一个 peak，且所有 track context 数与已探测音轨数相同。只有所有 peak 均为 `-inf` 才报告 `digital_silence`。任何 FFmpeg 参数/版本/解码能力不兼容、非零退出、统计缺失或解析歧义都作为 `incomplete`，不猜测静音。
5. 测量超时固定为 120 秒，stderr 上限 128 KiB；超时/超限先发送 SIGTERM，1 秒后仍未退出则 SIGKILL，并等待 child `close`。超时、FFmpeg 缺失/启动失败、decode/stat/fstat 错误 fail-soft：沿用原模型分析并在 coverage/text 披露未完成。MCP 用户取消 fail-stop：结束子进程、等待回收，不上传、不调用 provider。每服务器现有单任务 busy lock 同时限制 FFmpeg 并发为 1。
6. 测量前后对同一 handle 执行 fstat；文件类型、dev、ino、size 或 mtime 变化时标为 incomplete。此检查检测常见原地变化，但不构成不可变快照，也无法发现恢复原 metadata 的同尺寸覆写；授权 fd 仍用于之后上传，不以路径重开。硬性 byte-range 限制和不可变快照不在此实现范围。
7. 完整数字静音与模型正向 `heard` 冲突时，audio observation 降为 `uncertain`、confidence 设为 0，description 标记为模型原报与本地数字静音冲突；覆盖率 `audio_observed=false`，用既有 `evidence_conflicts` 和 `coverage_limitations` 表示冲突。明确否定的 heard 描述（例如“未检测到任何可辨识的声音内容（无对白、无音乐、无效应音）”以及以“处于静音状态”作补充的句子）按 `uncertain` 处理，不创建冲突；按分句判断，混合描述“没听到音乐，但听到枪声”或“没听到音乐，但车辆轰鸣持续”仍因未明确否定的子句触发冲突。只过滤 answer 中声音分句；可明确分开的视觉前缀保留。当前纯散文过滤按分句做保守处理，不能可靠地从声音锚点后的同一分句拆出视觉动作；例如“听到枪声时男子倒地”整句可能被删除。结构化视觉 observations 保留并继续显示，因此不得声称所有自由文本视觉 prose 都能保留。若本地已确认存在音轨且完整解码为数字静音，还会窄范围修正明确否认音轨存在或把无信号等同于无法判断音轨存在的模型措辞；在推断中把“当前/实际音轨缺失”改写为“本地确认存在音轨，且完整解码后的 PCM 样本全零”，保留关于叙事影响的推测；对声音语义和视频原本是否应有可听声音仍保留不确定性。此改写只在 `audio_track_present=true` 且 `digital_silence` 已确认时生效，HTTPS、未探测、测量不完整及真实无音轨分支不触发。
8. 完整全零但无正向 `heard` 时，仅报告 PCM 样本全零事实，不创建冲突，并避免现有“未观察不代表静音”的提示与测量结论冲突。非零 peak 只说明存在非零 PCM 样本；不证明可听、背景音乐、歌曲、歌词或具体声音。
9. 未新增 structuredContent 键或 Tool 输入字段。仅复用已有文本、`audio_observations`、`coverage.audio_observed`、`evidence_conflicts` 和 `coverage_limitations`。

## Consequences and limits

- 默认关闭时不搜索或启动 FFmpeg，工具输出和请求路径不变。无效配置也不启动测量，但会披露 skipped 状态。
- 用户须自行安装 FFmpeg；包不捆绑、不下载、不自动安装。运行时不做版本探测，依赖一次固定参数解码和统计；不支持相应参数或滤镜的版本按 incomplete 处理。
- 本实现只确定整条解码 PCM 是否全零，不解决非零但不可听的静音、音量、音乐/歌声分类或歌词真实性。
- 本轮仅在 Windows Node 24 + FFmpeg 8.1.1 的仓库合成 fixture 上做本机验证。没有 Node 22、Linux/macOS 或 FFmpeg 版本矩阵验证；不据此宣称跨平台兼容。
- 单次核对最多耗时 120 秒，允许原有一次 provider 分析；没有增加 provider 请求。符合原限制的最长本地视频可能超过核对时限，此时 fail-soft 并照常分析。
- 本决策只接入现有 `analyze_video`。它不接受 ADR 0019 的其它 v0.7 新 Tool 方向；ADR 0019 状态仍为 Proposed。

## Verification

- Mock tests: 默认 off 零 spawn；配置 invalid/HTTPS/no-track 不测；全零 heard 降级且完整视觉保留；静音无 heard 的声明不矛盾；非零/不完整/超时/输出上限/child error/fstat 变化 fail-soft；取消 fail-stop、await close、无 provider 调用增加。
- Synthetic local checks: AAC 全零、MOV 尾部 moov、双轨全零、双轨静音+非零 tone；验证每轨独立 stats 和同一 handle 从 offset 0 可读。
- Full gates: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build`; package install and stdio initialize smoke without live API credentials.

2026-09-25 首次实施本地验证结果：五项门禁均通过；`npm test` 为 297 passed / 12 skipped。`RUN_FFMPEG_FIXTURES=1 npx vitest run test/audio-silence.test.ts test/tools.test.ts -t 'real FFmpeg|real FFmpeg analyze_video MCP fixture integration'` 为 6 passed，覆盖 4 个真实 FFmpeg 容器/轨道检查，以及完整 MCP 测量/冲突降级和双轨中含非零样本时不降级。集成发现同编码多轨被 codec 去重后计数不足；实现已改用独立容器音轨计数。`npm run test:pack-install` 使用系统临时目录作为本次 npm cache 后通过，独立安装本地 tarball，只发现 `analyze_video(video, question?)`，stdio initialize/listTools 正常；未付费或发起真实 provider 请求。之后的桌面 MCP 调用中，原片报告背景音乐且本地 PCM 非零；20 秒静音对照本地统计 960512 个零样本，MCP 报告 `audio_track_present=true`、`audio_observed=false`、`audio_observations=[]`。该静音样本没有触发模型声称 heard 的冲突分支，因此该 live 冲突路径仍未验证。仍未验证 Node 22、Linux/macOS、其它 FFmpeg 版本及长媒体。

2026-09-25 否定 heard 定向修复验证：新增本地合成静音/模拟 provider 回归覆盖整句否定、无括号的“未检测到背景音乐”、否定后接正向声音声明、词表外正向声音描述，以及本地测量不完整时不改写。五项门禁通过，`npm test` 为 304 passed / 12 skipped；`npm run test:pack-install` 通过，stdio 仅注册 `analyze_video(video, question?)`。本轮没有真实 provider 或付费调用；桌面 live `heard` 冲突路径仍未触发验证。

2026-09-25 后续独立 live 验证：从重新全局安装的 `dist/index.js` 启动独立 stdio MCP 进程，对同一 20 秒已验证全零 AAC 对照用 `qwen3.5-omni-plus` 成功完成 1 次真实 provider 调用（约 27.3 秒）；结果为 `audio_observed=false`、`audio_observations=[]`、`video_observed=true`、`isError=false`。模型本次未返回前两次出现的阴性 `heard` 措辞，因此这只验证了新安装包的独立 live 路径，没有 live 复现或验证阴性 `heard` 规范化与正向 heard 冲突；相关分支仍由 mock 回归覆盖。上段“本轮没有真实 provider 调用”指定向修复质量门阶段；本段记录其后的 1 次 live 调用。

2026-09-25 桌面 MCP 后续验证：同一 20 秒全零 AAC 对照的 SHA256 前后不变，重启后桌面内 MCP 以 `qwen3.5-omni-plus` 成功完成 1 次真实调用。结果 `isError=false`，coverage 显示 `audio_track_present=true`、`audio_observed=false`、`video_observed=true`，`audio_observations=[]`、无 `evidence_conflicts`，并明确给出 PCM 全零；正文与结构化推断没有再称当前/实际音轨缺失。模型没有返回 `heard` 否定项，故未 live 验证该具体规范化，也未触发正向冲突路径。仍待评估的输出文字是“无法排除存在极低音量或压缩丢失的音频成分”（“极低音量”与全零 PCM 可能造成语义混淆）以及把“整个视频片段中未检测到任何可辨识的声音”列为“无效时间码”的冗余不确定项；本 ADR 不把这两项记为已修复。
