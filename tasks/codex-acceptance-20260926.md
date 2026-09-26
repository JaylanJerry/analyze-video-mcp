# 下一大版本独立收口验收（2026-09-26）

基线：`codex/optimization-prep`，开始时 HEAD `6edee34`、工作区干净。代码验收只使用公开代码、合成测试和本地打包；随后用户先后明确授权三轮合成夹具的付费宿主调用（重启前、重启后、Luna 新任务各 MOV/MP3 一次，共六次）。没有读取密钥或私人媒体，没有推送、创建 PR、打 tag 或发布。npm 上的 `0.6.1` 仍是旧 `analyze_video`，本报告只评估未发布的 `analyze_media` 分支。

## 本轮发现与处置

1. **取消与上传完成竞态（已修）**：底层上传器在取消已触发后仍返回成功时，`createCachedUploader` 原先会把该 `oss://` 写入缓存。最小复现得到 `{ "aborted": true, "calls": 1, "secondReused": true }`，违反“取消不能留下可复用成功项”。现在上传返回后重查取消信号；若取消发生在磁盘持久化期间，清除内存项并尽力改写磁盘项。`test/upload-cache.test.ts` 增加内存和磁盘两条回归，下一次相同媒体均重新上传。F2 已接受的“仅中段就地改写且大小、mtime 不变”残余不受此改动影响。
2. **Windows 打包验收脚本的带空格路径（已修）**：`scripts/pack-install-e2e.ts` 原先通过 `shell: true` 调用 npm，生成的 tarball 路径未正确转义；临时目录带空格时，npm 把路径截断。现用 npm 提供的 `npm_execpath` 通过当前 Node 直接执行 CLI，参数保持数组形式，不再经过 shell 拼接。在系统临时区的 `With Space` 目录下，独立安装和 stdio 握手通过：`{"ok":true,"packed_files":38,"tools":["analyze_media"],"fields":["media","prompt"],"runtime_sdk":true}`；不再出现 `DEP0190` 警告。

## 零成本验收结果

- Windows Node `v24.18.0`：`typecheck`、`lint`、`format:check`、`build` 通过；`npm test` 为 **297 passed / 1 skipped（18 文件）**；`npm run coverage` 为 statements **88.65%**、branches **82.10%**、functions **91.36%**、lines **90.09%**。
- 缓存专项：`test/upload-cache.test.ts` **16 passed**，含“上传完成时已取消”与“持久化期间取消”两条新回归。
- `test:pack-install`：在仓库外、路径带空格的系统临时目录通过。默认 npm 缓存不在当前沙箱可写范围，运行时将 `npm_config_cache` 指向仓库内的 `node_modules/.cache/npm-pack`；这是测试环境设置，不改生产配置。
- 一次把临时安装目录置于仓库的 `node_modules` 下，npm 将其识别为当前项目并意外改动依赖清单。已按精确 diff 撤销并用锁文件重装；`package.json` / `package-lock.json` 与 HEAD 的内容哈希一致。后续带空格路径测试改在仓库外进行。

## Codex 当前任务的真实宿主验收（用户授权，各一次）

- MOV：`%LOCALAPPDATA%/Temp/live-av.mov`，31,039 B、3 秒，H.264 + AAC，调用后 SHA-256 `1EF640015A10E4A82E58B7990520BE23E54DC748C46F4BD33DD0386FEC34D872`。`mcp__analyze_video_mcp__analyze_media` 返回 `isError=false`、`media.kind=video`、`container=mov`、`audio_track_present=true`、`request.model=qwen3.5-omni-plus`、`upload_reused=false`、`usage=769/26/795`；正文与结构化答案相同，回答画面 `24`、语音 `3.1415926`，与公开夹具说明一致。
- MP3：`%LOCALAPPDATA%/Temp/probe-tones.mp3`，72,559 B，调用前后 SHA-256 均为 `F47B19D9C0C4EB01A0E880C6A1B3C974DBAD985282F6E8002CC1B0A47C4545CB`。返回 `isError=false`、`media.kind=audio`、`container=mp3`、`duration_seconds=9.038367346938776`、`request.model=qwen3.5-omni-plus`、`upload_reused=false`、`usage=151/98/249`；正文与结构化答案相同，称电子纯音三段、音高逐段升高，与合成样本的已知结构一致。
- 两次均只检查 Agent 可见结果，没有读取服务端 stderr 或账单，费用金额未知；成功结果没有 `request_id`。回答与夹具吻合只能说明本次模型输出正确，不能独立证明服务商内部如何读取模态。当前 Codex 任务的 MCP 进程可能早于本轮本地构建启动，因此这两次验证的是**当前任务已挂载的调用链**，不能当作最新提交经新进程加载后的验收，也不覆盖新会话手动拖入。

