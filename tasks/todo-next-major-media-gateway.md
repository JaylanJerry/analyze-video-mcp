# 下一大版本媒体网关任务清单

状态（2026-09-26）：**A、B、C、D1、D2、D3 已实现并通过本地门禁；A-P 与 D4 的服务商格式矩阵已完成真实验证；Codex 当前任务的 MCP Tool 已用公开 MP4、合成 MOV、合成 MP3 各成功调用一次；ZCode GUI 新会话的拖入 MOV 与 MP3 也已通过。** Codex **新会话手动拖入**、最新构建经新 MCP 进程加载、费用金额和 Node 22/24 CI 仍未验证。ZCode 会话留下的内容检查 HTTP 400 现场与模型计数反例仍见 D4。当前分支已本地提交，未推送、未发布；npm 上的 `0.6.1` 仍是 `analyze_video`。最新独立验收见 [`codex-acceptance-20260926.md`](codex-acceptance-20260926.md)，总计划见 [`plan-next-major-media-gateway.md`](plan-next-major-media-gateway.md)。

**本轮本地门禁（2026-09-25，Windows / Node 24.18.0）：** `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm test`（264 passed / 1 skipped / 17 files，HEAD `43584e1` 上复核）、`npm run coverage`（All files 88.24% stmts / 81.95% branch / 90.47% funcs）、`npm run build` 全部通过；`node dist/index.js --doctor` 报告 `handshake.registered=true` 且只注册 `analyze_media`。**Node 22 未在本机验证**（CI 会在 22 与 24 上跑，但本轮没有推送）。所有测试均为 msw 模拟，零真实请求、零费用。

## A. 契约和安全基线

- [x] **A1 新 Tool 契约**：`analyze_media(media, prompt)`，`prompt` 必填；`media` 为本地 MP4/MOV/MP3 或公开 HTTPS 视频 URL。
  - 证据：`src/server.ts` 只注册一个 Tool；`test/tools.test.ts` 断言 schema 只有 `media`/`prompt` 且都必需、无 provider/model/预算字段；宽泛与具体 prompt 都逐字送达（`calls[0].request.prompt` 等于原文）；每次调用只请求一次（无纠错重试）；空白与超长 prompt 被拒且不调用 provider。
  - 错误码迁移表：`docs/API_CONTRACT.md` 的「迁移表：旧契约 → 新契约」，逐项对应 `src/errors.ts` 的 `AGENT_ERROR_CODES`。
- [x] **A2 权限配置迁移**：本地授权只来自 `MEDIA_ALLOWED_ROOTS` / `MEDIA_ALLOW_ANY_LOCAL_FILE`（默认 `off`）。
  - 证据：`src/config.ts` 的 `legacyMediaVars` 只识别旧变量名，不参与授权；`test/config.test.ts` 断言同时设置 `QWEN_ALLOWED_ROOTS` + `QWEN_ALLOW_ANY_LOCAL_VIDEO=on` 时 `allowedRoots=[]`、`allowAnyLocalFile=false`；`test/doctor.test.ts` 断言旧变量被报告为失效并给出替代名。
- [x] **A3 保留安全基线测试**：把脱敏、内容检查拒绝、SSE 补全 ID 与 Request ID 区分、取消、重试上限写成与旧报告层无关的测试。
  - 证据：`test/tools.test.ts`（Key/`oss://`/本地路径在文本与结构化结果中都被脱敏，两处答案一致；内容检查拒绝 `PROVIDER_CONTENT_REJECTED`/`retryable:false`/保留 Request ID/不重试；SSE `chatcmpl-…` 不被当成 Request ID；取消返回 `MEDIA_ANALYSIS_CANCELLED`）、`test/bailian.test.ts`（429/502/503 各至多重试一次、收到文本后不重试、未知 provider 错误码保持通用失败）、`test/sse.test.ts`。
  - 旧报告层专用测试已随 `src/evidence.ts` 删除，未跳过任何仍有效的断言。

**检查点 A：** 契约与权限边界已由测试冻结；`npm test` 默认零网络。 ✅

