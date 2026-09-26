# DeepSeek 开发交接：下一阶段优化

> **旧交接，供追溯 v0.7 阶段工作。** 2026-09-25 起下一大版本接手入口改为 [`deepseek-next-major-handoff.md`](deepseek-next-major-handoff.md)；本文件下文不再指挥新重构方向。

状态：**A 批代码已实现，Codex CLI 与一个桌面 GUI 短片流程已验证；B 批仍在收口**。用户已认可 [`plan-v07-proposal.md`](plan-v07-proposal.md) 的优先顺序，并指定 **Codex 桌面版**作为跨目录拖入视频的首个宿主。当前发布版仍为 v0.6.1；本工作树的改动尚未发布。先读仓库根 [`AGENTS.md`](../AGENTS.md) 和 [`DEVELOPMENT_HANDOFF.md`](../DEVELOPMENT_HANDOFF.md)，再读本文件与关联规格。

用户的使用边界：**只有用户明确要求“调用 MCP 分析此视频”时才调用 `analyze_video` MCP**。其他视频分析请求使用 Codex 自带流程；视频被拖入聊天窗口本身不表示用户授权调用 MCP 或上传到百炼。A1 宿主探针只检查附件交接，不触发实际分析；A4 的真实 MCP 分析仍须用户明确提出并授权相应费用。

## 接手后的顺序

**先完成文档准备，再做 Codex 附件探针，然后开始 P0 代码。** 当前规格、路线和验收清单已经写好，DeepSeek 无须重写整套方案。第一项必须是无付费、无私密视频的宿主测试；它决定代码采用哪种交接方式。探针结果应回填本文件下方的“探针记录”，再把可行决策写入 [ADR 0020](../docs/decisions/0020-user-granted-local-media.md)。

```text
读现有契约与代码 → Codex 附件探针 A1 → 选定授权路径 A2
  → 单文件跨目录实现 A3 → Codex 流程验证 A4
  → 已复现的现有视频问题 B → 音频与测量 C → 综合审核 D
```

第一批只做 A1–A4。B 的具体修复以当前版本复现为条件。C、D 是后续批次，须先审定 [ADR 0018](../docs/decisions/0018-v07-tool-surface.md)、[ADR 0019](../docs/decisions/0019-v07-local-measurement.md)、供应商音频协议与外部运行时；不要与 A1–A4 混在一个改动中。

## 当前事实与代码入口

- 公开契约只有 `analyze_video(video, question?)`，见 [`docs/API_CONTRACT.md`](../docs/API_CONTRACT.md)。保持名称、字段和既有默认行为，除非新 ADR 和契约经用户批准。
- `src/server.ts` 注册 Tool、解析配置、调用 `resolveVideo`、上传、分析并关闭句柄；Server/Tool 文案目前写着本地文件须在允许根内。
- `src/media.ts` 的 `authorizeLocalMp4` 首先检查 `cfg.allowedRoots` 和根包含，再做 `realpath`、普通文件、大小、只读打开、身份复核、`ftyp` 与时长检查。`ResolvedVideo` 携带同一 FileHandle 供上传。
- `src/upload.ts` 与 `src/upload-cache.ts` 负责流式临时上传及缓存。`test/media.test.ts`、`test/tools.test.ts`、`test/upload.test.ts`、`test/upload-cache.test.ts` 是相关回归入口。
- [ADR 0015](../docs/decisions/0015-host-reliability-and-evidence-gate.md)否决“任意绝对 MP4 路径自动上传”。Agent 填入的路径或声称“用户已拖入”都不能单独构成授权。
- 首个目标与安全边界见 [ADR 0020](../docs/decisions/0020-user-granted-local-media.md)；完整阶段路线与验收项见 [`plan-v07-proposal.md`](plan-v07-proposal.md)、[`todo-v07-proposal.md`](todo-v07-proposal.md)。

## A1：Codex 无付费附件探针

目的：判断 Codex 桌面版能否把用户拖入的 MP4 以 **MCP 可验证的附件引用或流** 交给本项目。只看到聊天文本或 Agent 得到一个路径，不算通过。可以使用仓库内无私密的 `test/fixtures/live-av.mp4`，或另造公开短 MP4。不可用私人视频、真实 Key、生产上传或百炼分析来做此探针。

1. 在 Codex 本地任务里确认 `analyze_video_mcp` 已挂载并可列出 `analyze_video`。当前交接任务可见该工具；其他任务仍须独立核查。若工具未出现，先用已有 `--doctor --json` 和脱敏握手检查配置，不读取或打印 `.env`、Key、完整环境变量。
2. 人在 Codex 聊天输入区拖入测试 MP4，记录 UI 是否接受、用户消息如何表示附件、Agent 能否看到可靠的本地路径或附件标识。不要调用 `analyze_video`，因为这一步只验证宿主交接，且可能产生上传和模型费用。
3. 查证 MCP 调用是否有宿主可信的附件引用/流及其来源绑定。通过的证据必须来自宿主协议、可观察调用或最小假服务器，不接受 Agent 文字推断。最小假服务器若需要创建，不能连接百炼或读取测试 MP4 之外的本机文件；输出只留附件类型、是否有句柄、授权范围等非私密元数据。
4. 若 Codex 拒绝 MP4，或只把路径/文字给 Agent，记录该结论。再验证 Codex 的 MCP elicitation 能否让用户对**具体单个文件**作一次可信选择或确认；如果需要额外点击，在产品文案中如实说明。
5. 将探针环境、步骤、结果和脱敏证据填入下面模板。保持任何附件 ID、绝对路径和敏感配置不进入 Agent 可见的报错或提交日志。