## Codex 重启后复验（2026-09-26，用户明确要求直接测试，各一次）

- MOV：同一 31,039 B 夹具成功，回答画面 `24`、语音 `3.1415926`；`request.model=qwen3.5-omni-plus`、`upload_reused=false`、`usage=769/26/795`。
- MP3：同一 72,559 B 夹具成功，回答三段电子纯音、音高逐段升高；同一模型、`upload_reused=false`、`usage=151/77/228`。本次 `limitations` 已使用当前源码的“未逐句转写，也未核对模型自报的段数与时间点”。两次 `content[0].text` 与 `structuredContent.answer` 相同，媒体 SHA-256 与上轮记录一致。
- 新 MCP Node 进程 PID `32060` 的启动时间为 `2026-09-26 13:32:23 +08:00`，晚于本地 `dist` 构建时间 `01:47:24`。全局安装是指向本仓库的 junction，安装入口的 `index.js` / `server.js` / `upload-cache.js` / `sanitize.js` 与本地构建 SHA-256 一致。结合重启与输出措辞，**最新本地构建的新 MCP 进程调用已验收**。此项仍不是新会话手动拖入测试，也未查账单或服务端 stderr；没有额外调用来验证缓存复用，两次 `upload_reused=false` 不用于推断缓存配置或故障。

## 尚未完成的发布门

> 更新：Luna 新任务的直接路径调用也已于 2026-09-26 通过，见下节；GUI 手动拖入仍是独立未验收项。

- **Node 22 / CI**：本机 PATH 与 Codex bundled Node 均为 24，未找到现成 Node 22；本轮没有安装新运行时。CI workflow 已定义 Node 22/24 矩阵，但 `push.branches` 只含 `main`、`develop`、`feat/video-mcp-v1`，当前 `codex/optimization-prep` 分支的普通 push 不会触发 CI；PR 事件会触发。用户选择**稍后走 PR 的 Node 22 CI**，本轮没有推送或创建 PR。不能把本地 Node 24 全绿写成 Node 22/24 CI 已通过。
- **Codex 新会话**：当前任务的 MP4、MOV、MP3 Tool 调用都有真实样本，重启后最新本地构建的 MOV/MP3 调用也已通过；**新会话手动拖入仍未验收**。本轮重启授权的两次调用已经完成，不据此新增付费调用。
- **其它已知边界**：SSE 形态内容检查拒绝的修复后真实复验、费用金额、`MEDIA_MODEL_UNSUPPORTED` 的真实拒绝措辞仍未知；不为补证重传被服务商拒绝的媒体。模型回答中的段数和时间点仍需逐条看待，不能作为模型内部模态路径的证明。

下一步：在获准创建 PR 后由 CI 验证 Node 22/24；另用 Codex 新会话手动拖入公开夹具，核对附件转路径与实际 Tool 调用。推送、PR、额外真实调用、tag 与发布仍按仓库授权边界分别处理。

> 以上手动拖入状态是下节新增测试之前的快照；当前分项状态以下节补充记录为准。

## Luna 用户追加测试与本地取证（2026-09-26）

用户在 Luna 任务追加了视频测试，并在本任务授权排查。本任务仅读取既有记录及代码，不新增媒体上传或付费请求。