- [x] **A-P MP3 协议可行性**：mock 已固定，**真实探针已于 2026-09-25 通过**（用户授权）。
  - 已固定（mock）：`{type:"input_audio", input_audio:{data:"oss://…", format:"mp3"}}`、`X-DashScope-OssResourceResolve: enable`、本地音频上传元数据 `audio.mp3`/`audio/mpeg`、以及明确模态拒绝时的 `MEDIA_MODEL_UNSUPPORTED`（固定 allowlist）。证据：`test/bailian.test.ts`、`test/tools.test.ts` 的 MP3 wire 断言、`test/upload.test.ts`。
  - 真实结果（默认地域、`qwen3.8-omni-flash`）：非私密合成样本（9.04 秒、三段递增音调）同一进程内两次调用都成功，模型准确说出三段、依次升高、每段约 3 秒；`usage` 188/474/662 与 188/725/913，SSE 事件 179/239，request id `2da18856-…` 与 `d52ed864-…`；第二次 `upload_reused:true` 且仍是新的分析。**（2026-09-25 更正：同一文件在宿主会话的第三次调用把段数报成 4 段、切换点报成 2/5/8 秒，与本地实测的 3 段、≈2.9/5.9 秒不符——见 D4。上面这两次“准确”只对当时调用成立，不能当作模型的稳定行为。）** 890 秒真实 MP3 同样成功（`usage` 6350/1541/7891、575 事件、22 秒）。
  - 脱敏核验：全部运行的 stderr 与正文都不含 `oss://`、密钥或本地路径。
  - 模型能力探针（2026-09-25，3 次调用）：`qwen-plus` 对 `input_audio` **未报错**，`prompt_tokens` 为 78（omni 为 188），输出 3 token，回答「听不清。」；这没有证明其利用音频，也不能仅凭跨模型 token 差异证明它忽略了音频。本账号未开通的 `qwen-vl-max-latest` 返回 **403**。`MEDIA_MODEL_UNSUPPORTED` 至今**没有真实命中样本**，allowlist 仍只有 mock 证据；403 的 Agent 文本已补充“模型是否已开通”。详见 `docs/PROVIDER_PROTOCOL.md` §3b。
  - 仍未验证：费用金额。
  - 记录：`docs/PROVIDER_PROTOCOL.md` §3b（含负例）。

**检查点 A-P：** 组合可用已由真实调用证明，mock 与真实证据分开记录。 ✅

## B. 视频薄路径

- [x] **B1 视频请求与原回答**：MP4/MOV 走现有授权句柄、上传与百炼 `video_url`，只带 Agent 问题与固定协议说明。
  - 证据：`src/bailian.ts` 的 `buildMediaPayload` + `PROTOCOL_NOTE`（不含时间线/构图/色彩/音乐/优缺点/用途建议等提纲词）；`test/bailian.test.ts` 断言系统消息就是 `PROTOCOL_NOTE` 且不含提纲词；`test/tools.test.ts` 断言 wire 上的 system 文本不含「证据」「JSON」，user 轮就是提问原文。
- [x] **B2 视频结果与错误**：确定来源的文件事实、实际模型与用量、缓存命中与限制进入元数据；不从音轨事实推导「听到」。
  - 证据：`test/tools.test.ts` 断言本地 MP4 → `media={kind:"video",container:"mp4",duration_seconds:3,audio_track_present:true}`；HTTPS → 只有 `kind`；轨道探测不完整不填 `audio_track_present=false`（`src/server.ts` 的 `mediaFacts` 只在 `trackProbeComplete===true` 时出现）；`limitations` 按类型区分且声明“本地轨道探测不代表模型确认听到”；远端 `.mp3` URL 被拒。
- [x] **B3 视频端到端资源**：进度、缓存、取消与长请求边界，保留同句柄上传与身份复核。
  - 证据：`test/tools.test.ts` 断言四步进度（校验→上传→等待→完成，HTTPS 无上传步）、第二次调用 `upload_reused=true` 仍重新分析；`test/upload-cache.test.ts` 断言换 Key 后不命中旧项且缓存文件不含 Key；`test/media.test.ts` 的 junction/替换/根越界反例仍在。

**检查点 B：** MP4/MOV 新入口模拟端到端可用，安全门未回退，`npm run build` 成功。 ✅

## C. MP3 纵向切片

- [x] **C1 本地 MP3 识别与授权**：有界 MPEG 解析 + 授权链。
  - 证据：`src/mpeg-audio.ts`（ID3v2 跳过、窗口内定位首帧、连续帧校验、Xing/VBRI 与恒定码率时长、合理性校验、读取预算）；`test/mpeg-audio.test.ts` 13 例；`test/media.test.ts` 的「local MP3 support」9 例（接受、伪造后缀、仅 ID3、Layer II 点名编码、超大小、超时长、根外、远端 `.mp3` 拒绝、query 里的 `.mp3` 不算）。
- [x] **C2 百炼音频适配**：`input_audio` 与共享 SSE/错误/上传逻辑。
  - 证据：`src/bailian.ts` 的 `contentBlock`；`src/upload.ts` 按容器给出 `audio.mp3`/`audio/mpeg`；`test/tools.test.ts` 的 wire 断言（`input_audio.format="mp3"`、`data` 为 `oss://`、Header 为 `enable`、请求体无 base64）。
- [x] **C3 MP3 Tool 端到端**：一个入口自动按本地类型路由，MP3 元数据与视频同形状。
  - 证据：`test/tools.test.ts` 的 MP3 端到端例（`media={kind:"audio",container:"mp3",duration_seconds:…}`，无视频轨或缺轨结论）。

**检查点 C：** mock MP3 流程与 A-P 的真实百炼 MP3 验证均通过；MP3 在宿主中的调用仍待验收。 ✅

## D. 收口、迁移、真实验收

