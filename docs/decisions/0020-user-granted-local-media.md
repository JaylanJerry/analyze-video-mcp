# ADR 0020：用户手动授予单个本地媒体文件

- Status: Superseded by ADR 0021（用户否决额外确认步骤，改为安装级直传开关）
- Date: 2026-09-22
- Spec: [`SPEC_V07_PROPOSAL.md`](../archive/specs/SPEC_V07_PROPOSAL.md)

## Context

用户希望把本机任意文件夹里的视频拖进 Agent 窗口后直接分析，不再为每个目录配置 `QWEN_ALLOWED_ROOTS`。当前 `analyze_video(video, question?)` 接受模型可填写的字符串路径；`src/media.ts` 只有在路径位于允许根时才打开并上传文件。ADR 0015 曾明确否决“任意绝对 MP4 路径自动上传”：Agent 可被提示注入诱导，路径字符串本身不能证明用户选择了该文件。

首个目标宿主已由用户选为 **Codex 桌面版**。其公开 [App Server 文档](https://developers.openai.com/zh-Hans/docs/app-server)列出的回合输入为文本、图片 URL 和本地图片路径，并说明支持 MCP 引导式用户输入；该文档没有给出“视频拖入聊天框后向 MCP 传递可信附件句柄”的契约。不能从文档缺席推断 UI 一定不支持，必须实测。Agent 聊天窗口是否能把附件以可验证的引用或流传给 MCP，取决于宿主实现；本仓库现有 Tool 调用并不携带附件来源证明。手动拖入聊天框和模型在 Tool 参数中写出相同路径，对当前 MCP Server 来说无法区分。

## 宿主验证证据（2026-09-22，A1 探针）

完整脱敏记录见 [`tasks/archive/pre-1.0/deepseek-v07-handoff.md`](../../tasks/archive/pre-1.0/deepseek-v07-handoff.md) 的探针记录。要点：

1. Codex 桌面版**接受**拖入 MP4，但只把文件写成用户消息里的一段宿主文本（「# Files mentioned by the user」+「文件名: 绝对路径」）。视频没有结构化附件对象；只有图片会得到 `localImage` 内容块。
2. MCP 边界没有任何附件或授权信息：`tools/call` 只收到模型自己写出的 `arguments`，宿主额外附加的只有会话元数据 `_meta["x-codex-turn-metadata"]`（session/thread/turn id、sandbox、workspaces、git 提交哈希）。App 记录中 15 次真实 `analyze_video` 调用的参数键集合恒为 `video` + `question`。
3. 宿主客户端（`codex-mcp-client` 0.147.0）声明 `capabilities.elicitation = {form:{}, url:{}}`；`codex features list` 中 `tool_call_mcp_elicitation = stable / true`；app-server 协议存在 `mcpServer/elicitation/request`。服务器发起的 `elicitation/create` 能送达宿主，非交互环境返回 `{"action":"decline"}`（无 UI 可问，非协议错误）。
4. 未声明 `readOnlyHint` 的 MCP 工具调用会进入宿主批准门：无可批准方时被取消、从未到达服务器；带只读注解的同形状调用则直接执行。`analyze_video` 当前未声明注解（[`src/server.ts`](../../src/server.ts) 的 `registerTool` 只有 `description` 与 `inputSchema`）。

结论：本 ADR 第 2 条里“宿主提供可验证附件引用/字节流”这一分支在当前 Codex 上不可实施；“用户在可信的本地交互中明确选择同一个文件”这一分支曾以 MCP elicitation 单文件确认为首选。**2026-09-22 用户决定不采用任何确认步骤**，改为安装级开关 `QWEN_ALLOW_ANY_LOCAL_VIDEO`，见 [ADR 0021](0021-allow-any-local-video-opt-in.md)；本 ADR 不再实施，保留作为宿主能力与选项的记录。

## Proposed Decision

1. 保留 `QWEN_ALLOWED_ROOTS` 作为无交互自动调用的目录授权。未配置允许根、也无其他可验证授权时，继续拒绝本地路径。不能根据模型文本、路径、文件名、聊天上下文中的“用户已拖入”等话语放行。
2. 增加独立的用户授予路径：仅当宿主能提供可验证的附件引用/字节流，或用户在可信的本地交互中明确选择同一个文件时，允许跨目录分析。授权限定单文件、单次操作或短期会话；不能扩大为其父目录的永久权限。优先复用现有 `analyze_video` 语义；公开字段若必须变化，先修订 API 契约与本 ADR。
3. 获得授权后仍执行扩展名和文件头校验、普通文件检查、大小与时长限制、只读打开、打开前后身份复核、流式上传、取消和脱敏。尽量从已授权的同一 FileHandle 上传，避免授权后重新按路径打开。不得把整段媒体 Base64 放进 Tool 参数或进程内存。
4. 先做 Codex 真实宿主探针：在 Codex 中拖入公开的无私密短 MP4，记录聊天附件如何表示、Tool 收到什么、是否有可信附件来源标识、是否支持 MCP 用户交互，以及能否流式读取。测试不得使用私人媒体或付费 API；只验证输入交接，未获授权前不请求百炼。
5. 若宿主没有可信附件交接，提供明确的单文件选择/确认回退体验，并准确告知用户它需要一次额外操作；不能宣传为“拖进 Agent 窗口即自动分析”。跨宿主支持逐个验证，不把一个宿主的行为推定到其他宿主。

本提案只有在通过审阅并完成宿主能力验证后，才会取代 ADR 0015 对“允许根外文件一律拒绝”的局部结论；ADR 0015 对普通模型路径调用的默认拒绝继续有效。

## Acceptance Criteria

1. 被用户明确授予的根外 MP4 可流式上传并分析；相同路径仅由 Agent 填入 Tool 参数时仍返回 `VIDEO_PATH_NOT_ALLOWED` 或等价安全错误。
2. 文件替换、符号链接/junction 改指、拒绝/取消授权、不同文件重用授权、授权过期、坏文件、超过现有大小/时长上限均不能越权上传。
3. 结果和错误不泄露本机路径、密钥、上传凭证或 `oss://` 地址；默认测试使用假附件和 mocked 网络，不产生实际 API 费用。
4. 每个声明支持的宿主都完成“用户拖入 → Tool 接收可信授权 → 上传分析”的端到端验证；未通过的宿主只说明已验证的回退操作。

## Open Questions

- ~~Codex 桌面版是否接受 MP4 拖入？若接受，它是否把附件交给 MCP，或仅交给 Agent 自身？~~ 已由 A1 探针回答（2026-09-22）：接受拖入，但**不交给 MCP**，只作为宿主文本里的绝对路径交给 Agent；其它宿主仍须分别验证。
- ~~宿主能否提供可验证的附件能力句柄或流？~~ 已由 A1 探针回答：当前 Codex 不提供。可信的本地选择/确认界面首选 MCP elicitation 单文件确认；是否允许预填模型给出的路径、授权是仅本次调用还是短期复用，待用户审定后写入本 ADR 的 Decision。
- 宿主自身的附件类型/大小限制、百炼临时上传限制与模型时长限制分别是多少？跨目录授权不改变这些上限。Codex 桌面侧对 MP4 的类型/大小上限尚未验证。
- 未声明 `readOnlyHint` 的工具在 Codex 中会进入批准门：这会让每次 `analyze_video` 调用可能多一次批准点击，且不应为省点击而谎报只读。是否需要在产品文案与安装示例里显式说明，待审定。
