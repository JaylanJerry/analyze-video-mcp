# Video MCP v1 文档索引

| 文档                                                         | 用途                                   |
| ------------------------------------------------------------ | -------------------------------------- |
| [`../DEVELOPMENT_HANDOFF.md`](../DEVELOPMENT_HANDOFF.md)     | 接手模型入口、接受范围与工作规则       |
| [`SPEC.md`](SPEC.md)                                         | v1 产品范围、约束、完成定义            |
| [`SPEC_V2.md`](SPEC_V2.md)                                   | V2 完整情况规格（草稿，供通读）        |
| [`SPEC_GENERAL.md`](SPEC_GENERAL.md)                         | 通用方向对照表（已批准并实施）         |
| [`SPEC_V05.md`](SPEC_V05.md)                                 | v0.5.0 工程收口（已发布）              |
| [`SPEC_V052.md`](SPEC_V052.md)                               | v0.5.2 上传缓存、模型 env、安装名      |
| [`SPEC_V06.md`](SPEC_V06.md)                                 | v0.6 宿主稳定、证据门禁、安全默认      |
| [`SPEC_V061.md`](SPEC_V061.md)                               | v0.6.1 配置同源与审核证据热修          |
| [`SPEC_V07.md`](SPEC_V07.md)                                 | v0.7 纯音频与交叉审核（尚未实施）      |
| [`API_CONTRACT.md`](API_CONTRACT.md)                         | 唯一 Agent Tool 的稳定契约             |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)                         | 模块边界、数据流和资源所有权           |
| [`PROVIDER_PROTOCOL.md`](PROVIDER_PROTOCOL.md)               | DashScope policy、multipart、Omni、SSE |
| [`SECURITY.md`](SECURITY.md)                                 | 本地文件授权、脱敏与残余风险           |
| [`TESTING_AND_VERIFICATION.md`](TESTING_AND_VERIFICATION.md) | 测试矩阵、真实基线和 Windows 验收      |
| [`REVIEW_GATES.md`](REVIEW_GATES.md)                         | 主审核者只需介入的四个关卡             |
| [`../tasks/plan.md`](../tasks/plan.md)                       | v1 阶段计划                            |
| [`../tasks/todo.md`](../tasks/todo.md)                       | v1 任务（已收尾）                      |
| [`../tasks/plan-general.md`](../tasks/plan-general.md)       | 通用方向实施计划                       |
| [`../tasks/todo-general.md`](../tasks/todo-general.md)       | 通用方向任务（已收尾）                 |
| [`../tasks/plan-v05.md`](../tasks/plan-v05.md)               | v0.5.0 实施计划                        |
| [`../tasks/todo-v05.md`](../tasks/todo-v05.md)               | v0.5.0 任务                            |

架构决策见 [`decisions`](decisions)。工作区 git 根见 [0006](decisions/0006-workspace-root-git.md)；实现提到仓库根见 [0011](decisions/0011-flatten-implementation-to-repo-root.md)；Gate 1 运行时见 [0007](decisions/0007-gate1-node24.md)；通用方向见 [0009](decisions/0009-general-host-config-and-1gib.md)；v0.5.0 收口见 [0012](decisions/0012-v050-runtime-and-hygiene.md)；v0.5.2 见 [0013](decisions/0013-upload-cache-and-host-server-name.md)；npm tag 发布见 [0014](decisions/0014-npm-trusted-publishing.md)；v0.6 见 [0015](decisions/0015-host-reliability-and-evidence-gate.md)；v0.6.1 见 [0016](decisions/0016-config-sources-and-evidence-audit.md)；示例 Host 键见 [0017](decisions/0017-host-config-key-analyze-video-mcp.md)。v1 / V2 / 安装 / v0.5.0 已收尾。默认安装钉 `analyze-video-mcp@0.6.1`。示例 Host 键 `analyze_video_mcp`。