- [x] **D1 移除旧 Tool/报告专用逻辑**：只剩 `analyze_media`；固定提纲、证据 JSON/纠错再问/文本重排、可选 FFmpeg 静音测量全部删除，独立安全防护保留。
  - 证据：`git rm src/evidence.ts src/audio-silence.ts test/evidence.test.ts test/evidence-text.test.ts test/audio-silence.test.ts`（内容仍在 git 历史中）；`src/sanitize.ts` 保留原 `sanitizeSensitiveText`；`test/version.test.ts`、`test/sse.test.ts` 等独立防护回归仍通过；doctor 不再断言旧 Tool。
- [x] **D2 文档与安装迁移**：README（下一大版本横幅 + 迁移表）、`docs/API_CONTRACT.md`（重写为本分支契约 + 迁移表）、`docs/ARCHITECTURE.md`、`docs/PROVIDER_PROTOCOL.md`（新增 §3b 音频协议并标注历史小节）、`docs/SECURITY.md`、`docs/README.md`、`.env.example`、`examples/*`（保留 0.6.1 示例并标注下一大版本映射）、`AGENTS.md`。
  - 证据：文档同时区分「已发布 0.6.1」与「本分支未发布」；MP3 的模拟、服务商真实调用与宿主调用分别标记。
- [x] **D3 完整无付费门禁**：见文首本轮门禁结果；打包安装链路也已验证。
  - 打包证据：`npm run test:pack-install` → `{"ok":true,"packed_files":38,"tools":["analyze_media"],"fields":["media","prompt"],"runtime_sdk":true}`；`npm run test:install` → `{"ok":true,"tool_count":1,"tools":["analyze_media"],"fields":["media","prompt"]}`。
  - 环境注记：本机 `pack-install-e2e.ts` 需要对 GNU tar 规避 Windows 路径问题（GNU tar 把 `C:\…` 当远程主机，报 `Cannot connect to C: resolve failed`）。本轮把 `C:\Windows\System32` 放到 PATH 前面用 Windows 自带 bsdtar 跑通；脚本本身未改，Linux CI 不受影响。两个 e2e 脚本中钉死的 dist 模块清单与 Tool 字段已同步为本分支的新模块（`bytes/mpeg-audio/sanitize/provider-error/sse`）与 `media`/`prompt`。
  - 未验证项：**Node 22 本机未跑**（只有 Node 24）；CI 状态未知（未推送）。
