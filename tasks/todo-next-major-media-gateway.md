# 下一大版本媒体网关任务清单

状态：**A、B、C、D1、D2、D3 已实现并通过本地门禁；A-P 与 D4 的服务商格式矩阵已完成真实验证；Codex 当前任务的 MCP Tool 调用已用公开 MP4 夹具通过。** 新会话的手动拖入体验、Codex 宿主中的 MOV/MP3、ZCode 宿主、费用金额和 Node 22 CI 仍未验证。**已本地提交 `381da84`**（未推送、未发布）；npm 上的 `0.6.1` 仍是 `analyze_video`。总计划见 [`plan-next-major-media-gateway.md`](plan-next-major-media-gateway.md)。

**本轮本地门禁（2026-09-25，Windows / Node 24.18.0）：** `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm test`（258 passed / 1 skipped / 16 files）、`npm run coverage`（All files 88.18% stmts / 81.84% branch / 90.47% funcs）、`npm run build` 全部通过；`node dist/index.js --doctor` 报告 `handshake.registered=true` 且只注册 `analyze_media`。**Node 22 未在本机验证**（CI 会在 22 与 24 上跑，但本轮没有推送）。所有测试均为 msw 模拟，零真实请求、零费用。

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
  - 真实结果（默认地域、`qwen3.8-omni-flash`）：非私密合成样本（9.04 秒、三段递增音调）同一进程内两次调用都成功，模型准确说出三段、依次升高、每段约 3 秒；`usage` 188/474/662 与 188/725/913，SSE 事件 179/239，request id `2da18856-…` 与 `d52ed864-…`；第二次 `upload_reused:true` 且仍是新的分析。890 秒真实 MP3 同样成功（`usage` 6350/1541/7891、575 事件、22 秒）。
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
- [ ] **D4 受控真实验收（独立授权，部分完成）**：服务商格式矩阵与拒绝案例已完成；Codex 当前任务的 MCP 调用已通过一次，宿主完整矩阵、手动拖入体验与费用金额仍缺。
  - 已完成（2026-09-25，用户授权；共 7 次真实调用，5 次成功、2 次被服务商 400 拒绝）：
    | 样本                                                   | 结果                                                                                               |
    | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
    | 合成 MP3，9.04 秒（非私密）                            | 成功 ×2：三段递增音调描述正确；第二次 `upload_reused:true`                                         |
    | 真实 MP3，890 秒（用户内容，经转码派生，原文件未改动） | 成功：内容概括与音频一致；`media.kind=audio`、`duration_seconds=889.99`                            |
    | MP4，H.264+AAC，3 秒（公开夹具）                       | 成功：画面 `24` + 语音 `3.1415926`；`usage` 784/213/997、78 事件                                   |
    | MOV，同码流 `-c copy` 转封装                           | 成功：画面 `24` + 语音 `3.1415926`；`usage` 784/223/1007、75 事件；`container=mov`                 |
    | 音频-only MP4（`ftyp isom`，无视频轨，890 秒）         | **服务商 HTTP 400**（复现 2 次，无 SSE 事件与用量）：见 PROVIDER_PROTOCOL §3b 负例与原因未定位说明 |
  - **Codex 宿主补验（2026-09-25，当前任务，一次真实调用）：** 当前 Tool 列表含 `mcp__analyze_video_mcp__analyze_media`；用仓库公开 `test/fixtures/live-av.mp4`（30,988 bytes，3 秒；前后 SHA-256 均为 `2193544187DCCFEBBE68CF377FEE063DC599300D27D5447A05CD63E984B98A76`）提问“分别报告画面数字和音轨语音数字，不互相推断”。返回 `isError=false`、`media.kind=video`、`audio_track_present=true`、`request.model=qwen3.5-omni-plus`、`upload_reused=false`、`usage=770/26/796`；`content[0].text` 与 `structuredContent.answer` 一致，分别报告看到 `24`、听到 `3.1415926`，与夹具说明一致。仅核对了 Agent 可见结果；没有检查该次服务端 stderr 或账单。此项证明当前 Codex 任务的 Tool 挂载与真实调用，未验证新会话的手动拖入流程。
  - 仍未做：Codex 新会话手动拖入与宿主 MOV/MP3 调用、ZCode 宿主调用、费用金额（不记录账单）、内容检查拒绝的真实触发（仅 mock 覆盖）。
  - 样本处理：用户原文件未被修改；派生的 MP3 副本与临时重命名副本位于系统临时目录且已回收，未进入仓库。
  - **宿主配置迁移（2026-09-25，本机，已备份 `.bak-20260925`）**：Codex `~/.codex/config.toml` 的 env 已由 `QWEN_ALLOWED_ROOTS` / `QWEN_ALLOW_ANY_LOCAL_VIDEO` 改为 `MEDIA_ALLOWED_ROOTS` / `MEDIA_ALLOW_ANY_LOCAL_FILE`（值不变，权限不变），`QWEN_AUDIO_SILENCE_CHECK` 行已注释；ZCode `~/.zcode/cli/config.json` 的 `args`/`cwd` 从已不存在的 `Documents\Codex\Video MCP` 改指本仓库 `dist/index.js`，env 同样改名为 `MEDIA_*`。两处都用迁移后的授权跑过 `--doctor`：`local_media_policy.mode=any_local_file`、`handshake.registered=true`、无旧变量警告。
  - **宿主后续验收**：当前 Codex 任务已实际调用 `analyze_media`；新会话手动拖入及 ZCode 新会话仍需分别验证，不能由本次调用推定均已通过。