**A1 退出条件：** 已证明一种可信单文件授权路径，或明确记录 Codex 当前无法提供此能力以及可用回退；不能以“看见了文件名”为完成。

### 探针记录（A1，2026-09-22 完成）

```text
日期 / Codex 版本：2026-09-22 / Codex 桌面版 App 26.915.31945；Agent 核心 codex 0.147.0（探针 initialize 的 clientInfo = name:codex-mcp-client, version:0.147.0）
测试媒体：仓库内无私密夹具 test/fixtures/live-av.mp4（30,988 B，3.0 s，含 1 视频轨 + 1 音频轨）。未用私有视频，未调用百炼，未上传。
Codex 是否接受拖入：接受，按“用户提到的文件”处理。本机 App 自身记录里含视频扩展名的用户消息共 159 条（2026-07-09 ~ 2026-09-20，最近一条 2026-09-20）。
用户消息中的附件形态：宿主生成的文本块，内容是「# Files mentioned by the user」+「## <文件名>: <绝对路径>」，之后才是用户正文。视频只出现在这段文本里；图片会额外得到结构化内容块 localImage（type=localImage, path=…）。159 条含视频的消息里 157 条只有 text 块；另 2 条同时带 localImage 的，其 localImage 路径指向图片而不是视频。
MCP 收到的类型与来源证明（仅脱敏元数据）：tools/call 参数只有 name、arguments 和 _meta。arguments 完全等于模型自己写出的 JSON（App 记录中 15 次 analyze_video 调用的参数键集合恒为 video+question）。宿主唯一附加的是 _meta["x-codex-turn-metadata"]（session/thread/turn id、sandbox、workspaces、git 提交哈希等会话元数据），不含文件句柄、资源引用、附件 id 或授权范围。
是否可从同一授权对象流式读取：不可用。宿主从未把附件对象交给 MCP，只给模型一段路径文本，因而不存在可流式读取的授权对象。
MCP elicitation / 单文件回退是否可用：协议层可用。客户端 initialize 声明 capabilities.elicitation = {form:{}, url:{}}；服务器发起 elicitation/create 能送达宿主并返回 {"action":"decline"}（非交互 codex exec 没有可询问用户的界面，自动 decline，不是协议错误）。codex features list 中 tool_call_mcp_elicitation = stable/true；app-server 协议存在 mcpServer/elicitation/request 方法。桌面 UI 的表单呈现与用户点击回传尚未实测。
结论：宿主不提供“拖入即授权”的可验证来源——Codex 只把视频变成模型可读的路径文本。协议层可用的回退是单文件 elicitation 确认，但用户 2026-09-22 否决了任何确认步骤，改为安装级开关 `QWEN_ALLOW_ANY_LOCAL_VIDEO`（默认关闭，开启后路径即授权、无弹窗），见 ADR 0021 与下节。
未验证项：桌面 UI 的 elicitation 表单实际呈现、字段与点击回传（留给 A4 用真实 Codex 流程验证）；本轮未在用户正在使用的 App 会话里重新拖入夹具（避免干扰在用会话），拖入形态依据 App 自身记录；Codex 桌面是否有文件选择器式媒体入口未验证；宿主对 MP4 的类型/大小上限未验证。
```

**证据获取方式（可复核，全部无付费、无隐私媒体）**

1. 挂载确认：`~/.codex/config.toml` 里存在 `[mcp_servers.analyze_video_mcp]`（已配置 `QWEN_MODEL` 与 `QWEN_ALLOWED_ROOTS`，具体值不记录）；宿主日志中该服务器握手成功，server name `analyze-video-mcp`、version `0.6.1`、protocol `2025-06-18`；App 记录里有 15 次 `analyze_video_mcp.analyze_video` 调用，说明工具在该宿主里可列出、可调用。
2. 只读读取 App 自己的记录：`~/.codex/thread_history_1.sqlite` 的用户消息与 MCP 调用条目、`~/.codex/logs_2.sqlite` 里的 `rmcp` 客户端握手日志。只取形态与元数据，路径与密钥不回填本文件。
3. 最小假服务器探针：本机临时目录下一个零依赖 Node stdio MCP 服务器（只把收到的 JSON-RPC 写进本地日志，不联网、不读任何媒体），用 `codex exec --ignore-user-config --ephemeral -c mcp_servers.<探针>.command=… -c mcp_servers.<探针>.args=[…]` 隔离运行，未改动用户 `~/.codex/config.toml`，未使用 `analyze_video_mcp`，未产生上传或模型费用以外的操作。
4. 探针附带发现（与 A2–A4 文案相关）：未声明 `readOnlyHint` 的 MCP 工具调用会被宿主挡在批准门后——在无可批准方时（`codex exec`）直接取消，从未到达服务器；输入形状相同但带只读注解的调用则未经批准即执行。真实 `analyze_video` 未声明注解（[`src/server.ts:233`](../src/server.ts) 的 `registerTool` 只有 `description` 与 `inputSchema`），因此不能对外宣称“永不打断用户”；也不应为省一次点击而谎报只读——该工具确实会上传媒体并调用付费模型。
5. 工具名在 Codex 中带服务器前缀（`non_prefixed_mcp_tool_names` 未启用），会话里须写成 `analyze_video_mcp.analyze_video` 这类全名。

