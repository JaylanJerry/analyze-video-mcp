> **历史归档（2026-09-26）：** 本文保留当时的计划、结论和未验证项，不作为当前实施指令或发布状态。当前入口见 [开发交接](../../../DEVELOPMENT_HANDOFF.md)，发布事实见 [1.0.0 发布记录](../../../tasks/release-1.0.0.md)。

# 给 Codex 的审核简报：下一大版本媒体网关（2026-09-25）

**用途：** 让另一个模型在不重跑付费调用的前提下，对本工作区的实现、安全边界与文档诚实度做独立审核。所有结论按「模拟 / 真实百炼 / 宿主 GUI / 打包安装 / npm 发布」五态分层，本文明确标注哪些是证据、哪些是未验证假设。

## 0. 一句话状态

分支 `codex/optimization-prep`（HEAD `40987f5`，领先 `origin/main` 22 个提交，**未推送**、**未发布**）已把已发布的 `analyze_video(video, question?)` 换成下一大版本的唯一 Tool `analyze_media(media, prompt)`：本地 MP4/MOV/MP3 + 公开 HTTPS 视频，服务端不写提纲、不强制证据 JSON、不自动二次请求；本地授权改为 `MEDIA_ALLOWED_ROOTS` / `MEDIA_ALLOW_ANY_LOCAL_FILE`。mock 门禁全绿，服务商侧与 ZCode 宿主侧已有真实调用证据，**npm 上的 `0.6.1` 仍是旧契约**。

## 1. 审核目标（请就这三问给结论）

1. **一致性**：实现是否与 [`docs/SPEC_MEDIA_GATEWAY.md`](../../../docs/SPEC_MEDIA_GATEWAY.md)、[ADR 0024](../../../docs/decisions/0024-agent-directed-media-gateway.md) 一致——工具表面、Agent/服务端职责划分、成功元数据与错误的出现条件、安全边界。
2. **安全性**：有没有授权、脱敏、取消、缓存身份隔离、内容检查拒绝分类上的回归（详见 §7 清单）。
3. **诚实度**：文档有没有把 mock 结果写成 live 证据、把未发布写成已上线、把模型自报内容写成已核验事实。

## 2. 必读顺序

