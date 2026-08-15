# Video MCP v1 开发交接

状态：规格已冻结；交接包已被接手模型接受为实施基线；业务代码尚未修改。

基线快照：`sommio/qwen-omni-mcp@8a07182554a985456153644e0006a22bd1c769f7`。

工作区 git 根：`Video MCP/`（见 ADR 0006）。实现目录仍是本目录。

本地分支：`feat/video-mcp-v1`。

目标：给单个 Agent 增加一个像原生多模态能力一样使用的视频分析工具。

## 接手确认（2026-08-15）

接手模型**接受本交接包为绑定实施基线**，不是把协议验证当成实现完成，也不是无条件背书每一句已经可执行。

接受并遵守：

- ADR 0001–0005 的产品与技术决策，以及 ADR 0006 的工作区 git 根。
- 唯一公开 Tool `analyze_video(video, question?, max_tokens?)` 与 [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md)。
- 本地 500 MiB 必须走授权 FileHandle + 流式临时上传；禁止把上游 25MB Base64 主路径放大。
- 推理走官方 `stream: true` SSE，向 Agent 只返回聚合纯文本。
- 本地路径默认拒绝；`QWEN_ALLOWED_ROOTS` 未配置时拒绝全部本地文件。
- 一次只做 [`tasks/todo.md`](tasks/todo.md) 的一个任务；Gate 1/2/3/4 必须停下来等人审。
- 不改范围、不加生产依赖、不升级 MCP SDK、不发布、不推送、不跑未授权 live test。
- 不读取、复制、打印或提交密钥文件；`text/*.key` 与 `.env` 不是配置源。

明确记下、不视为已解决：

- 2026-08-15 小视频链路只证明协议可行。
- Gate 1 的 500 MiB Windows 内存是最大技术未知数；不合格时只申请依赖，不擅自加库。
- 300 秒上传凭证对慢速上行是产品限制，不能靠自动重传掩盖。
- Windows 同账户 TOCTOU 是已披露残余风险，Gate 3 不得宣称已消除。
- 上游 `AGENTS.md` / `README.md` 仍描述五 Tool 与 25MB Base64；专项 Tool 表面以 ADR 0001 为准，T08 之前不把计划写成已发布功能。
- `package.json` 0.3.1 与 `src/server.ts` initialize 版本 0.4.0 不一致，属既有问题，T08 处理。
- P04 已完成：依赖已按 lockfile 安装，基线质量门已记录在 [`tasks/todo.md`](tasks/todo.md)。typecheck / lint / build 通过；format、Windows `chmod` 测试和生产 audit 失败已记下，未为变绿而改代码或升级依赖。

## 接手者先读

按以下顺序阅读，读完再改代码：

1. [`AGENTS.md`](AGENTS.md)：仓库硬性规则。
2. [`docs/SPEC.md`](docs/SPEC.md)：范围、完成定义与边界。
3. [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md)：唯一公开 Tool 契约。
4. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：模块与数据流。
5. [`docs/PROVIDER_PROTOCOL.md`](docs/PROVIDER_PROTOCOL.md)：临时上传和 SSE 的精确协议。
6. [`docs/SECURITY.md`](docs/SECURITY.md)：本地媒体外传边界。
7. [`docs/TESTING_AND_VERIFICATION.md`](docs/TESTING_AND_VERIFICATION.md)：测试矩阵和已验证基线。
8. [`tasks/plan.md`](tasks/plan.md) 与 [`tasks/todo.md`](tasks/todo.md)：执行顺序。
9. [`docs/REVIEW_GATES.md`](docs/REVIEW_GATES.md)：何时必须停下交给主审核者。

架构理由记录在 [`docs/decisions`](docs/decisions)；实现方向与 ADR 冲突时，不得静默改变 ADR。

## 已作出的不可擅改决策