- [ ] **D4 受控真实验收（独立授权，部分完成）**：服务商格式矩阵与拒绝案例已完成；Codex 当前任务与 ZCode GUI 新会话的 MCP 调用各通过一次，宿主完整矩阵、Codex 侧手动拖入与费用金额仍缺。
  - **本会话（ZCode，2026-09-25）三个文件的完整交接报告：** 见 [`zcode-probe-report-20260925.md`](zcode-probe-report-20260925.md)，含逐字 prompt、本地复现命令、逐项对照表与需要原窗口处理的事项清单。
  - 已完成（2026-09-25，用户授权；共 7 次真实调用，5 次成功、2 次被服务商 400 拒绝）：
    | 样本                                                   | 结果                                                                                                                                                                           |
    | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
    | 合成 MP3，9.04 秒（非私密）                            | 成功 ×2：三段递增音调描述正确；第二次 `upload_reused:true`。**注：同一文件 2026-09-25 的第三次调用把段数报成 4 段、切换点报成 2/5/8 秒（本地实测为 3 段、≈2.9/5.9 秒），见下** |
    | 真实 MP3，890 秒（用户内容，经转码派生，原文件未改动） | 成功：内容概括与音频一致；`media.kind=audio`、`duration_seconds=889.99`                                                                                                        |
    | MP4，H.264+AAC，3 秒（公开夹具）                       | 成功：画面 `24` + 语音 `3.1415926`；`usage` 784/213/997、78 事件                                                                                                               |
    | MOV，同码流 `-c copy` 转封装                           | 成功：画面 `24` + 语音 `3.1415926`；`usage` 784/223/1007、75 事件；`container=mov`                                                                                             |
    | 音频-only MP4（`ftyp isom`，无视频轨，890 秒）         | **服务商 HTTP 400**（复现 2 次，无 SSE 事件与用量）：见 PROVIDER_PROTOCOL §3b 负例与原因未定位说明                                                                             |
  - **Codex 宿主补验（2026-09-25，当前任务，一次真实调用）：** 当前 Tool 列表含 `mcp__analyze_video_mcp__analyze_media`；用仓库公开 `test/fixtures/live-av.mp4`（30,988 bytes，3 秒；前后 SHA-256 均为 `2193544187DCCFEBBE68CF377FEE063DC599300D27D5447A05CD63E984B98A76`）提问“分别报告画面数字和音轨语音数字，不互相推断”。返回 `isError=false`、`media.kind=video`、`audio_track_present=true`、`request.model=qwen3.5-omni-plus`、`upload_reused=false`、`usage=770/26/796`；`content[0].text` 与 `structuredContent.answer` 一致，分别报告看到 `24`、听到 `3.1415926`，与夹具说明一致。仅核对了 Agent 可见结果；没有检查该次服务端 stderr 或账单。此项证明当前 Codex 任务的 Tool 挂载与真实调用，未验证新会话的手动拖入流程。
  - **Codex 当前任务 MOV/MP3 补验（2026-09-26，用户分别授权，各一次）：** `%LOCALAPPDATA%/Temp/live-av.mov`（31,039 B、3 秒、H.264 + AAC）返回 `isError=false`、`container=mov`、`audio_track_present=true`、`request.model=qwen3.5-omni-plus`、`upload_reused=false`、`usage=769/26/795`；回答画面 `24` 与语音 `3.1415926`，与公开夹具说明一致。`%LOCALAPPDATA%/Temp/probe-tones.mp3`（72,559 B、SHA-256 `F47B19D9…C4545CB`）返回 `isError=false`、`container=mp3`、`duration_seconds=9.038367346938776`、同一模型、`upload_reused=false`、`usage=151/98/249`；回答电子纯音三段、音高逐段升高，与合成样本一致。两次文本/结构化答案相同；没有查账单或服务端 stderr。此项只验证当前任务已挂载的 MCP 调用链，不能证明模型内部模态路径、新会话手动拖入或本轮最新代码已由新 MCP 进程加载。完整记录见 [`codex-acceptance-20260926.md`](codex-acceptance-20260926.md)。
  - **ZCode 重装与同款启动测试（2026-09-25）：** ZCode `~/.zcode/cli/config.json` 里原本那条 `analyze_video_mcp`（指向已删除的 `Documents\Codex\Video MCP`）已**整条删除并重新注册**为当前仓库：`command=C:\Program Files
odejs
ode.exe`、`args=[<repo>\dist\index.js]`、`cwd=<repo>`、`timeoutMs=3600000`、`enabled=true`、env 为 `QWEN_MODEL` / `MEDIA_ALLOWED_ROOTS` / `MEDIA_ALLOW_ANY_LOCAL_FILE=on`（键均在 ZCode 严格 schema 内；备份 `.bak-before-reinstall`）。用**与 ZCode 完全相同的启动方式**（同一 node 可执行文件、同 args/cwd/env）完成真实调用：公开 MP4 夹具 → 画面 `24` + 语音 `3.1415926`、`usage` 786/181/967、64 事件、`upload_reused=true`；合成 MP3 同一进程两次 → 均正确（三段、低→中→高）、`usage` 178/536/714 与 178/384/562。这验证的是**ZCode 的启动接线**，不等于 GUI 会话已验收（宿主在会话启动时挂载工具）。
  - **ZCode GUI 新会话实测（2026-09-25，用户在本会话直接拖入并要求调用 MCP；一次真实调用）：** 用户把 `C:\Users\jjbon\AppData\Local\Temp\live-av.mov`（31,039 bytes，3 秒）作为附件拖入 ZCode 输入框；宿主因当前会话模型不支持视频输入而只把**本地路径**交给 Agent（会话里显示 `Media omitted from provider request`），该路径随即交给本会话已挂载的 `mcp__analyze_video_mcp__analyze_media`。返回 `ok=true`、`media.kind=video`、`container=mov`、`duration_seconds=3`、`audio_track_present=true`、`request.provider=dashscope`、`request.model=qwen3.8-omni-flash`（本会话未覆盖 `QWEN_MODEL`）、`upload_reused=true`、`usage=904/3212/4116`；回答分别报告画面为白底居中衬线体数字 `24`、声音为朗读数字 `3.1415926`，与夹具真值一致。**输入同一性已本地核对**：该 MOV 是仓库公开夹具 `test/fixtures/live-av.mp4` 的 `-c copy` 转封装 —— 两者 `mdat` 载荷逐字节相同（27,639 bytes，SHA-256 `4F8F8FC5405ACF5871C0EBAD088E5E6A…`），仅容器头不同（MOV 为 `ftyp qt` + `wide`，MP4 为 `ftyp isom` + `free`），所以这是一次同一码流的画面 + 内嵌声音真实读取。**观察（不算证据）：** 模型自述其声音判断依据是“随视频提供的音频转写文本”，这是模型对自身处理的叙述；服务端只发 `video_url`/`input_audio` 原始块，没有额外转写步骤，不能据此认为服务端做了 ASR，也不能据此认为模型一定听到了原始声波。本次只核对 Agent 可见结果，未查服务端 stderr、未核对账单；成功路径的 `structuredContent` 不含 `request_id`（该字段只出现在错误对象与服务端 stderr 诊断行，见 `src/server.ts`），因此这次没有可从 Agent 侧记录的 request id。
  - **内容检查拒绝的真实现场（2026-09-25，ZCode GUI 同一会话，一次真实调用）：** 用户拖入自己的 14 分 50 秒视频（`1_merged.mp4`，112,544,441 bytes，889.95 秒，HEVC `hvc1` 1280×720 + AAC）要求分析，请求被服务商内容检查拦截：`code=PROVIDER_CONTENT_REJECTED`、`retryable=false`、`stage=analyzing`、`http_status=400`、`inspection_side=unknown`、`request_id=41ba2c43-28b3-95b2-8dfd-ce5655b61ab4`、`diagnostics={parse_reason:provider_error, error_code:data_inspection_failed}`；没有返回任何分析内容，同样没有用量与事件计数。**这是 ADR 0023 修复后该错误的首次真实样本，也是 HTTP 400 错误正文这一形态的首次真实样本**（此前真实样本都在首个 SSE 事件里，而正文在修复前被直接丢弃）；带回的 Request ID 是 UUID 形态而不是 `chatcmpl-…` 补全 ID，说明修正后的来源规则在正文路径上确实生效（仍无法区分它来自响应头还是 JSON 字段）。本地门禁先放行了该文件（HEVC `hvc1` 与 889.95 秒都被接受），失败发生在推理阶段，因此拦截来自服务商而非本机；Agent 可见的错误文本里没有路径、`oss://` 或密钥。按 Tool 提示与 ADR 0023 **没有重试同一媒体**。未核对该次是否计费（无用量返回），未查服务端 stderr；上传阶段是否命中缓存未知。
  - **相关联的疑点（未证实，勿当成结论）：** 同一部 890 秒源视频此前派生的“无视频轨音频-only MP4”两次得到裸 `HTTP 400`（无识别错误码，见 [AGENTS.md](../AGENTS.md) 1c），当时实现丢弃了错误正文，那两次的真实原因已不可回溯；既然同源源文件如今明确返回 `data_inspection_failed`，内容检查是那些 400 的候选原因之一。要分辨只能在获得新授权后重跑那个音频-only 文件，看它现在是否返回该错误码——本次没有做。
  - **ZCode 宿主 MP3 实测与模型可靠性反例（2026-09-25，ZCode GUI 同一会话，一次真实调用）：** 用户拖入 `C:\Users\jjbon\AppData\Local\Temp\probe-tones.mp3`（72,559 bytes，9.0 秒，单声道 44.1 kHz；SHA-256 `f47b19d9c0c4eb01a0e880c6a1b3c974dbad985282f6e8002cc1b0a47c4545cb`）——它就是 §3b 记录的那份 72,559 B 样本（同大小、同 9.04 秒时长，且 `upload_reused:true` 说明该路径/大小/mtime 先前已上传过）。返回 `ok=true`、`media.kind=audio`、`container=mp3`、`duration_seconds=9.038`、`request.model=qwen3.8-omni-flash`、`upload_reused=true`、`usage=274/1522/1796`。回答说“纯音调、单一正弦、无人声、**4 段**依次升高、切换点 2/5/8 秒”。**本机独立测量否定了其中的计数与时间点**：`ffprobe` 的 `aspectralstats=measure=centroid`（8192 窗，纯本地、不经服务端）显示只有 3 个平台区 ≈461 / 900 / 1778 Hz（即文档里的 440 / 880 / 1760 Hz），各约 2.79 秒，切换点在 ≈2.9 秒与 ≈5.9 秒——**段数错（4 vs 3）、两个切换点各早约 0.9 秒、并多报了一个 8 秒的切换**；而“纯正弦、无人声、依次升高”的判断正确。**这条对“模型静默忽略音频的防误报”直接有用：回答与样本一致（模态/音色/顺序正确），但它的段数与时间戳不可靠，同一文件先前两次的“三段正确”只是当时的单次结果。** 详见 [PROVIDER_PROTOCOL §3b](../docs/PROVIDER_PROTOCOL.md)。本次只核对 Agent 可见结果，未查服务端 stderr、未核对账单。
  - **用户提供的 8 文件完整回归（2026-09-25，本机、ZCode 同款启动方式，7 次真实调用）**：目录 `C:\Users\jjbon\Videos\MCP测试`。全部先过本地门禁再上传；`视频+音频2.mp4`（112,544,441 B、889 秒、SHA-256 `73f3003d…92ba7`）经哈希比对**确认就是上次被内容检查拒绝的同一文件**，按 ADR 0023 未重传。
    | 文件                                    | 本地事实            | 结果      | usage（prompt/completion/total） | 备注                                                                                                          |
    | --------------------------------------- | ------------------- | --------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
    | `裴掌柜.mp3`                            | mp3 5.18 秒         | ✅        | 165 / 564 / 729                  | 男声独白、无音乐；转写标注用词不确定                                                                          |
    | `梁司正.mp3`                            | mp3 10.10 秒        | ✅        | 200 / 396 / 596                  | 男声台词，内容具体                                                                                            |
    | `沈砚.mp3`                              | mp3 12.12 秒        | ✅        | 214 / 285 / 499                  | 男声旁白；称“后半段基本静音” → **本地 `silencedetect` 证实 6.07–12.12 秒确为静音**（另有 2 处约 0.75 秒停顿） |
    | `纯音频.mp3`                            | mp3 317.4 秒        | ✅        | 2,349 / 863 / 3,212              | 前约 10 秒海浪/风声，随后一整首中文摇滚（男声演唱 + 歌词）                                                    |
    | `纯视频.mp4`                            | mp4 364 秒 / 115 MB | ✅        | 172,037 / 4,590 / 176,627        | 科普动画；音轨**非静音**（mean −22.7 dB，仅数处 1.2–1.6 秒停顿）                                              |
    | `视频+音频1.mp4`                        | mp4 317 秒 / 36 MB  | ✅        | 173,550 / 6,339 / 179,889        | 告五人《愛人錯過》MV；按时间码分段描述                                                                        |
    | `视频+音频.mp4`                         | mp4 1455 秒 / 69 MB | ✅        | 167,008 / 31,642 / 198,650       | 24 分钟讲解视频；10,400 个 SSE 事件、耗时 432 秒                                                              |
    | `视频+音频2.mp4`                        | mp4 889 秒          | ⛔ 未重传 | —                                | 上次内容检查拒绝的同一文件                                                                                    |
    | `synthetic-silence-aac.mp4`（仓库夹具） | 8 秒、PCM 全零      | ✅        | 710 / 125 / 835                  | 模型如实回答“没有声音、整体静音”，工具报 `audio_track_present:true` —— “轨道存在 ≠ 模型听到”的正确配对        |
  - **本轮暴露的三点**：① 长视频用量与耗时都很大（317 秒 ≈ 17.4 万 prompt tokens；1455 秒 ≈ 16.7 万 prompt tokens、耗时 432 秒），工具按设计不含费用/预算旋钮，宿主超时与费用需安装者自行评估；② 模型对具体细节的可靠性是**逐条**的——同一份三音调样本的段数/切换点错，而 `沈砚.mp3` 的静音判断对，因此必须逐条本地核对，不能整体信任或整体否定；③ 成功结果不含 `request_id`（只在错误与 stderr），宿主侧取证无法直接引用它——是否加进成功元数据属于公开契约变更，需要单独决定。
  - 2026-09-25 当时仍未做 Codex 新会话手动拖入与 Codex 宿主 MOV/MP3；后者已于 2026-09-26 在当前任务补验，见独立验收报告。费用金额（不记录账单）、内容检查拒绝在 **SSE 事件形态**下修复后的复验与输入/输出侧别判定（正文形态已有真实现场，侧别仍为 `unknown`）仍未做。**ZCode GUI 新会话与宿主 MP3 已于 2026-09-25 完成。**
  - 样本处理：用户原文件未被修改；派生的 MP3 副本位于系统临时目录。**更正：** 早先记录的“派生 MP3 副本已回收”不适用于 `probe-tones.mp3`——它仍在 `%TEMP%` 中（mtime 2026-09-25 22:06），本次 `upload_reused:true` 也正说明该路径/大小/mtime 先前已被上传过。
  - **宿主配置迁移（2026-09-25，本机，已备份 `.bak-20260925`）**：Codex `~/.codex/config.toml` 的 env 已由 `QWEN_ALLOWED_ROOTS` / `QWEN_ALLOW_ANY_LOCAL_VIDEO` 改为 `MEDIA_ALLOWED_ROOTS` / `MEDIA_ALLOW_ANY_LOCAL_FILE`（值不变，权限不变），`QWEN_AUDIO_SILENCE_CHECK` 行已注释；ZCode `~/.zcode/cli/config.json` 的 `args`/`cwd` 从已不存在的 `Documents\Codex\Video MCP` 改指本仓库 `dist/index.js`，env 同样改名为 `MEDIA_*`。两处都用迁移后的授权跑过 `--doctor`：`local_media_policy.mode=any_local_file`、`handshake.registered=true`、无旧变量警告。
  - **宿主后续验收**：Codex 当前任务已实际调用 MP4/MOV/MP3，ZCode GUI 新会话已调用 MOV/MP3。**仍需验收：Codex 新会话手动拖入及新进程加载最新构建**；不能由当前任务的调用推定新会话已通过。

