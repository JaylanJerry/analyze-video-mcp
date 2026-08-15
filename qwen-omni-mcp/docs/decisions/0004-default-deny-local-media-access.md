# ADR 0004：本地媒体访问默认拒绝

- Status: Superseded in part by ADR 0010（未配置允许根时不再拒绝全部本地路径）
- Date: 2026-08-15

## Context

上游把任何非 HTTP(S) 字符串当作本地路径。扩展名和 magic 可以阻止文本密钥伪装成媒体，却不能阻止 Agent 上传用户未授权的真实私人视频。symlink/junction 还可能从看似允许的目录跳到外部。

## Decision

- 本地路径必须为绝对路径，并位于 `QWEN_ALLOWED_ROOTS` 的某个 real root 内。
- 未配置 roots 时拒绝所有本地路径。
- 使用 `realpath + path.relative` containment，不用字符串前缀。
- 采用 stat/open/fstat/realpath recheck，并从同一个 FileHandle 校验和上传。
- MP4 only、500 MiB 上限、固定小块 magic 检查。
- 所有错误和日志按白名单字段脱敏。

## Alternatives

1. 默认允许 cwd：拒绝；Host cwd 可能过宽且不透明。
2. 只校验扩展名和 magic：拒绝；合法私人视频仍会被外传。
3. 禁止所有 symlink：未采用；允许根内合法工作流会受损，真实目标 containment 更精确。
4. 每次调用弹出 UI 确认：暂缓；stdio MCP 没有统一 UI，超出 v1。

## Consequences

- 用户需要显式配置视频目录。
- Prompt injection 的任意媒体外传面显著缩小。
- Windows junction 和 TOCTOU 增加实现与测试成本。
- Node 缺少完全可移植的 Windows `openat/O_NOFOLLOW` 等价能力，同账户主动竞态作为已披露残余风险保留。
