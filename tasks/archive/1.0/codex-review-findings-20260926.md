> **历史归档（2026-09-26）：** 本文保留当时的计划、结论和未验证项，不作为当前实施指令或发布状态。当前入口见 [开发交接](../../../DEVELOPMENT_HANDOFF.md)，发布事实见 [1.0.0 发布记录](../../../tasks/release-1.0.0.md)。

# 下一大版本媒体网关独立审核结论（2026-09-26）

范围：按 `tasks/archive/1.0/codex-review-brief-20260925.md` §2–§6 对当前工作区做只读源码、文档和零成本测试审核。基线为分支 `codex/optimization-prep`、HEAD `2d1519e`（领先 `origin/main` 23 个提交）；开始审核时工作区干净。本文是审核产物；没有修改实现、提交、推送、打 tag、发布、读取密钥或私人媒体，也没有发起付费调用。

## 结论

**暂不建议发布下一大版本。** 单 Tool 和 Agent 主导的方向与 ADR 0024 一致；公开 schema、媒体路由、根目录授权与错误白名单有相应实现和模拟测试。以下四项实现问题影响安全或契约：回答脱敏漏掉常见绝对路径、缓存可能复用同路径下的旧媒体、MP3 时长可能被误报、取消在上传或重试等待阶段会被误报为失败/超时。另有 prompt 空白被裁剪和文档状态矛盾。零成本门禁全绿不覆盖这些反例。

## 不通过项（按修复优先级）

### F1 [P1] 回答中的部分绝对路径未脱敏

- 证据：`src/server.ts:172-189` 把模型回答经 `sanitizeSensitiveText` 同时放入 `content[0].text` 与 `structuredContent.answer`；`src/sanitize.ts:15-21` 仅匹配反斜杠 Windows 路径和少数 POSIX 根。零网络复现：`node --import tsx -e "import('./src/sanitize.ts').then(m=>console.log(m.sanitizeSensitiveText('C:/Users/demo/video.mp4 /tmp/demo.mp3 /var/tmp/sample.mov')))"`，输出原样为 `C:/Users/demo/video.mp4 /tmp/demo.mp3 /var/tmp/sample.mov`。
- 影响：模型若回显 Agent prompt 中的本地媒体路径，这些路径会进入两种 Agent 可见成功字段，与 `docs/SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md:72`、简报 §6 第 6 项的脱敏要求冲突。这里证明的是出口缺口，并未用真实媒体触发服务商回显。
- 最小修复：扩展 sanitizer 到正斜杠 Windows 盘符和一般 POSIX 绝对路径，避免误伤普通 URL；用上述三类 canary 加上现有 `oss://`、Key 用例检查文本与结构化字段一致脱敏。

### F2 [P1] 缓存键不能识别同路径、同大小、同 mtime 的新文件

- 证据：`src/media.ts:98-109` 的请求内身份复核比较 `dev/ino/size`，但 `src/media.ts:579` 交给缓存的 `identityKey` 只有规范路径、字节数和 `mtimeMs`。`src/upload-cache.ts:48-57,148-160` 用这个键命中旧 `oss://`。现有 `test/media-identity.test.ts:58-72` 仅验证一次请求内的替换；`test/upload-cache.test.ts:78-110` 未覆盖两次调用间以相同长度、恢复 mtime 的文件替换。
- 影响：替换文件后若路径、大小、mtime 相同，请求内复核仍可通过，但第二次调用可复用第一次上传对象，让模型分析旧内容。该条件可由文件替换后恢复修改时间构造；不需要假设哈希碰撞。跨 Key 隔离本身已有实现和测试，此项是**媒体身份**隔离缺口。
- 最小修复：把已打开句柄的稳定身份信息纳入缓存键；若平台不能可靠提供跨重启身份或内容变更标记，则对不确定项禁用缓存命中。加同路径、同大小、同 mtime、不同文件内容/身份的回归测试，并验证跨进程磁盘缓存。

### F3 [P1] MP3 只查前 16 帧就把全文件当作恒定码率