## A 批状态（三层分开看，别混）

| 探针结果                                          | 实施路径                                                     | 用户实际操作                           |
| ------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------- |
| Codex 给 MCP 可信附件引用或流                     | 把引用绑定到单次 Tool 调用，从同一授权对象只读校验和流式上传 | 拖入并发送即可分析                     |
| Codex 没有可信附件交接，但支持可信单文件确认/选择 | 在 Tool 调用期间请求用户对具体文件授权；通过后只对该文件放行 | 拖入或给出文件后，再明确确认或选择一次 |
| 两者都不支持                                      | 保留允许根模式；单独提出经用户审阅的本地选择器/拖放界面方案  | 不能宣称“拖入 Codex 即分析”            |

**A1 判定：宿主不提供可信附件交接。** Codex 0.147.0 只给模型一段路径文本；客户端虽然稳定支持 MCP elicitation（`tool_call_mcp_elicitation = stable/true`，声明 `form` 与 `url`），但**用户 2026-09-22 明确否决任何确认步骤**（“不用弹，拖入，然后说调用 MCP 分析视频或音频，直接上传分析”）。因此 A2/A3 按“安装级开关”实施，见 [ADR 0021](../docs/decisions/0021-allow-any-local-video-opt-in.md)：`QWEN_ALLOW_ANY_LOCAL_VIDEO` 默认 `off`（行为与 v0.6.1 一致），`on` 时接受任意绝对本地 MP4 路径，不做根判定、不做确认。

### 1. 代码已实现（本分支，未发布）

1. `src/config.ts` 解析 `QWEN_ALLOW_ANY_LOCAL_VIDEO`（`on|off|1|0|true|false`，非法值报错），`AppConfig.allowAnyLocalVideo`；开关打开时允许根条目不可用被忽略而不是让调用失败，开关关闭时仍严格且错误点出变量名。
2. `src/media.ts` 仅在开关打开时跳过允许根判定；`realpath`、普通文件、打开前后身份复核、`ftyp`、`mvhd` 时长、大小上限、只读句柄、流式上传全部保留。
3. `src/upload.ts` 接受数字或数字字符串形式的 `expire_in_seconds` / `max_file_size_mb`；取凭证失败拆成六个 `parse_reason`（`request_failed` / `http_error` / `invalid_json` / `shape_mismatch` / `field_type_mismatch` / `upload_host_invalid`）并带 `field`。
4. `src/errors.ts` 把已脱敏诊断放进结构化错误与 Agent 文本；`field` 只允许 `data.<字段名>` 形状，`src/sse.ts` 的 `event_shape` 只回显合规键名并限量，避免异常端点用键名向上下文注入文本。
5. `src/doctor.ts` 报告 `local_video_policy.mode` 与来源；Server instructions 与 Tool 描述同时覆盖两种模式，并统一“只在用户明确要求用 MCP 分析时才调用”的引导。
6. 文档：ADR 0021（Accepted）、ADR 0015/0020 状态、README、`docs/API_CONTRACT.md`、`docs/PROVIDER_PROTOCOL.md`、`docs/SECURITY.md`、`examples/mcp.codex.toml`。

### 2. 已在 Codex CLI 验证（`codex-mcp-client` 0.147.0，零费用、无真实上传）

| 验证项                       | 做法                                                                                                 | 结果                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 开关生效且默认无回归         | `codex exec --ignore-user-config --ephemeral` + 本仓库 dist，根外垃圾字节 `.mp4`                     | `off` → `VIDEO_PATH_NOT_ALLOWED`；`on` → 通过授权后停在 `UNSUPPORTED_VIDEO`     |
| 真实配置链路                 | 用用户 `~/.codex/config.toml`（`node dist/index.js`）调用一次                                        | 工具被挂载、Key 解析成功、错误按预期返回                                        |
| 宿主批准门                   | 未标注只读的工具在无可批准方时被取消；加 `default_tools_approval_mode="approve"`                     | 同形状调用可直接执行，不再逐次征求批准                                          |
| 取凭证诊断在真实端点的表现   | 假 Key 打真实 `uploads?action=getPolicy`（只读 GET）                                                 | `UPLOAD_POLICY_FAILED: 无法取得上传凭证。（原因：http_error, http_status=401）` |
| 数字字符串兼容               | mocked 响应覆盖 `"300"` / `1024` 两种形态                                                            | 均解析通过并可继续上传；非数字与 ≤0 仍拒                                        |
| **真实端到端（ZCode 宿主）** | 2026-09-22 22:01，用户在 ZCode 里对 `Videos\剪辑视频\误时铺.mp4`（552 MiB / 416 秒）发出“分析此视频” | 上传与付费分析成功；文本层按预期带上分项观察；`UPLOAD_POLICY_FAILED` 未复现     |