**最终检查点：** 变更清单见下方「本轮变更文件」；推送、tag 与 npm 发布仍须单独指令。 ⏳

## 独立审核意见的处置（2026-09-26）

`tasks/codex-review-findings-20260926.md` 提出 6 项，逐项处置如下；全部改动只提交、未推送。

**第二轮（2026-09-26，审核复核后）：** 审核者复核 `8437bb2` 后指出 F1/F2/F3 实际未闭环，逐条成立——F2 的指纹当时只在 `media.ts` 计算，缓存键没有用上（我的验证不足）；F3 的多点抽样仍能被采样点之间的变码率区绕过；F1 还漏了前斜杠 UNC 与根级 POSIX 文件。以下三行已按复核结论重写。

| 项                                              | 结论                       | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 [P1] 回答漏脱敏部分绝对路径                  | **第二轮已补齐**           | 第一轮覆盖了反斜杠/正斜杠盘符与多段 POSIX 路径；审核复核发现**前斜杠 UNC**（`//server/share/clip.mp4`）与**根级 POSIX 文件**（`/clip.mp4`）仍原样穿出，现已一并覆盖（根级文件要求带扩展名以降低误伤）。`https://` URL、时间码与相对路径仍原样保留；`test/sanitize.test.ts` 9 例覆盖全部形状                                                                                                                                                                                                                                                   |
| F2 [P1] 缓存不识别同路径同大小同 mtime 的新内容 | **第二轮已真正接通**       | 第一轮的指纹只在 `media.ts` 计算，**缓存键没有使用它**——我当时的验证不足，审核复核以「同 identityKey、不同指纹」构造两次上传仍命中 `reused:true`。现在键为 `identityKey+contentFingerprint+model+endpoint+credential`，并新增两条断言：键格式必须含指纹、只改指纹必须 miss（`test/upload-cache.test.ts` 14 例）。残余「仅改中段且大小与 mtime 不变」经审核确认为**独立类别**（跨请求的陈旧内容，与请求内 TOCTOU 不同）；**本轮按已声明限制接受，不改为全文件哈希**（代价是整文件读取）。若将来收紧，候选为全文件哈希 / inode+ctime / 缩短 TTL |
| F3 [P1] MP3 仅凭前 16 帧断言恒定码率            | **第二轮改为只认声明帧数** | 第一版改为跨文件多点抽样，但审核复核用 `500×128k + 1000×32k + 1000×128k` 证明采样点之间的变码率区仍会被漏掉（旧代码报 45.59 秒，按帧数应为 65.31 秒）。现在**彻底不做码率估算**：只有流自己声明 Xing/Info/VBRI 帧数时才给出时长，否则一律未知，抽样与字节估算代码已删除；回归覆盖开头 CBR 后续 VBR、中段变码率、纯 CBR 无声明、尾部标签、Xing 声明与一小时边界                                                                                                                                                                                |
| F4 [P2] 取消在上传/退避等待被误分类             | **确认，已修**             | `src/bailian.ts` 退避等待的 abort 现在归为 `MEDIA_ANALYSIS_CANCELLED`；`src/server.ts` 在调用边界统一判定——本次运行的控制信号已 abort 时报取消，而不是下层抛出的阶段错误。新增 2 例回归（退避期间取消 → 取消；上传期间取消 → 取消而非 `MEDIA_UPLOAD_FAILED`），并保留“真正的分析超时仍是 `PROVIDER_TIMEOUT`”对照                                                                                                                                                                                                                              |
| F5 [P2] 文档状态互相矛盾                        | **确认，已修**             | 规格状态行改为“已实现并本地提交”；规格 §服务商能力改为引用已完成的 MP3 探针并保留“跨模型不外推”边界；ZCode 报告与任务清单里“模型确实读到了音频”改为“回答与样本一致，但回答本身不能证明内部模态路径”；审核简报标注为写作时快照                                                                                                                                                                                                                                                                                                                 |
| F6 [P3] `prompt` 首尾空白被裁剪                 | **部分同意，已按措辞修**   | 保留裁剪（规格本就以“trim 后”定义校验），但把注释、契约与简报改写成准确表述：“问题本身不重写、不扩写、不截断，只去掉首尾空白”；新增 `test/tools.test.ts` 用例断言内部换行/缩进/双空格原样保留                                                                                                                                                                                                                                                                                                                                                 |