- 对 Agent 只暴露 `analyze_video`，不暴露模型、上传方式、OSS、抽帧或 Thinking 参数。
- Tool 的 `video` 输入支持本地绝对路径和公开 HTTPS URL；本地路径必须位于显式允许根目录内。
- 当前后端固定为 `qwen3.5-omni-flash`，一个带音轨的视频文件直接做画面与音频联合理解。
- 500 MiB 本地视频禁止 Base64 和整文件 `readFile()`；必须从已授权文件句柄流式 multipart 上传。
- 正式推理按官方契约使用 `stream: true`，聚合 SSE `delta.content` 后向 Agent 返回纯文本。
- v1 使用 DashScope 北京区临时上传；48 小时自动删除。临时上传只定位为个人/开发用途。
- v1 以 Node.js 20/22 为运行时；Windows Node 22 是发布验收环境。Bun 二进制不属于 v1 完成条件。
- 不增加生产依赖。若内置 Node 能力不能可靠完成 multipart 流式上传，先在 Gate 1 停下申请依赖决策。

## 执行规则

1. 一次只完成 [`tasks/todo.md`](tasks/todo.md) 中一个任务。
2. 先跑该任务的最小测试，再跑仓库完整质量门。
3. 每完成一个任务，更新 todo 的状态和验证记录；不要把计划写成已完成。
4. 到 Gate 1、2、3、4 必须停止，将指定证据交给主审核者；未通过不得继续。
5. 不改需求范围、不升级 MCP SDK、不发布、不推送远端、不创建 PR。
6. 不安装新依赖，除非用户明确批准。
7. 不读取、复制、打印或提交任何密钥文件；实时测试只能从调用进程的 `DASHSCOPE_API_KEY` 环境变量取值。
8. stdout 只允许 MCP JSON-RPC；诊断信息写 stderr，并按安全文档脱敏。

## 开发前检查

在工作区根或本目录执行以下只读命令，不安装依赖：

```powershell
git status --short --branch
git rev-parse HEAD
git diff --check
```

当前仓库 HEAD 是工作区根的实施历史，不再等于上游提交。代码快照对照仍为：

```text
8a07182554a985456153644e0006a22bd1c769f7
```

远程 `upstream` 指向 `https://github.com/sommio/qwen-omni-mcp.git`，需要对照上游时再 fetch。

P04 已在 `qwen-omni-mcp/` 执行 `npm install`。husky 因 git 根在工作区根而未能设置 `core.hooksPath`；不要为修 hooks 改全局 git config。后续质量门：

最终质量门：

```powershell
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

真实 API 测试会产生费用，不得自动执行。仅在用户明确授权、环境变量已由用户注入后运行。

## 当前证据与剩余风险

2026-08-15 已用一个 2.581 秒 MP4 做过真实链路验证：临时上传 policy、上传、`qwen3.5-omni-flash` SSE 推理均成功；模型同时识别出画面红色数字 `24` 和音频 `3.1415926`。policy 返回的模型上限为 1024 MB。

这只证明协议可行，不证明实现已完成。仍需验证：

- 50–100 MiB 和 450–500 MiB 流式上传的峰值内存；
- Windows 中文路径、junction 与 500 MiB 真实端到端；
- MCP Host 内真实调用，而非单独 HTTP 脚本；
- 取消、超时、429、5xx、SSE 截断与错误脱敏；
- Node 20/22 下 multipart 流是否保持常量级内存。

## 给下一模型的启动提示词

```text
你正在实现 qwen-omni-mcp 的专项 Video MCP v1。先完整阅读仓库 AGENTS.md、
DEVELOPMENT_HANDOFF.md、docs/SPEC.md、docs/API_CONTRACT.md、
docs/ARCHITECTURE.md、docs/PROVIDER_PROTOCOL.md、docs/SECURITY.md、
docs/TESTING_AND_VERIFICATION.md、tasks/plan.md、tasks/todo.md 和
docs/REVIEW_GATES.md。严格按 todo 顺序一次完成一个任务；不要改变公开 Tool
契约，不要增加依赖，不要读取或打印密钥，不要执行付费 live test，不要推送。
到任何 Review Gate 时停止，提交该 Gate 要求的 diff、测试输出和风险说明，等待主审核者。
```