### 3. Codex 桌面 GUI 实测（2026-09-23）

用户在新 Codex 任务“调用 MCP 分析视频数字”（任务 id `01a0ca17-b517-7210-a129-5da546938057`）把公开夹具 `test/fixtures/live-av.mp4` 拖入输入框，并明确要求调用 MCP。任务记录中的用户消息含该文件的绝对路径；随后 `analyze_video_mcp/analyze_video` 接收该路径与要求分别辨认画面和语音数字的 `question`，工具调用完成（52,673 ms）。最终回答为画面 `24`、语音“三点一四一五九二六”（`3.1415926`），并列出 `model=qwen3.8-omni-flash`、`coverage.audio_track_present=true`、`coverage.audio_observed=true`。用户报告本次没有批准或风险审查提示。`coverage.evidence_conflicts` 在无冲突时由 `coverageJson` 省略，故“未返回该字段”符合当前序列化行为，不能视为错误或证明冲突分支已被真实触发。

**验收范围**：这证明本次 Codex 桌面输入区拖入的短 MP4 路径能交给 MCP 并完成一次真实上传分析；此前 CLI 的跨目录开关测试与这次 GUI 测试是两项独立证据。未据此推定所有文件夹、较大文件、MOV/HEVC、每次会话的批准门行为均已验证。工具调用参数保留了用户的分析意图，但 `question` 是 Agent 整理后的句子，并非逐字原文。

### 4. 尚未验证

- **Codex 桌面 GUI 的其它输入条件**：上节只实测公开短 MP4 与一次无拦截调用；其它目录、大文件、MOV/HEVC、不同批准设置仍需分别取证。ZCode 的 552 MiB 真实链路已于 2026-09-22 跑通（见上表），不能代替 Codex GUI 的大文件验证。
- **上一轮 `UPLOAD_POLICY_FAILED` 的真实原因仍未知**：2026-09-22 22:01 的这次真实调用取凭证成功、未复现，但不能据此判定此前那次的原因（可能只是当时网络或服务端抖动，也可能是已上线的数字字符串兼容所修）。不得写成“已确定是 Key / 字段类型 / 网络问题”。
- 对白原文仍是模型抽样转写（`transcript_generated=false`、无独立字幕轨解析），不能当逐字稿；时间码是抽样定位，不是逐帧核验。
- 纯音频文件仍不支持（需要 `analyze_audio` 与供应商音频协议，属 C 批）。

### 让宿主用上本分支代码

**Codex**：把该服务器的 `command`/`args` 指向本仓库构建产物，并保留原有 Key 配置方式：

```toml
[mcp_servers.analyze_video_mcp]
command = "node"
args = ["C:\\path\\to\\analyze-video-mcp\\dist\\index.js"]
startup_timeout_sec = 120
tool_timeout_sec = 1200
# 需要批准的模式下避免每次点击；代价是该服务器的所有工具都免批准
default_tools_approval_mode = "approve"

[mcp_servers.analyze_video_mcp.env]
QWEN_MODEL = "qwen3.5-omni-plus"
QWEN_ALLOW_ANY_LOCAL_VIDEO = "on"
```

**ZCode**（2026-09-22 已装，用于对照测试）：用户级配置 `~/.zcode/cli/config.json` 的 `mcp.servers`，字段是 ZCode 的严格 schema（只允许 `type`/`command`/`args`/`cwd`/`env`/`enabled`/`timeoutMs`，多一个键该服务器会被丢弃；配置文件的服务器**不展开** `${...}` 模板，必须写绝对路径）：

```json
{
  "mcp": {
    "servers": {
      "analyze_video_mcp": {
        "type": "stdio",
        "command": "C:\\Program Files\\nodejs\\node.exe",
        "args": ["C:\\Users\\jjbon\\Documents\\Codex\\Video MCP\\dist\\index.js"],
        "cwd": "C:\\Users\\jjbon\\Documents\\Codex\\Video MCP",
        "timeoutMs": 3600000,
        "env": {
          "QWEN_MODEL": "qwen3.5-omni-plus",
          "QWEN_ALLOW_ANY_LOCAL_VIDEO": "on",
          "QWEN_ALLOWED_ROOTS": "C:\\Users\\jjbon\\Documents\\AI漫剧"
        }
      }
    }
  }
}
```