- 证据：`src/mpeg-audio.ts:209-228` 最多采样 16 帧，`src/mpeg-audio.ts:240-250` 在这些帧码率一致且无 Xing/VBRI 时，用首帧码率估算整文件。用仓库 `test/mp3-fixtures.ts` 的内存帧构造 16 帧 128 kbps + 100 帧 32 kbps，`probeMpegAudio` 返回 `durationSeconds: 1.067`；按 116 帧、每帧 1152/44100 秒，实际帧时长约 3.030 秒。现有 `test/mpeg-audio.test.ts:92-98` 的变码率样本在采样窗口内变化，未覆盖该情况。
- 影响：`src/media.ts:613-615` 用这个数字执行一小时限制，`src/server.ts:115-116` 将其作为可靠的本地时长输出。长音频可能被错误放行、拒绝，或把估值当事实，与规格中“无法可靠求出则 unknown”冲突。反例是纯内存合成帧，未上传媒体。
- 最小修复：没有可验证的 Xing/VBRI 帧数时，不凭固定前缀断言全文件 CBR；返回未知时长，或设计有上界且覆盖末端/全段的验证策略后再宣称可靠。加“第 17 帧后才变码率”及一小时边界用例。

### F4 [P2] 主动取消在上传和推理重试等待阶段被错误分类

- 证据：上传 policy 请求的 `catch` 固定给 `UPLOAD_POLICY_FAILED`（`src/upload.ts:295-309`）；multipart 上传的 `catch` 固定给 `MEDIA_UPLOAD_FAILED`（`src/upload.ts:381-386`）。`src/bailian.ts:167-184` 的退避等待收到 abort 时固定抛 `PROVIDER_TIMEOUT`，而外层在 `src/bailian.ts:362` 的 `await sleep(...)` 之后没有再次区分外部取消。`src/server.ts:316,349-350` 将上传器错误直接作为最终错误返回。
- 影响：Host 取消已启动的上传或 429/502/503 后的等待时，最终可能是上传失败/超时，而非 `MEDIA_ANALYSIS_CANCELLED`、`stage=aborted`。已有取消测试 `test/tools.test.ts:620-655` 走分析器主动返回取消，未覆盖这两个真实分支。资源清理路径存在，但本次未做带活动网络连接的端到端取消验证。
- 最小修复：在调用边界和等待异常处先判断 Host signal，将主动取消统一归为取消；保留真正的上传/推理超时类别。加 policy、multipart、退避等待三处取消模拟测试，检查句柄和流释放。

### F5 [P2] 规格与验收记录中存在互相矛盾或过强的状态陈述

- 证据：`docs/SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md:3` 说实现“尚未提交或发布”，但 `DEVELOPMENT_HANDOFF.md:5,25` 与 git HEAD 表明已本地提交、尚未发布。规格 `:20` 说 MP3 `input_audio` + OSS 已实测可用，`:104` 却说组合仍为未验证假设，和 `docs/PROVIDER_PROTOCOL.md:181-215` 的历史 live 记录不一致。`tasks/zcode-probe-report-20260925.md:88`、`tasks/todo-next-major-media-gateway.md:79,123` 把音调回答写成“模型确实读到了音频”，同报告 `:25` 和 `docs/API_CONTRACT.md` 的“不能据此认定听到”边界冲突。简报 `:7,123` 的 HEAD `40987f5` / 领先 22 也落后于实际 `2d1519e` / 23。
- 影响：接手者可能误判发布准备度、把 live 当未验证，或把模型回答当独立的听觉证明。此处没有发现“未发布写成已上线”的主线错误；`API_CONTRACT.md`、`ARCHITECTURE.md` 和 README 的未发布标注方向正确。
- 最小修复：规格状态改为“已本地提交、未推送/发布”；§服务商能力引用已完成的具体 MP3 探针并保留跨模型不外推边界；把“确实读到”改成“回答与音调样本一致，不能单凭回答证明内部模态路径”；更新简报的快照或明确它记录的是写作前一提交。

### F6 [P3] `prompt` 未逐字转发

- 证据：`src/server.ts:214-220` 校验 `raw.trim()` 后返回 `trimmed`；简报 §3 与 §6 第 2 项要求逐字转发，`docs/API_CONTRACT.md` 说明 trim 后长度校验，同时又要求服务端不改写 Agent 问题。
- 影响：前后空格和换行会被删除。一般语义影响小，但与明确的逐字契约和代码注释 “passed through as-is” 不一致。
- 最小修复：对 `raw.trim()` 做非空/长度判断，返回原 `raw`；如产品决定裁剪首尾空白，则先把规格、简报和测试写成“规范化转发”，不称逐字。

## §6 十二项审核清单