**未采纳的备选**：F2 的“对不确定项禁用缓存命中”。理由是上传复用是既有特性（47 小时磁盘缓存、真实调用已观察到 `upload_reused:true`），在加入内容指纹后剩余风险是“仅中段变化且大小与 mtime 未变”的窄条件；按残余风险记录而不是移除功能。审核若认为必须收紧，请说明可接受的代价。

## 独立审核入口

给 Codex 的审核简报：[`codex-review-brief-20260925.md`](codex-review-brief-20260925.md)（含审核目标、代码地图、复现命令、逐项清单、已知边界与红线）。

## 规格完成标准逐条审计（`docs/SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md` §测试与完成标准）

1. **单 Tool 契约** ✅ 已验证：`test/tools.test.ts` 断言恰好一个 `analyze_media`、schema 只有 `media`/`prompt` 且都必需、无 provider/model/预算字段；宽泛、具体、中文与时间码 prompt 都逐字送达（两次断言原文相等）；每次调用只发一次请求（无二次提问）；旧码到新码的迁移由 `docs/API_CONTRACT.md` 的迁移表逐项列出，并有对应测试断言新码。
2. **夹具与反例** ✅ 已验证（全部无私密合成夹具、端到端走 mock provider）：MP4 有音轨（`test/tools.test.ts` 本地事实例）、**MP4 无音轨**（同文件，断言 `audio_track_present:false` 与对应 limitation，且不改写模型措辞）、MOV 受支持组合与拒绝组合（`test/media.test.ts` MOV support）、MP3（`test/tools.test.ts` + `test/media.test.ts`）；坏魔数、伪装后缀、仅 ID3、Layer II、PCM MOV、超大小、超时长、junction 越界、根外路径、取消、换 Key 后缓存失效、**检查后文件被替换**（新增 `test/media-identity.test.ts`，用 stub 确定性地复现快照与句柄不一致）；HTTPS 直连与远端 `.mp3` 拒绝各有用例。
3. **真实服务商与宿主验收** ⏳ **服务商格式矩阵及当前任务的 Codex MP4/MOV/MP3 Tool 调用已完成**：MP4、MOV、MP3 都有真实百炼调用并得到与样本一致的内容，见 D4 与独立验收报告；ZCode GUI 新会话也已用同码流 MOV 夹具和合成 MP3 调用成功。Codex **新会话手动拖入及新进程加载最新构建**仍未验收；费用金额未知；内容检查拒绝已有一个真实现场（HTTP 400 正文形态，见 D4），SSE 形态在修复后仍未复验，输入/输出侧别仍无真实判定；ZCode 宿主上的 MP3 曾曝出模型计数/时间点不可靠的反例，不能把本轮 Codex MP3 答对当成稳定能力。
4. **脱敏、拒绝与重试** ✅ 已验证：`test/tools.test.ts` 断言 Key / `oss://` / 本地绝对路径在 `content[0].text` 与 `structuredContent` 两处都不出现且两处答案一致；内容检查拒绝 `retryable:false` 且只请求一次（另有 2026-09-25 的真实现场：HTTP 400 正文形态、未自动重试、Request ID 为 UUID 形态，见 D4）；`test/bailian.test.ts` 断言 429/502/503 各至多一次重试、收到文本后不再重试；`test/host-env.test.ts` 断言 stdio 子进程 stderr 不含 `sk-`；第二次调用报告 `upload_reused:true` 且仍重新分析。
5. **门禁** ✅ 本地已验证（Node 24）：typecheck / lint / format:check / test / coverage(88.08/81.71/90.47) / build；独立打包安装与 stdio 握手通过（见 D3）。⏳ **Node 22 未在本机验证**：本机只装了 Node 24，`npx -p node@22` 被本地 `node` 遮蔽（尝试过 `npx -y node@22` 与 `npm exec --package=node@22`，两者都返回 v24.18.0），因此 Node 22 由推送后的 CI 覆盖。默认测试全部模拟、零付费。

