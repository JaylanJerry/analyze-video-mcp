# Video MCP v1 实施计划

## 当前状态

- 规格与交接文档：完成。
- 交接包：已被接手模型接受为实施基线（见 `DEVELOPMENT_HANDOFF.md`）。
- 业务代码：未修改。
- 依赖：已按 lockfile 安装；未变更 lockfile，未为 audit 升级。
- P04 基线：typecheck / lint / build 通过；format、Windows `chmod` 测试、`npm audit --omit=dev` 有失败记录。
- 工作区 git 根：`Video MCP/`（ADR 0006）。
- 上游基线快照：`8a07182554a985456153644e0006a22bd1c769f7`。
- 实施分支：`feat/video-mcp-v1`。

## 阶段

### Phase A：安全的大文件入口

目标：本地 MP4 经过 allowed roots、FileHandle、magic、大小校验后，以常量级内存完成 multipart 上传。

任务：T01–T03。

退出条件：Gate 1 通过。

### Phase B：稳定 Provider 协议

目标：固定 Qwen3.5-Omni-Flash payload，正确聚合 SSE，处理超时和有限重试，并通过真实小型 AV 语义验证。

任务：T04–T05。

退出条件：Gate 2 通过。

### Phase C：单 Tool MCP 产品化

目标：将内部管线接到唯一 `analyze_video`，统一错误，保证 stdio 和取消安全。

任务：T06。

退出条件：Gate 3 通过。

### Phase D：发布候选验证

目标：完善 Windows CI、文档和真实 500 MiB Agent E2E。

任务：T07–T09。

退出条件：Gate 4 通过。

## 依赖关系

```text
T01 config/errors
  -> T02 media authorization
      -> T03 streaming upload
          -> Gate 1
              -> T04 SSE parser
                  -> T05 provider + semantic live
                      -> Gate 2
                          -> T06 MCP integration
                              -> Gate 3
                                  -> T07 CI/Windows
                                  -> T08 docs/release metadata
                                      -> T09 500 MiB Agent E2E
                                          -> Gate 4
```

## 变更控制

下列情况立即停止并请求决策：

- 需要新增生产依赖；
- 需要改变 Tool 名称或 schema；
- 临时 policy 动态上限降到 500 MiB 以下；
- 官方 API 与 live 基线冲突；
- 需要读取/修改密钥文件；
- 需要发布、推送、PR 或生产 OSS；
- Node 内置流在 Windows 无法满足内存上限。