1. [`AGENTS.md`](../../../AGENTS.md)（硬规则与脆弱假设，尤其假设 1/1b/1c/1d）
2. [`docs/SPEC_MEDIA_GATEWAY.md`](../../../docs/SPEC_MEDIA_GATEWAY.md) + [ADR 0024](../../../docs/decisions/0024-agent-directed-media-gateway.md)（目标与取舍）
3. [`docs/API_CONTRACT.md`](../../../docs/API_CONTRACT.md)（当前实现的公开契约 + 旧→新迁移表）
4. [`docs/SECURITY.md`](../../../docs/SECURITY.md)、[`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md)、[`docs/PROVIDER_PROTOCOL.md`](../../../docs/PROVIDER_PROTOCOL.md)（安全链、数据流、协议与实测）
5. [`tasks/archive/1.0/todo-next-major-media-gateway.md`](todo-next-major-media-gateway.md)（逐项验收证据与未验证项）、[`tasks/archive/1.0/zcode-probe-report-20260925.md`](zcode-probe-report-20260925.md)（ZCode 三文件探针，自包含）

## 3. 代码地图与审核要点

| 文件                                               | 职责                                 | 审核要点                                                                                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/server.ts`                                    | 唯一 Tool 注册、进度、结果与错误成形 | 是否恰好一个 `analyze_media`；`prompt` 是否必填且**逐字**转发（无服务端模板）；`content[0].text === structuredContent.answer`；成功元数据字段的出现条件；取消→`MEDIA_ANALYSIS_CANCELLED`；单飞锁与句柄释放                     |
| `src/media.ts`                                     | 输入分类与本地授权链                 | 扩展名→绝对路径→根包含→realpath→stat 快照→只读打开→fstat 身份比对→realpath+stat 复核→容器探测→大小/时长；`.mp3` 内容的 ISO BMFF 判定必须在扫帧之前；远端 `.mp3` URL 拒绝；不返回可重开的“可信路径”                             |
| `src/mpeg-audio.ts`                                | 有界 MPEG Layer III 探测             | 读取预算（`bytes.ts` 强制）不可被畸形头部绕过；ID3v2 声明长度上限；连续帧最少 3 帧；Xing/VBRI 与恒定码率时长 + 合理性校验；不缓冲整文件、不解码音频                                                                            |
| `src/bytes.ts`                                     | 共享定位读取与预算                   | 越预算读取必须失败                                                                                                                                                                                                             |
| `src/bailian.ts`                                   | 百炼请求构造与传输重试               | 视频 `video_url` / 音频 `input_audio` + `format:"mp3"`；`oss://` 输入带 `X-DashScope-OssResourceResolve: enable`；系统消息只有固定 `PROTOCOL_NOTE`（无提纲）；仅“未收到任何文本”时对 429/502/503 至多一次重试                  |
| `src/provider-error.ts`                            | 服务商错误最小映射                   | 只透传白名单标识与 `inspection_side∈{input,output,unknown}`；不透传服务商原文；`MEDIA_MODEL_UNSUPPORTED` 的 allowlist **仅 mock 固定**（见 §8）                                                                                |
| `src/upload.ts` / `src/upload-cache.ts`            | 流式上传与缓存                       | 同一 `FileHandle` 流式 multipart、无整文件缓冲；对象 key 随机 UUID；缓存键含文件身份+模型+端点+**API Key 单向指纹**（换 Key 不复用，见 `credentialFingerprint`）；不落盘 Key 与凭证                                            |
| `src/sanitize.ts`                                  | Agent 可见文本的唯一改写出口         | 只去 `oss://`、凭证形态、本地绝对路径；不改媒体语义（无删除/重排/纠错）                                                                                                                                                        |
| `src/errors.ts`                                    | 错误词汇表与脱敏                     | 稳定码、`stage`、`retryable`；诊断键白名单；构造即脱敏；取消与超时分开                                                                                                                                                         |
| `src/config.ts` / `config-lookup.ts` / `doctor.ts` | 配置与体检                           | 授权只读 `MEDIA_*`；旧 `QWEN_ALLOWED_ROOTS`/`QWEN_ALLOW_ANY_LOCAL_VIDEO`/`QWEN_MAX_LOCAL_VIDEO_MB`/`QWEN_AUDIO_SILENCE_CHECK` 只被识别并提示、**不授予任何访问**；`MEDIA_ALLOW_ANY_LOCAL_FILE` 不参与 Windows 用户环境静默回退 |
| `scripts/*.ts`                                     | 探针与打包断言                       | `t09-e2e.ts` 走 stdio 真实调用并输出结构化报告；`pack-install-e2e.ts`/`install-e2e.ts` 钉住 Tool 名与字段；本地 tar 兼容注记见 §6                                                                                              |

**已删除（不要当成缺陷）：** `src/evidence.ts`（旧证据报告层）、`src/audio-silence.ts`（可选 FFmpeg 静音核对）及其测试、`analyze_video` 注册。内容仍在 git 历史中，测试断言按新契约重写而非跳过。

## 4. 五态验证矩阵

| 状态                        | 结论                                                                                                                                 | 证据位置                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模拟测试（msw，零真实请求） | ✅ 264 passed / 1 skipped / 17 files；覆盖率 88.24 / 81.95 / 90.47                                                                   | 本机 `npm test`、`npm run coverage`；`test/tools.test.ts`、`test/media.test.ts`、`test/mpeg-audio.test.ts`、`test/media-identity.test.ts`、`test/upload-cache.test.ts` |
| 打包安装 + stdio 握手       | ✅ `{"ok":true,"packed_files":38,"tools":["analyze_media"],"fields":["media","prompt"]}`                                             | `npm run test:pack-install`、`npm run test:install`；`--doctor` `handshake.registered=true`                                                                            |
| 真实百炼（服务商侧）        | ✅ MP4 / MOV / MP3（9 秒合成、890 秒真实、317 秒音频）均成功且内容正确；`upload_reused` `false→true`；3 次被服务商拒绝（含内容检查） | `docs/PROVIDER_PROTOCOL.md` §3b；`tasks/archive/1.0/todo-next-major-media-gateway.md` 的 D4 表与 8 文件回归表                                                          |
| 宿主 GUI（ZCode）           | ✅ GUI 新会话、手动拖入、MOV、MP3 均通过（`mdat` 与公开夹具逐字节相同，已本地复核）                                                  | `tasks/archive/1.0/zcode-probe-report-20260925.md`；[`AGENTS.md`](../../../AGENTS.md) 假设 1d                                                                          |
| 宿主 GUI（Codex）           | ⏳ 仅当前任务一次公开 MP4 调用通过；新会话拖入与宿主内 MOV/MP3 未验                                                                  | `AGENTS.md` 假设 1d                                                                                                                                                    |
| npm 发布                    | ❌ 未发布；`analyze-video-mcp@0.6.1` 仍是 `analyze_video` + `QWEN_*`                                                                 | `package.json` 版本仍 `0.6.1`；README/示例保留旧钉版本并标注新契约                                                                                                     |

**真实调用累计约 22 次**（含 3 次被拒、1 次直连 API 对照臂），均为用户授权下进行；费用金额未知（不记录账单）。

## 5. 复现指南

**零成本（推荐审核者先跑）**

```bash
npm install
npm run typecheck && npm run lint && npm run format:check
npm test                # 264 passed / 1 skipped
npm run coverage        # 阈值 85% 语句 / 75% 分支
npm run build
node dist/index.js --doctor          # 只注册 analyze_media
```

本地免费核对（不联网）：`ffprobe` 读元数据、`ffmpeg -af silencedetect/volumedetect/astats` 测静音与电平、按 box 遍历对 `mdat` 载荷做 SHA-256 比对同一性。

**打包安装**：`npm run test:pack-install`、`npm run test:install`。Windows 注记：本机 GNU tar 会把 `C:\…` 当远程主机（`Cannot connect to C:`），需把 `C:\Windows\System32`（bsdtar）置于 PATH 前；Linux CI 不受影响。

**真实调用（有费用，须用户现场授权）**

```bash
MEDIA_ALLOWED_ROOTS="<某个允许目录>" npx tsx scripts/t09-e2e.ts "<媒体绝对路径>" "<prompt>"
# 可选：PROBE_REPEAT=1 观察 upload_reused；PROBE_EXPECT=a,b 报命中；PROBE_PREVIEW 控制预览长度
```

凭据只从进程环境读 `DASHSCOPE_API_KEY`（不要写进命令、配置或提交）。

## 6. 审核清单（逐项给「通过 / 不通过 / 存疑 + 证据」）

**契约**

1. `listTools()` 恰好一个 `analyze_media`，schema 只有 `media`/`prompt` 且都必需，无 provider/model/预算字段。
2. `prompt` 的问题本身原样送达、只去首尾空白（宽泛、具体、中文、时间码、内部换行与缩进各一次断言），每次调用只请求一次，无二次纠错请求。
3. `content[0].text === structuredContent.answer`，且不含固定报告/分项/模型名/耗时。
4. 成功元数据字段的出现条件：`container`/`duration_seconds`/`audio_track_present` 只在本地确实建立时出现，未知不填 `false`；HTTPS 不伪造本地事实；`upload_reused` 仅本地文件且有缓存命中语义。

**安全**

5. 本地授权链完整（扩展名、根包含、身份复核、只读句柄、同句柄上传）；旧 `QWEN_*` 变量不授予访问，doctor 报告迁移。
6. 脱敏：Key、`oss://`、本地绝对路径不出现在文本、结构化结果与 stderr（有 canary 测试）。
7. 取消与超时：取消→`MEDIA_ANALYSIS_CANCELLED`（`stage=aborted`），超时→`PROVIDER_TIMEOUT`；句柄与流都释放。
8. 缓存：换 Key 后不命中旧 `oss://`；缓存文件不含 Key/凭证；上传失败或取消不留“成功”项。
9. 内容检查拒绝：`PROVIDER_CONTENT_REJECTED`、`retryable=false`、不自动重试、不透传服务商原文；SSE 与 HTTP 正文两种形态都有映射（正文形态已有真实现场，SSE 形态修复后未复验）。
10. 有界解析：MP3 探测与 MP4 box 遍历都不受预算绕过；`ftyp` 容器冒充 `.mp3` 时先判容器再扫帧。

**诚实度**

11. 文档没有把 mock 说成 live、没把未发布写成已上线、没把模型自报内容写成已核验事实。
12. `limitations` 与文档都声明“本地校验不证明模型听到/听准”；不含“已逐帧核验”类表述。

## 7. 已知边界与明确未验证项（**不要据此判定实现有缺陷**）

1. **音频-only MP4（无视频轨）被服务商以 HTTP 400 拒绝**（复现多次，含一次 `data_inspection_failed`）。原因未定位（缺视频轨 / 文件属性 / 服务商策略），服务端不预先拒绝，也不自动转码（转码需单独批准）。同一份源视频派生文件的裸 400 归因需要新授权才能重跑。
2. **`MEDIA_MODEL_UNSUPPORTED` 的 allowlist 只有 mock 证据**：实测纯文本模型对 `input_audio` 不报错而是静默忽略（同模型同问题的有/无媒体块 `prompt_tokens` 均为 78、回答相同），因此该错误码至今无真实命中样本。
3. **模型自报细节逐条不可靠**：同一份三音调样本段数与切换点错（4 段/2·5·8 秒 vs 本机实测 3 段/≈2.9·≈5.9 秒），而另一份音频的“后半段静音”判断正确（本机 `silencedetect` 证实 6.07–12.12 秒）。按 ADR 0024 服务端**不**纠正、**不**过滤。
4. **长媒体用量与耗时**：317 秒视频 ≈ 17.4 万 prompt tokens；1455 秒 ≈ 16.7 万、端到端 432 秒。工具按设计无费用/预算旋钮。
5. **成功结果不含 `request_id`**（只在错误与 stderr）；是否加入成功元数据属于公开契约变更，尚未决定。
6. **Node 22 未在本机验证**（本机只有 Node 24，且分支未推送）。
7. 未验证：Codex 侧新会话拖入与宿主内 MOV/MP3、费用金额、SSE 形态内容检查复验、一小时上限附近的行为、并发调用（只测了单飞 `MEDIA_ANALYSIS_BUSY`）。

## 8. 审核时请勿做

- 不 `git push`、不打 tag、不 `npm publish`；提交与推送需用户明确指示。
- 不为取证重新上传任何已被服务商拒绝的媒体（例：SHA-256 `73f3003d…92ba7` 的那份 889 秒视频）。
- 不读取 `text/`、`.env`、`*.key`，不打印或写入真实 API Key。
- 不自行发起付费 live 调用（除用户现场授权）；默认套件必须保持零网络。
- 不用单次宿主结果或单个样本外推「所有路径已通过」，也不用模型自报内容判定实现正确性。

## 9. 仓库状态与产出形式

- **本简报记录写作时的快照**（HEAD `40987f5`、领先 22）；后续提交不在此更新，请以 `git log` 为准。写作时工作区干净，本会话 6 个提交：`381da84`（实现，66 文件 +3475/−6094）、`b03654b`/`24d8d52`（状态行）、`43584e1`（ZCode 重装）、`a4e6dab`（ZCode 探针报告）、`40987f5`（8 文件回归与用量规模）。
- `dist/`、`coverage/` 等构建产物未提交（`.gitignore`），审核前请自行 `npm run build`。
- 建议把审核结论写成 `tasks/codex-review-findings-<date>.md`：逐项「通过 / 不通过 / 存疑」+ 证据（`file:line`、命令与关键输出、commit hash），并对每个不通过项给出最小修复建议；不要直接改代码或提交。
