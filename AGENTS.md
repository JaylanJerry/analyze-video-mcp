# Video MCP 工作区规则

实现与规格在 `qwen-omni-mcp/`。先读该目录的 `DEVELOPMENT_HANDOFF.md`，再改代码。

硬规则：

- v1 任务在 `qwen-omni-mcp/tasks/todo.md`，已收尾。下一阶段一次只做 `qwen-omni-mcp/tasks/todo-general.md` 中的一个任务，且须先批准 `docs/SPEC_GENERAL.md`。
- 不改变 `analyze_video` 的名称与字段。默认值与本地上限只有在通用规格批准后才能改。
- 不增加生产依赖，不推送，不发布。
- 不读取、复制、打印或提交 `text/` 下的密钥或任何 `*.key` / `.env`。
- live fixture 留在 `text/`，不要复制进仓库。
- 付费 live test 只有用户明确授权且已注入 `DASHSCOPE_API_KEY` 后才能跑。
- v1 的 Gate 1/2/3/4 已结束。通用方向按 `tasks/plan-general.md` 的检查点停下来等人审。

`qwen-omni-mcp/AGENTS.md` 仍是上游仓库规则。专项 Tool 表面以 ADR 0001 和 `docs/API_CONTRACT.md` 为准，不要为迁就上游五 Tool 测试而保留旧接口。