两者都不要把 Key 写进配置：`DASHSCOPE_API_KEY` 走 Windows 用户环境变量的静默回退即可（已用同一命令实测 `VIDEO_NOT_FOUND`，证明 Key 与配置都能加载）。先 `npm run build`；新增或改动服务器后要开**新**会话，旧会话不会重新挂载工具。ZCode 的默认工具超时是 30 秒，视频分析必须显式给 `timeoutMs`（示例给到 1 小时）。

实现必须满足：根外经用户授予的单个 MP4 成功；同一路径仅由 Agent 提供时拒绝；授权不能复用到别的文件或目录；文件替换、symlink/junction、取消、过期、坏 MP4、超大小、超时长均有测试。沿用只读 FileHandle、流式上传、脱敏与取消。不要把整文件 Base64 放进 Tool 参数、内存或聊天上下文。若需要改公开 schema、加入运行时或生产依赖，先更新规格/ADR/API 契约并请用户审阅。

## B 批新增：默认回答过简（2026-09-22，已定位并修复）

用户反馈“只说分析此视频时，最终回答太简略”。按要求先定位再改，用宿主自身记录量了三层（13 次真实 `analyze_video` 调用，脱敏，只取长度与条目数）：

| 层                      | 观测                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 模型收到的 `question` | 实际都是 Agent 扩写后的具体问题；只有省略 `question` 时才是服务端默认 `画面里发生了什么？音频说了什么？`，没有结构要求，也没有要求分开写听到/推断 |
| 2 MCP 返回              | `content.text` **只等于模型 JSON 的 `answer`**；带时间码的 `visual_observations` / `audio_observations` 只进 `structuredContent`                  |
| 3 Agent 最终展示        | 会再压缩（一例 1471 字文本 → 563 字回答），但输入已经是摘要时无可压缩                                                                             |

长度对比（同一回合内）：`19:48` 文本 296 字 vs 分项观察 505 字；`20:09` 270 vs 413；`21:02` 379 vs 755；只有 `19:39`（1471 vs 608）文本比观察更详细。**结论：主要丢在 1、2 两层——模型侧没有结构化要求，服务端又把带时间码的观察留在结构化字段里，只读文本的宿主与模型看不到。** 第 3 层是次要放大。

已修（不改公开 schema）：

1. 服务端在宽泛请求（省略问题，或「分析一下」「看看这个视频」这类短而笼统的说法）上补默认分析要求：时间线分段、画面、实际听到的声音与推断声音分开、节奏与情绪、有依据的优点与问题、不确定处；不设条数或字数，不要求编造。带时间码或「只核对…」的具体问题原样发送。
2. 文本层改为“`answer` 在前 + 分项观察分节在后”（`composeAnswerText`，展示上限每节 12 条 / 单条 220 字，截断时写「另有 N 项未展开」），只读文本的宿主也能看到分段证据；`structuredContent` 不变。
3. Agent 文案同步：宽泛要求可直接原样传入，服务端补结构，不必自行扩写细节。

真实视频的文本层已在下方第二批付费实测中得到两个样本；回答质量仍需对照原片评估。桌面 GUI 拖入后 Agent 是否更少二次概括仍未验证。

## 2026-09-22 第二批：MOV 输入 + 默认模型切换

**任务一：本地 MOV 输入**（不改公开 schema）

1. `src/media.ts`：扩展名 → 容器映射（`.mp4`/`.mov`）；容器决定上传元数据（`video.mp4`/`video/mp4` 或 `video.mov`/`video/quicktime`，对象 key 仍为随机 UUID + 对应扩展名）。新增有界编码抽样：`moov/trak/mdia/hdlr` + `stbl/stsd` 只读 fourcc（`probeTrackCodecs`），视频仅 `avc1`/`avc3`/`hvc1`/`hev1`、音频仅 `mp4a`，其它组合上传前拒绝（新错误码 `UNSUPPORTED_VIDEO_CODEC`，诊断带 `codec`，Agent 文本点名 fourcc）。保留 realpath、身份复核、允许根/任意路径开关、大小与时长上限、只读句柄、流式上传与脱敏。
2. `src/upload.ts`：`encodeMultipart` 接受容器决定的 filename/contentType（仍做 CR/LF 注入校验）；`objectKey` 支持扩展名。
3. 依据：官方错误码文档写“视频支持 mp4、avi、mov”（**检索所得，未用真实调用验证**），因此按 MOV 直传实现；**不引入 FFmpeg**，人工无损转封装兜底方案写在 [`docs/PROVIDER_PROTOCOL.md`](../docs/PROVIDER_PROTOCOL.md) 第 1c 节。
4. 参考样本 `星空.mov`（用户私人文件，未入库）：`qt  ` + `avc1` + `mp4a`，16.1 秒，17.9 MiB，moov 在文件尾；用本仓库 `dist` 走真实校验通过（只读打开，无网络、无上传）。测试用合成夹具覆盖接受与拒绝分支。

**任务二：默认模型 `qwen3.8-omni-flash`**

