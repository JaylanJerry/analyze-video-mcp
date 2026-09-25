# 下一大版本独立收口验收（2026-09-26）

基线：`codex/optimization-prep`，开始时 HEAD `6edee34`、工作区干净。代码验收只使用公开代码、合成测试和本地打包；随后用户现场明确授权两次合成夹具的付费宿主调用。没有读取密钥或私人媒体，没有推送、创建 PR、打 tag 或发布。npm 上的 `0.6.1` 仍是旧 `analyze_video`，本报告只评估未发布的 `analyze_media` 分支。

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

## 尚未完成的发布门

- **Node 22 / CI**：本机 PATH 与 Codex bundled Node 均为 24，未找到现成 Node 22；本轮没有安装新运行时。CI workflow 已定义 Node 22/24 矩阵，但 `push.branches` 只含 `main`、`develop`、`feat/video-mcp-v1`，当前 `codex/optimization-prep` 分支的普通 push 不会触发 CI；PR 事件会触发。用户选择**稍后走 PR 的 Node 22 CI**，本轮没有推送或创建 PR。不能把本地 Node 24 全绿写成 Node 22/24 CI 已通过。
- **Codex 新会话**：当前任务的 MP4、MOV、MP3 Tool 调用都有真实样本；新会话的手动拖入与新进程加载最新构建仍未验收。现有授权仅覆盖上面两次合成夹具调用，没有授权新增付费调用。
- **其它已知边界**：SSE 形态内容检查拒绝的修复后真实复验、费用金额、`MEDIA_MODEL_UNSUPPORTED` 的真实拒绝措辞仍未知；不为补证重传被服务商拒绝的媒体。模型回答中的段数和时间点仍需逐条看待，不能作为模型内部模态路径的证明。

下一步：在获准创建 PR 后由 CI 验证 Node 22/24；另用 Codex 新会话手动拖入公开夹具，核对新进程加载与实际 Tool 调用。推送、PR、额外真实调用、tag 与发布仍按仓库授权边界分别处理。