**最终检查点：** 变更清单见下方「本轮变更文件」；推送、tag 与 npm 发布仍须单独指令。 ⏳

## 规格完成标准逐条审计（`docs/SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md` §测试与完成标准）

1. **单 Tool 契约** ✅ 已验证：`test/tools.test.ts` 断言恰好一个 `analyze_media`、schema 只有 `media`/`prompt` 且都必需、无 provider/model/预算字段；宽泛、具体、中文与时间码 prompt 都逐字送达（两次断言原文相等）；每次调用只发一次请求（无二次提问）；旧码到新码的迁移由 `docs/API_CONTRACT.md` 的迁移表逐项列出，并有对应测试断言新码。
2. **夹具与反例** ✅ 已验证（全部无私密合成夹具、端到端走 mock provider）：MP4 有音轨（`test/tools.test.ts` 本地事实例）、**MP4 无音轨**（同文件，断言 `audio_track_present:false` 与对应 limitation，且不改写模型措辞）、MOV 受支持组合与拒绝组合（`test/media.test.ts` MOV support）、MP3（`test/tools.test.ts` + `test/media.test.ts`）；坏魔数、伪装后缀、仅 ID3、Layer II、PCM MOV、超大小、超时长、junction 越界、根外路径、取消、换 Key 后缓存失效、**检查后文件被替换**（新增 `test/media-identity.test.ts`，用 stub 确定性地复现快照与句柄不一致）；HTTPS 直连与远端 `.mp3` 拒绝各有用例。
3. **真实服务商与宿主验收** ⏳ **服务商侧已完成，Codex Tool 调用已通过一项**：MP4、MOV、MP3 都已完成真实百炼调用并得到正确内容（含 890 秒长样本与二次追问的 `upload_reused`），见 D4 表；当前 Codex 任务又用公开 MP4 夹具通过一次 `analyze_media` 调用。新会话手动拖入、Codex 宿主 MOV/MP3、ZCode 宿主仍未验收；费用金额未知，内容检查拒绝仍只有 mock 证据。
4. **脱敏、拒绝与重试** ✅ 已验证：`test/tools.test.ts` 断言 Key / `oss://` / 本地绝对路径在 `content[0].text` 与 `structuredContent` 两处都不出现且两处答案一致；内容检查拒绝 `retryable:false` 且只请求一次、不透传服务商原文；`test/bailian.test.ts` 断言 429/502/503 各至多一次重试、收到文本后不再重试；`test/host-env.test.ts` 断言 stdio 子进程 stderr 不含 `sk-`；第二次调用报告 `upload_reused:true` 且仍重新分析。
5. **门禁** ✅ 本地已验证（Node 24）：typecheck / lint / format:check / test / coverage(88.08/81.71/90.47) / build；独立打包安装与 stdio 握手通过（见 D3）。⏳ **Node 22 未在本机验证**：本机只装了 Node 24，`npx -p node@22` 被本地 `node` 遮蔽（尝试过 `npx -y node@22` 与 `npm exec --package=node@22`，两者都返回 v24.18.0），因此 Node 22 由推送后的 CI 覆盖。默认测试全部模拟、零付费。

## 本轮变更文件

- 新增：`src/bytes.ts`、`src/mpeg-audio.ts`、`src/sanitize.ts`、`test/mp3-fixtures.ts`、`test/mpeg-audio.test.ts`、`test/media-identity.test.ts`（确定性复现“检查后文件被替换”）。
- 重写：`src/errors.ts`、`src/media.ts`、`src/bailian.ts`、`src/server.ts`、`src/config.ts`、`src/doctor.ts`、`test/tools.test.ts`、`test/upload-cache.test.ts`。
- 修改：`src/config-lookup.ts`、`src/provider-error.ts`、`src/sse.ts`、`src/upload.ts`、`src/upload-cache.ts`、`test/{media,bailian,config,doctor,upload,boundary-matrix,host-env,live}.test.ts`、`.env.example`、`examples/*`、`README.md`、`AGENTS.md`、`docs/{README,API_CONTRACT,ARCHITECTURE,SECURITY,PROVIDER_PROTOCOL}.md`。
- 删除：`src/evidence.ts`、`src/audio-silence.ts`、`test/evidence.test.ts`、`test/evidence-text.test.ts`、`test/audio-silence.test.ts`、`test/live-evidence.test.ts`。
- 未做：任何 commit / push / tag / npm publish。真实调用及仍未知的费用见 A-P、D4 和 Codex 宿主补验记录。

## 下一步（按优先级）

1. 在 Codex 新会话手动拖入一份真实受支持的本地媒体，核对是否出现 `analyze_media`、是否能成功返回；再分别验收宿主 MOV/MP3 与 ZCode 新会话，不把当前任务的 MP4 成功外推到这些路径。真实调用的费用另记。
2. 模型是否读取媒体：已完成同模型同问题的有/无媒体块对照（`qwen-plus` 两次 `prompt_tokens` 均为 78、回答相同，说明该块未贡献输入 token），结论是**不做基于用量的猜测**，只如实暴露 `request.model`/`usage` 并在 limitations 里声明不证明听到；`MEDIA_MODEL_UNSUPPORTED` 的模态拒绝 allowlist 仍只有 mock 证据。
3. 在 Node 22 上跑全量门禁并核对 CI；复检规格的完成标准。推送、tag 与发布仍须分别按仓库规则授权。