1. `src/config.ts` 默认值（`QWEN_MODEL` 覆盖与 Tool 字段不变）；README、速查表、`.env.example`、`examples/*`、`docs/ARCHITECTURE.md`、`docs/PROVIDER_PROTOCOL.md` 同步，安装示例不再写死旧默认值。
2. 思考默认开启的处理：`src/sse.ts` 聚合后剥离 `<think>…</think>`；`reasoning_content` 单独字段本来就被忽略；只有思考没有正文时返回 `PROVIDER_RESPONSE_INVALID` / `parse_reason=reasoning_only`。未添加任何思考参数。
3. 上传缓存按模型隔离（key 含 model，已新增“切换默认模型后磁盘条目不复用”的测试）。
4. 付费实测见下方；`usage` 数值与 HEVC 仍未验证。Codex 桌面 GUI 的公开短片拖入与调用已在上文补充验证；大文件等条件仍未验证。

**用户授权后的付费实测（2026-09-22）**

- 本仓库 `dist` + `scripts/t09-e2e.ts`，显式 `QWEN_MODEL=qwen3.8-omni-flash`、`QWEN_ALLOW_ANY_LOCAL_VIDEO=on`，对私人样本 `星空.mov` 调用。首次在上传凭证阶段返回 `UPLOAD_POLICY_FAILED` / `parse_reason=request_failed`，耗时 84.9 秒，未上传或推理。随后用假 Key 请求同一凭证端点得到 HTTP 401，证明该时刻可达，但**不能确定首次失败根因**。
- 同一 MOV 重试成功：本地 MOV 直传、模型正文返回，耗时 196 秒、811 个 SSE 事件，request id `chatcmpl-f6ff1122-5244-9856-9127-8860ac051cd8`。测试脚本的文本预览以原始 JSON 开头；需检查模型 JSON 是否未通过证据解析，不能仅以 `is_error=false` 宣称展示层质量合格。该次未记录 usage 数值。
- Codex 当前 MCP 工具对私人样本 `AE海-通义.mp4`（5.37 秒，H.264/AAC）真实调用成功，返回可读时间线与分项观察。结果的音频部分称无法确认音轨，但本地只读 FFmpeg 测得有 AAC 音轨、mean volume -30.5 dB、max volume -17.1 dB；同时 `coverage.audio_analyzed=true`。这是**模型声音判断与 coverage 标记不一致**，需要单独修复/验证。该次工具结果未显示模型 id 与 usage，因此不能单凭此条确认模型版本或 usage。
- 两次成功调用都不等于 Codex 桌面 GUI 拖入流程验收；`星空.mov` 的 HEVC 分支、真实费用金额和 provider usage 仍未核实。私人文件未入库，未推送或发布。

**2026-09-23 第四次修正：证据冲突信号（无付费复核发现）**

容器无音轨时模型仍可能给出 `heard` 条目，此前 `audio_observed=true` 且无矛盾提示。现新增 `coverage.evidence_conflicts`：本地探测与模型声明矛盾（声称听到但无音轨 / 声称看到但无视频轨）时该声明不计入 `observed`，冲突列表 + 一条 `coverage_limitations` 提示；措辞保留“确实没有该轨道”与“本地探测未能读取轨道结构”两种可能，不据此断定模型编造；HTTPS 不做本地探测故不判冲突。测试中“无音轨”用例改用**无音频条目**的报告并正面检查画面限制，另补冲突回归与 HTTPS 反例；重复的音频限制断言已改为检查画面限制。

**2026-09-23 第三次修正：清理顺序（无付费复核发现）**

配对校验原先依赖**清理前**的确认集合：一条 `seen` 因含“似乎”被清除后，同报告的 `audio=cross_validated` 仍被保留，于是清理前 `collectViolations=["visual"]`、清理后变成 `["audio"]`——输出仍含无配对依据的声明。已修：① 抽出自洽判定 `itemIsSelfConsistent`，校验与清理共用，确认集合只认**清理后仍有效**的 `seen`/`heard`；② `sanitizeEvidenceReport` 改为两阶段（阶段 1 各自清理并收集幸存者，阶段 2 用幸存者判配对），输出成为**不动点**；③ 补清理顺序回归（含幂等断言）并把测试里重复的音频限制断言改为正面检查画面限制（用“无音轨且无画面确认”的报告）。仍为 mock 覆盖，未在真实响应上确认。

**2026-09-23 第二次修正：cross_validated 配对（无付费反例）**

用户在当前 `dist` 上复现：仅一条 `visual=uncertain` + 一条 `audio=cross_validated` 时，校验通过且 `audio_observed=true`。已收紧：① `collectViolations` / `sanitizeEvidenceReport` 的 `cross_validated` 现在要求对面存在**直接确认**条目（画面 `seen` / 声音 `heard`），不满足则降级为 `inferred`，两侧互证而无确认条目按循环处理；② `audio_observed` / `video_observed` 只认 `heard` / `seen`，不再计 `cross_validated`（该类型在配对校验被真实证据证明可靠前不进验收结论）；③ 限制文案改为列出实际存在的条目类型（如“现有音频条目为：声画一致、待确认”）。回归：4 个配对用例 + uncertain/inferred-only 用例。仍是 mock 覆盖，未在真实响应上确认。