| #   | 判定       | 证据与范围                                                                                                                                                                                                                        |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **通过**   | `src/server.ts:272-282` 只注册 `analyze_media`，输入仅必填 `media`/`prompt`；`test/tools.test.ts` 与 `scripts/pack-install-e2e.ts` 有契约断言。未在本次重跑安装。                                                                 |
| 2   | **不通过** | 无业务提纲、无证据纠错二次请求：`src/bailian.ts:45-81`、ADR 0024；但 `src/server.ts:214-220` 裁剪 prompt，见 F6。429/502/503 的一次传输重试是契约允许的例外。                                                                     |
| 3   | **通过**   | `src/server.ts:165-193` 同一 `answer` 用于文本和结构化字段；没有固定报告层。脱敏覆盖不完整另见 F1。                                                                                                                               |
| 4   | **不通过** | HTTPS 与本地字段出现条件见 `src/server.ts:110-122,165-193`，缓存字段仅本地赋值；但 MP3 `duration_seconds` 可被不可靠估算污染，见 F3。                                                                                             |
| 5   | **通过**   | 根目录与 `FileHandle` 身份链见 `src/media.ts:545-579`，旧变量只被配置体检识别见 `src/config.ts:49-60,180-228`；同句柄上传见 `src/upload.ts`。这是静态审阅加 mock 测试，不能宣称完全消除同账户 TOCTOU。                            |
| 6   | **不通过** | `src/sanitize.ts:15-21` 漏掉 `C:/`、`/tmp/` 等路径；内存 canary 可复现，见 F1。错误路径的白名单脱敏见 `src/errors.ts`，本项失败发生在成功回答。                                                                                   |
| 7   | **不通过** | 上传与退避等待取消错分，见 F4。已有正常路径 finally 关闭 `FileHandle`（`src/server.ts:345-347`），但未独立证明所有活动流取消后的回收。                                                                                            |
| 8   | **不通过** | `src/upload-cache.ts:41-57,148-168` 隔离 Key、模型和端点，不缓存明文 Key；媒体身份键不足，见 F2。失败不写成功项由 `test/upload-cache.test.ts:123-146` 覆盖。                                                                      |
| 9   | **存疑**   | `src/provider-error.ts:52-82`、`test/bailian.test.ts:274-322` 覆盖 SSE 与 HTTP 模拟形态，HTTP 拒绝有历史现场（`tasks/zcode-probe-report-20260925.md:31-60`）；修复后的 SSE 形态尚无 live 复验。按简报已知边界，不据此判代码缺陷。 |
| 10  | **通过**   | `src/bytes.ts` 的预算与 `src/mpeg-audio.ts:175-205` 的先判 `ftyp`、`test/mpeg-audio.test.ts:71-90,111-118` 支持有界解析结论；此项不含时长可靠性，后者见 F3。                                                                      |
| 11  | **不通过** | 已发布与未发布主线区分正确，但规格提交状态、自相矛盾的 MP3 协议状态及模型听觉断言不诚实，见 F5。                                                                                                                                  |
| 12  | **不通过** | 实现的 `limitationsFor` 明确声明本地不证明模型听到（`src/server.ts:124-151`）；历史探针结论用了更强的“确实读到”，见 F5。未发现“已逐帧核验”表述。                                                                                  |

## 验证分层与未验证边界

- **模拟/本机门禁，本次复跑：** `npm.cmd run typecheck`、`lint`、`format:check`、`test`、`coverage`、`build` 均退出 0；测试 17 文件、264 passed、1 skipped；覆盖率 statements 88.24%、branches 81.95%、functions 90.47%、lines 89.67%。这些测试只用 mock，没有真实 API 请求。
- **打包安装：** 简报记载此前通过 `test:pack-install`/`test:install`；本次未重跑安装脚本，也未读取其产物。本次 `build` 通过不能代替安装握手证明。
- **真实百炼：** `docs/PROVIDER_PROTOCOL.md` 与任务清单记载 MP4/MOV/MP3 历史调用和拒绝样本。本次只审阅记录，没有重新上传、调用或核账单；模型回答与样本相符只支持该次观察。
- **宿主 GUI：** ZCode 三文件记录与 Codex 公开 MP4 记录是历史证据；本次未操作 GUI。Codex 新会话拖入、宿主内 MOV/MP3 仍待验。
- **npm 发布：** 下一大版本未发布；`package.json` 仍为 `0.6.1`，已发布版是旧 `analyze_video` 契约。本次未查询注册表，按仓库版本与既有发布记录判断。
- **既知边界，不列为实现缺陷：** 音频-only MP4 的 400 根因未定；`MEDIA_MODEL_UNSUPPORTED` allowlist 未真实命中；模型段数/时间点可能错；成功结果无 `request_id` 是现有契约；Node 22、SSE 内容检查 live 复验、一小时附近行为与费用金额未在本次核验。

建议先处理 F1–F4 并补反例测试，然后修 F5/F6 文档与契约，重跑零成本门禁及打包安装。是否进行新的真实服务商或宿主验证，按现有授权与费用规则另行决定；本审核不将其当作已完成。
