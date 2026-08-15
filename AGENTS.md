# Video MCP 工作区规则

实现与规格在 `qwen-omni-mcp/`。先读该目录的 `DEVELOPMENT_HANDOFF.md`，再改代码。

硬规则：

- 一次只做 `qwen-omni-mcp/tasks/todo.md` 中的一个任务。
- 不改变 `analyze_video` 公开契约，不增加生产依赖，不推送，不发布。
- 不读取、复制、打印或提交 `text/` 下的密钥或任何 `*.key` / `.env`。
- live fixture 留在 `text/`，不要复制进仓库。
- 付费 live test 只有用户明确授权且已注入 `DASHSCOPE_API_KEY` 后才能跑。
- 到 Gate 1/2/3/4 必须停止，等待主审核者。

`qwen-omni-mcp/AGENTS.md` 仍是上游仓库规则。专项 Tool 表面以 ADR 0001 和 `docs/API_CONTRACT.md` 为准，不要为迁就上游五 Tool 测试而保留旧接口。