**2026-09-23 修正（用户实测发现）**

`buildCoverage` 的 `audio_observed` / `video_observed` 原来按“数组非空”判定，导致只有 `evidence=uncertain` 音频条目时也报 `audio_observed=true`、并漏掉“有音轨但没有听到类观察”的限制。现按证据类型判定：画面需 `seen` 或 `cross_validated`，声音需 `heard` 或 `cross_validated`，`inferred` / `uncertain` 不算；限制文案区分“完全没有该类条目”与“只有待确认/推断类条目”。新增针对该真实形态的回归测试（`test/evidence.test.ts`）。仍需真实调用确认修复在真实响应上的表现（本轮未付费）。

**DeepSeek 按上述实测做的两处修复（2026-09-22，代码 + mock 验证）**

1. 原始 JSON 展示（`src/server.ts` 的证据门）：成因确认——模型返回 JSON 但解析不成完整报告时，旧代码走散文兜底，把原始 JSON 直接当回答。现改为三级：完整报告 → `salvageJsonAnswer`（从 JSON 里取回 `answer` 与可解析的分项数组，含截断 JSON 的 `"answer"` 字段兜底）→ 真正的散文；三者都不成立才返回 `PROVIDER_RESPONSE_INVALID` / `parse_reason=json_without_answer`。原始 JSON 不再可能出现在用户可见回答里（新增 4 个用例覆盖：分项损坏但仍可用、缺 `answer` 时明确报错、截断 JSON 取回答案、散文含花括号不误判）。
2. 音频判断与 coverage 不一致：`coverage` 拆成三组语义——**本地事实**（`container` / `video_track_present` / `audio_track_present` / `video_codecs` / `audio_codecs`，由容器抽样得出，可复核）、**请求层**（`video_analyzed` / `audio_analyzed`；本地文件按轨道存在性，**没有音轨时 `audio_analyzed=false`**，HTTPS 未探测恒为 `true`）、**报告层**（新增 `video_observed` / `audio_observed`，来自模型的 `seen` / `heard` 条目）。`audio_track_present=true` 且 `audio_observed=false` 时写入 `coverage_limitations`（说明“含可解码音轨但回答没有听到类观察”，不得读成文件没声音）。另外把本地已确认的容器与轨道事实写进 user 轮，并要求“音轨存在却没听到时区分近似静音与无法判断”。结构化结果新增 `model` 字段，解决“工具结果看不出用了哪个模型”。
3. 仍未定位/未验证：首次 `UPLOAD_POLICY_FAILED`（`request_failed`，84.9 秒）的根因；`AE海-通义.mp4` 的声音为何未被模型听出；`usage` 数值、HEVC、Codex 桌面 GUI 拖入流程。见下方 2026-09-23 实测。
4. 备注：2026-09-23 当前工作树中 `scripts/t09-e2e.ts` 存在；此前“该脚本不在工作树”的记录已过时。不要据此补造重复脚本。

**Codex 同文件付费重跑（2026-09-23，当前 `dist`）**

- `test/evidence.test.ts` 与 `test/tools.test.ts` 先通过：62/62。随后直接启动当前 `dist/index.js`，显式指定 `QWEN_MODEL=qwen3.8-omni-flash`、`QWEN_ALLOW_ANY_LOCAL_VIDEO=on`，对同一私人 `AE海-通义.mp4` 调用一次。成功返回，耗时 109.4 秒，request id `chatcmpl-9e47fe4c-fd60-9990-80fa-3078f1c6daf4`；`structuredContent.model=qwen3.8-omni-flash`，文本不以原始 JSON 开头。
- 本次输出仍只说“无法判断音轨内容”，没有任何 `heard` 观察。它正确区分了“本地有 mp4a 音轨”与“模型实际听到声音”；此前 FFmpeg 已测得非零音频信号，但模型未利用音轨的原因仍未知。一次正常整理的文本不能证明 `salvageJsonAnswer` 在真实坏 JSON 上被触发，该分支目前只由 mocked 测试覆盖。
- **新发现的确定性 coverage 错误**：`audio_observations` 只有一条 `evidence=uncertain`，返回却是 `audio_observed=true`，因此也没有追加“有音轨但无 heard 观察”的 `coverage_limitations`。`src/evidence.ts` 当前按数组非空计算 `audio_observed`，而契约写的是有 `heard` 才为 true；`video_observed` 也按数组非空，而契约写的是 `seen`。修复后需用 uncertain/inferred-only 报告补回归。当前不能将 B2 的音频 coverage 修复记为完全通过。
- 对仓库公开夹具 `test/fixtures/live-av.mp4`（3 秒，H.264/AAC）又做一次受控付费测试：首次同样在上传凭证阶段返回 `request_failed`，未上传或推理；假 Key 随后从端点得到 401，重试通过。第二次调用的 `hit_visual=true`、`hit_audio=true`，166 个 SSE 事件，耗时 6.3 秒，request id `chatcmpl-9f700b47-e20f-9d05-a805-e1c9e947de2c`。这证明当前模型/协议能读取该夹具的内嵌语音，**不能证明**私人《AE海-通义.mp4》声音缺失的具体原因。两次 `request_failed` 的根因也仍未知。

