# ADR 0021：允许根外的本地视频——一次配置的直传开关

- Status: Accepted
- Date: 2026-09-22
- Supersedes: ADR 0020 的“单文件 elicitation 确认”方向；局部取代 ADR 0015 对“允许根外一律拒绝”的结论
- Spec: [`SPEC_V07_PROPOSAL.md`](../SPEC_V07_PROPOSAL.md)

## Context

用户要求在 Codex 里“拖入视频 → 说一句调用 MCP 分析 → 直接上传分析”，不要确认弹窗或额外点击。A1 探针（见 [`tasks/deepseek-v07-handoff.md`](../../tasks/deepseek-v07-handoff.md)）已证明宿主不给 MCP 任何可验证的附件来源：

- Codex 把拖入的 MP4 写成用户消息里的一段文本（`# Files mentioned by the user` + `文件名: 绝对路径`），视频没有结构化附件对象；只有图片有 `localImage` 内容块。
- MCP 边界只收到模型自己写出的 `arguments` 加会话元数据 `_meta["x-codex-turn-metadata"]`，没有文件句柄、资源引用或授权范围。
- 因此“用户拖入”与“模型编造同一路径”在 MCP Server 侧不可区分，ADR 0015 的默认拒绝有其根据。

同时，用户的旧流程需要先把视频复制进 `QWEN_ALLOWED_ROOTS` 才能分析，摩擦明显。用 MCP elicitation 做单文件确认在协议层可行（客户端声明 `elicitation: {form, url}`，`tool_call_mcp_elicitation` 为 stable），但用户明确否决额外确认步骤。

## Decision

1. 新增安装级开关 `QWEN_ALLOW_ANY_LOCAL_VIDEO`（`on|off|1|0|true|false`，默认 `off`）。关闭时行为与 v0.6.1 完全一致：本地 MP4 必须位于 `QWEN_ALLOWED_ROOTS` 内，未配置允许根则拒绝。
2. 打开后，`analyze_video` 接受**任何**绝对路径的本地 MP4，不再要求位于允许根内。`QWEN_ALLOWED_ROOTS` 在该模式下不参与判定。
3. 关闭允许根判定不减少其它校验：绝对路径与 `.mp4` 扩展名、`realpath` 解析、普通文件与大小上限、只读 `FileHandle`、打开前后身份复核（大小、inode/dev、mtime 身份键）、`ftyp` 魔数、`mvhd` 时长上限（>3600s 拒绝）、流式上传、取消与脱敏错误。
4. 授权来源是**安装者的配置动作**，不是模型文本：开关只能在 MCP `env`、`--config` 文件或用户配置文件里打开。刻意不把该名字加入 Windows 用户环境变量静默回退列表（[ADR 0016](0016-config-sources-and-evidence-audit.md)），以免被悄悄启用。
5. `--doctor` 报告 `local_video_policy.mode = allowed_roots | any_local_path`，并在打开时输出一条提示，说明“Agent 写出的任意本地路径都会被上传，包括用户没有选过的文件”。
6. 开关打开时允许根不再参与判定，因此**不可用的允许根条目被忽略而不是让每次调用失败**（媒体目录改名/移动后不再全量报错），`--doctor` 会列出被忽略的条目。开关关闭时保持严格：条目不可用即拒绝本地文件，且 `CONFIG_MISSING` 的 Agent 文案会点出 `QWEN_ALLOWED_ROOTS` 变量名。
7. `analyze_video` 的名称与字段不变；Server instructions 与 Tool 描述同时说明两种模式，被拒绝时提示改配置，不引导换路径重试。
8. 不实现确认弹窗、不新增公开 Tool、不加运行时或生产依赖。ADR 0020 的 elicitation 方案不实施。

## 宿主侧注意

`analyze_video` 没有声明 `readOnlyHint`（它确实会上传媒体），因此在需要批准的模式下，宿主可能把它交给自动风险审查并拦下上传（2026-08-22 与本文件实施后各观察到一次）。Codex 侧用 `default_tools_approval_mode = "approve"` 让该服务器的工具直接放行；不要为了省一次点击而谎报只读。

## 接受的代价

打开开关后，**路径文本不再被视为授权凭据**：任何能让模型写出路径的内容（网页、字幕、被拖入的文档、其它工具输出）都可能触发本地视频上传到阿里云百炼（付费、第三方）。这是用户为自己安装选择的自担风险行为，不能作为默认值发布给不了解该风险的安装，也不能在文档里描述成“安全隔离”。默认保持 `off`，README 在讲清代价后再给出一行开启示例。

### 调用条件只写在提示词里

2026-09-22 用户要求：**只有用户明确要求用 MCP 分析视频时才调用，其余视频需求走宿主自带流程**。该要求已写进 Server instructions 与 Tool 描述的第一句，并同步到 README、API 契约与安装示例。

必须明确：这是提示词引导，**不是强制机制**，也不构成开关打开后的安全边界。宿主可以忽略 instructions，模型也可能不遵守；因此不接受“因为提示词写了只在明确要求时调用，所以打开开关是安全的”这类论证。开关的默认值与风险说明不因此放宽。

## Consequences

- 用户体验：拖入任意目录的视频 + 一句“调用 MCP 分析”，直接上传分析，无弹窗。
- 其它宿主若同样只给路径文本，同一开关即可覆盖；文档只声明已在 Codex 0.147.0 实测的流程。
- 纯音频文件仍不在范围内（需要 `analyze_audio` 与供应商音频协议，见 ADR 0018/0019）；本 ADR 不改变本地文件类型支持范围。

## Acceptance Criteria

1. 开关 `on` 时，允许根外的单个 MP4 可流式上传并分析；开关 `off` 时同一路径仍返回 `VIDEO_PATH_NOT_ALLOWED`。
2. 开关 `on` 时，文件替换、junction 改指、坏 MP4、超大小、超时长仍被拒绝，错误不泄露路径、密钥或 `oss://`。
3. `--doctor --json` 报告生效模式与来源；非法取值报错而不是静默回退。
4. 默认安装（不设置该变量）行为与 v0.6.1 一致。
5. 允许根目录被改名或移动后：开关 `on` 时 `--doctor` 仍 `ok=true`，调用不再返回 `CONFIG_MISSING`；开关 `off` 时仍严格失败，且错误里点出 `QWEN_ALLOWED_ROOTS`。