## 本轮变更文件

- 新增：`src/bytes.ts`、`src/mpeg-audio.ts`、`src/sanitize.ts`、`test/mp3-fixtures.ts`、`test/mpeg-audio.test.ts`、`test/media-identity.test.ts`（确定性复现“检查后文件被替换”）。
- 重写：`src/errors.ts`、`src/media.ts`、`src/bailian.ts`、`src/server.ts`、`src/config.ts`、`src/doctor.ts`、`test/tools.test.ts`、`test/upload-cache.test.ts`。
- 修改：`src/config-lookup.ts`、`src/provider-error.ts`、`src/sse.ts`、`src/upload.ts`、`src/upload-cache.ts`、`test/{media,bailian,config,doctor,upload,boundary-matrix,host-env,live}.test.ts`、`.env.example`、`examples/*`、`README.md`、`AGENTS.md`、`docs/{README,API_CONTRACT,ARCHITECTURE,SECURITY,PROVIDER_PROTOCOL}.md`。
- 删除：`src/evidence.ts`、`src/audio-silence.ts`、`test/evidence.test.ts`、`test/evidence-text.test.ts`、`test/audio-silence.test.ts`、`test/live-evidence.test.ts`。
- 已本地提交：实现 `381da84`，随后的文档与验收记录各有独立提交，本报告与本次更正也包含在内。未做：push / tag / npm publish。真实调用及仍未知的费用见 A-P、D4、Codex 与 ZCode 的宿主记录。

