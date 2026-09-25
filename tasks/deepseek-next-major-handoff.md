# DeepSeek 接手：下一大版本媒体网关

状态：**A/B/C/D1/D2/D3 已在工作区分支实现并通过本地门禁（2026-09-25，Node 24）；A-P 与 D4 的服务商格式矩阵已获授权并完成真实验证；Codex 当前任务的 MP4 MCP 调用与 ZCode GUI 新会话的拖入 MOV/MP3 调用均已通过；同一会话还记录了 ADR 0023 之后内容检查拒绝的首个真实现场（HTTP 400 正文形态，`inspection_side=unknown`，未重试）与一条模型可靠性反例（同一 MP3 样本被报成 4 段、切换点 2/5/8 秒，本地实测 3 段、≈2.9/5.9 秒）。** Codex 新会话拖入、Codex 宿主 MOV/MP3、费用金额及 Node 22 CI 仍未验证。**已本地提交 `381da84`**（未推送、未发布）；npm 上的 `0.6.1` 仍是 `analyze_video`。逐项证据与未验证项见 [`todo-next-major-media-gateway.md`](todo-next-major-media-gateway.md)；ZCode 会话三个文件（MOV 成功、私片被内容检查拒绝、MP3 计数反例）的完整交接报告见 [`zcode-probe-report-20260925.md`](zcode-probe-report-20260925.md)。接手时先读根目录 `AGENTS.md`、`DEVELOPMENT_HANDOFF.md`，再按以下顺序阅读：

1. [`../docs/SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md`](../docs/SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md)：目标、公开契约、验收与未验证事实。
2. [ADR 0024](../docs/decisions/0024-agent-directed-media-gateway.md)：为什么停止旧三 Tool/审核主线。
3. [`plan-next-major-media-gateway.md`](plan-next-major-media-gateway.md) 与 [`todo-next-major-media-gateway.md`](todo-next-major-media-gateway.md)：实施顺序与检查点。
4. [`../docs/API_CONTRACT.md`](../docs/API_CONTRACT.md)、[`../docs/SECURITY.md`](../docs/SECURITY.md)、[`../docs/PROVIDER_PROTOCOL.md`](../docs/PROVIDER_PROTOCOL.md)：**当前工作区分支（未发布）**的契约、协议实测与安全边界；已发布 `0.6.1` 的行为须另看版本说明。
5. ADR 0021/0022/0023：任意本地视频开关的真实权限含义、可选静音核对历史、内容检查拒绝的修复。

## 已批准的方向

一个 Agent 可见的 `analyze_media(media, prompt)`，本地 MP4/MOV/MP3，加已有 HTTPS URL。Agent 负责提出和追问问题；MCP 负责授权、探测、上传、协议、错误、进度、脱敏和用量。百炼为首发唯一服务商；不自动跨云回退。旧 `analyze_video` 改名属于下一破坏性大版本，不是当前小版本的静默变更。继续沿用包名与启动方式。用户已确认这一产品方向与大版本重构，无需为普通实现步骤反复索取同一决定。

## 接手续做

1. 只读检查 `git status --short --branch`、最近提交和现行代码；保留仓库中他人的工作，不重置或覆盖。确认这些文档没有被后续决定替代。
2. 先复核 A/B/C/D1-D3 的实现与 A-P/D4 的证据，再处理任务清单里的剩余事项：Codex 新会话拖入、Codex 宿主 MOV/MP3、模型静默忽略音频的防误报方案和 Node 22 CI（ZCode GUI 新会话、拖入 MOV 与宿主 MP3 已于 2026-09-25 通过，不要重复；那次宿主 MP3 把 3 段音调报成 4 段、切换点整体偏移并多报一个，可直接当作防误报方案的反例素材）。每项记录修改、验证与已知限制，不重复已完成的付费探针。
3. 使用 `msw`/无私密合成夹具覆盖 MP4/MOV/MP3。默认测试不发真实请求；真实协议验证在相应上传与费用获得**针对该试验**的明确授权之后进行。先前对某个视频的授权不能迁移到新的 MP3 或服务商试验。首批 HTTPS 只保留公开视频 URL 直连，不凭 URL 后缀声称远端音频可分析。
4. 协议不明时给出可复核的失败证据、影响和最小候选方案；不要把文档支持当作本项目实测，不要以 Base64 整文件、自动转码、额外生产依赖或跨云回退作为静默解决办法。
5. 每个检查点更新 `todo-next-major-media-gateway.md` 和必要的规格。按规格逐项落实旧/新错误码与元数据字段条件；缓存须在账号或凭证身份变化时失效，不能保存 Key 或上传凭证。更改公开契约、运行时、依赖或服务商方向时先同步 ADR/规格并取得维护者同意；推送、tag、npm 发布另需明确指令。

## 完成报告格式

按“已实现 / 已验证 / 仍未验证 / 文件与提交 / 下一步”简洁交接。区分模拟测试、真实百炼、宿主 GUI、打包安装与 npm 发布五种状态。`analyze_media` 注册成功不等于 MP3 模型听懂；音轨或非零音频信号也不等于模型确认听到。任何实际媒体上传、模型费用、内容检查拒绝和密钥/路径脱敏结果必须如实记录。

## 可直接转给 DeepSeek 的任务提示

> 在 `C:\Users\jjbon\Documents\projects\Video MCP` 接手下一大版本媒体网关。先读根 `AGENTS.md`、`DEVELOPMENT_HANDOFF.md`、`docs/SPEC_NEXT_MAJOR_MEDIA_GATEWAY.md`、ADR 0024 和 `tasks/todo-next-major-media-gateway.md`。当前工作区已实现唯一 `analyze_media(media, prompt)`，A-P 的 MP3 真实百炼组合和 D4 的服务商格式矩阵已有证据，Codex 当前任务的公开 MP4 Tool 调用与 ZCode GUI 新会话的拖入 MOV/MP3 调用也已通过（MP3 那次含一条模型计数反例）；这些都尚未发布。继续核对宿主剩余路径（Codex 新会话拖入、Codex 宿主 MOV/MP3）、模型静默忽略音频的防误报方案及 Node 22 CI，保留授权、脱敏、取消、缓存与内容检查拒绝防护。不要重复已完成的付费探针，也不要把 Codex 宿主 MP4 或 ZCode 宿主 MOV/MP3 的成功外推到 Codex 新会话拖入或 Codex 宿主。新依赖、新的付费 live、推送和发布按仓库规则分别审阅。逐项报告已实现、已验证、未验证与下一步，维护当前工作区已有变更。