**Codex 三条件付费对照（2026-09-23，当前 `dist`）**：对全长约 5.37 秒的《AE海-通义.mp4》使用同一音频核查问题，分别提交原片、保持画面码流不变但音轨提高 12 dB 的临时版本、保持画面码流不变但换入公开夹具语音的临时版本。三者画面码流 SHA-256 相同；原音频 mean −30.5 dB / max −17.1 dB，增益版 mean −18.5 dB / max −5.1 dB。三次真实 MCP 调用均成功且报告 `model=qwen3.8-omni-flash`：前两次音频只有 `uncertain`、`audio_observed=false`；第三次准确给出 `heard` 和“三点一四一五九二六”、`audio_observed=true`。该结果排除了“这条画面一律无法传递内嵌音频”和“只需提高 12 dB 就能解决”的简单解释；**原音轨内容及未被确认的原因仍未知**。临时派生文件未加入仓库。另用当前 `dist` 构造 `visual=uncertain` + `audio=cross_validated`，得到 `collectViolations=[]`、`audio_observed=true`，确定是尚未修复的证据判定缺口。见 [`docs/PROVIDER_PROTOCOL.md`](../docs/PROVIDER_PROTOCOL.md) 第 1e 节；下一步先修该判定并补反例测试，再决定是否需要进一步付费分析原音轨。

## B 前置证据（从宿主自身记录提取，2026-09-22）

B 阶段要求“以当前版本复现为条件”。先记录已能从宿主记录里确认的四件事，作为 P1 的起点：

1. **旧允许根闸门的真实代价（2026-09-20）**：用户指向自己 `Videos` 目录里的视频 → `VIDEO_PATH_NOT_ALLOWED`；Agent 随后查询 `QWEN_ALLOWED_ROOTS`，把源视频**整份复制**到允许根内的临时分析目录后重试，最终成功（该次调用耗时 137 秒）。也就是说旧行为不只是拒绝，还会诱导 Agent 做一次非预期的全量复制。本分支的开关消除了这一段（无需复制、无需查环境变量）。
2. **宿主侧风险审查可拦截上传（2026-08-22 与 2026-09-22）**：MCP 上传被 Codex 的风险审查判为拒绝，理由是“未明确授权把本地视频片段/完整视频上传至外部 MCP 服务”。这是宿主自身的审批/审查路径，与本项目配置无关；`default_tools_approval_mode = "approve"` 可让该服务器的调用直接放行。
3. **一次未能解释的失败（2026-09-20）**：同一天有两次失败记录——一次耗时约 38 秒后失败、错误体为空，紧接着一次 1 毫秒即失败，随后成功。仅凭条目记录无法定位原因（缺少服务端错误码）。若要修，需在当前版本用同一文件复现并保留服务端 stderr 阶段信息。
4. **取上传凭证失败无法定位（2026-09-22，用户报告）**：两次调用返回 `UPLOAD_POLICY_FAILED` / `stage=policy_acquired`，视频未上传、未进入分析，本地路径与格式校验已通过。诊断与兼容改动见上文 A 批第 1 节，机理见 [`docs/PROVIDER_PROTOCOL.md`](../docs/PROVIDER_PROTOCOL.md) 第 1b 节；**原因仍未定位**，需用同一视频再跑一次看 `parse_reason` 与 `http_status`。
5. **允许根目录改名导致全量失败（2026-09-22，真实命中）**：配置里的允许根被改名/移动后，`parseAllowedRoots` 抛错使**每次调用**都返回 `CONFIG_MISSING`，而 Agent 文案只说“配置不完整”。已修：开关打开时不可用条目被忽略（`--doctor` 列出），开关关闭时仍严格但错误点出 `QWEN_ALLOWED_ROOTS`。

## 验证与完成回报

- 每个行为变更先跑相应 `npm test -- test/media.test.ts test/tools.test.ts` 等最小相关测试，再运行 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm test`、`npm run coverage`、`npm run build`。
- 默认测试只能用 mocked 网络，不调用百炼。真实 Codex 端到端分析、付费 live、上传私人视频均需用户明确授权；无授权时可以验证到可信授权和本地校验，但不得报告“真实上传分析已通过”。
- 完成 A4 后同步 [`docs/API_CONTRACT.md`](../docs/API_CONTRACT.md)、[`docs/SECURITY.md`](../docs/SECURITY.md)、README、Server instructions、Tool 描述和安装示例。文档应写实际支持的 Codex 流程与仍存在的大小、时长、供应商限制。
- 最终回报按“已实现、已测试、真实 Codex 用户流程、未验证、下一步”五项简述。不要将 Proposed ADR 或本清单勾选当作功能已交付。
- 不读取/提交 `.env`、Key、`text/` 秘密；不绕过 Git hooks；不主动推送、建 PR、打 tag 或发布。保留当前工作树已有文档更改，不重置或覆盖其他人的工作。