- 手动拖入 `视频+音频2.mp4`：正确传入路径并选择 `analyze_media`；首次调用被宿主自动审批阻止，随后用户明确授权后执行返回 `MEDIA_UPLOAD_FAILED`（约 3.6 秒，`stage=uploaded`、`retryable=false`）。原始结果没有 HTTP 状态或诊断原因，不能追溯是网络、文件流、期限还是其它问题，也没有这次请求的模型分析结果。附件转路径与工具选择已验证，该样本端到端仍未通过。
- 用户随后附上 `视频+音频.mp4` 并明确授权：两次分析均成功，约 53 / 63 秒，`qwen3.5-omni-plus`，本地时长 1455 秒；上传复用 `false → true`，用量分别 166947/2428/169375 与 166984/5286/172270。第二次由用户要求完整内容后 Agent 发起，不是服务端自动二次请求。不能外推默认模型，也未核验章节和时间点真值。
- 原始 `McpToolCall` 结果中，两次成功答案分别为 **4143 / 7951 字符**，`content` 与 `structuredContent.answer` 完全相同，整份 JSON 分别为 8954 / 16909 字符。Luna 中间执行层打印重复正文的整个结果，出现 `Warning: truncated output`（原始 token count 5265 / 9040）；第二次显式设 `max_output_tokens=5000`，并已 `store` 结果，后续有 `load` 读取答案的操作。直接证据定位的是 **Agent 中间执行层的打印截断**，不是本次 MCP 成功出口丢字或已证明的服务商生成截断。
- 从已有原始结果恢复两份正文到 `node_modules/.cache/media-review/luna-analysis-original-1.md` / `luna-analysis-original-2.md`（gitignored，仅本地缓存，不提交用户分析正文）。重新打开完整一致；每段最多 1500 字符分别分成 3 / 6 段，重新拼接逐字符相同。原始回答包含模型未核验的报告，不当作媒体真值。

### 本轮改动与边界

- 工具描述与 initialize instructions 同步加入长结果交付指引：先保存结果，只读一份答案；显示截断后优先读取已保存结果，避免仅因截断重新分析。成功协议仍保留同一答案的两种表示，不添加 Tool、字段、服务端正文缓存或自动落盘。这是操作指引，不能保证宿主/Agent遵守；已有结果的恢复验证不等于新 instructions 已在 GUI 被执行。
- multipart 上传失败增加固定安全诊断：请求失败、文件读取流失败、上传期限、取消、HTTP 错误；网络/TLS code 仅保留固定白名单，异常原文、地址、凭证、响应正文丢弃。文字不再声称失败“多半”来自网络；公开 URL 仅作为适合公开访问媒体的选项。保持不自动重传及 `retryable=false`，外层用户取消分类不变。
- **没有修复或定位历史上传失败的具体根因**：旧结果已丢掉原因，新诊断只改善未来取证；没有重传失败媒体补证。Node 22/24 PR CI、账单仍待验。

### 本地验证

Windows Node 24：`typecheck`、`lint`、`format:check`、`build` 全部通过；上传/错误/Tool 专项 **89 passed**，全套 **302 passed / 1 skipped（18 文件）**；coverage statements **88.76%**、branches **82.48%**、functions **91.18%**、lines **90.23%**。新增 5 项测试覆盖真实 MCP 长回答完整交付（一次分析）、未知异常的脱敏、HTTP 原因、上传期限、本地断连及文件读取流诊断（其中 HTTP / 未知异常与指引断言扩充已有测试）。本批随本地收尾提交保存；没有 push、PR、tag、publish，也没有新媒体请求。最新构建供新进程加载；本轮没有用运行中的 MCP 做付费验收。

## Luna 新任务实际挂载验收（2026-09-26）

用户明确要求新建 Luna 任务，并授权同一 MOV/MP3 各一次付费调用。新任务为 **Luna 新任务 MCP 验收**，ID `01a0dc39-340d-7e23-9ba5-46c5723f188c`，任务模型指定 `gpt-6-luna`。任务工作区是默认分支的独立 worktree，只读核对原仓库最新验收文档；没有构建旧快照或修改任何代码、配置、依赖。

- 新任务实际挂载的 `analyze_media` 输入仍只有必填 `media` / `prompt`。样本大小、SHA-256 与本报告一致；任务历史可核对两次 `mcpToolCall`，没有额外媒体调用。
- MOV：`isError=false`，回答 `24` / `3.1415926`，`media.kind=video`、`container=mov`、3 秒、音轨存在；`request.model=qwen3.5-omni-plus`、`upload_reused=true`、`usage=769/26/795`。
- MP3：`isError=false`，回答电子纯音三段、音高阶梯式升高，`media.kind=audio`、`container=mp3`、约 9.038 秒；同一媒体模型、`upload_reused=true`、`usage=151/78/229`。两次正文与 `structuredContent.answer` 一致。
- **通过的是新任务挂载与直接传本地路径调用**，并观察到两种格式的上传引用复用；**不是 GUI 手动拖入验收**。Luna 是 Codex Agent 模型，百炼 `request.model` 是媒体模型。账单金额未知，模型回答吻合不证明内部模态读取路径。父任务只更新验收记录；没有推送或发布。