## 下一步（按优先级）

2026-09-26 的独立收口验收与新增的取消/缓存竞态修复见 [`codex-acceptance-20260926.md`](codex-acceptance-20260926.md)；其中把 Node 22、CI 触发条件和 Codex 宿主剩余项按实际状态列明。

1. 在 Codex 新会话手动拖入一份公开合成媒体，核对新进程是否挂载最新 `analyze_media`、是否能成功返回。当前任务的 MP4/MOV/MP3 与 ZCode GUI 的 MOV/MP3 已分别通过，不外推到新会话；额外真实调用需另行授权，费用另记。
2. 模型是否读取媒体与模型自报细节的可靠性：已完成同模型同问题的有/无媒体块对照（`qwen-plus` 两次 `prompt_tokens` 均为 78、回答相同，说明该块未贡献输入 token）；ZCode 宿主的三音调样本又给出一个「回答与样本一致、但**段数与切换时间点都报错**」的反例（模型答 4 段 / 2·5·8 秒，本机频谱质心实测 3 段 / ≈2.9·≈5.9 秒）。**决定：不做本地核验，也不过滤或纠正模型自报的段数与时间点**——服务端只如实暴露 `request.model`/`usage`，并在音频 `limitations` 里明说「本机未逐句转写，也未核对模型自报的段数与时间点」。理由：一旦服务端开始按模型数字做纠正或过滤，就等于把未经核验的模型输出当成判据；`MEDIA_MODEL_UNSUPPORTED` 的模态拒绝 allowlist 仍只有 mock 证据。
3. 用户选择稍后通过 PR 的 Node 22/24 CI 验证；当前分支的普通 push 不触发 CI。创建 PR、推送、tag 与发布仍须分别按仓库规则授权，再复检规格完成标准。
