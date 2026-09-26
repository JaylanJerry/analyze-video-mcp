# 1.0.0 发布审核与状态

日期：2026-09-26。用户授权：最终再审核，若无阻塞则提交、推送并发布 npm。

## 版本与范围

- 选择 1.0.0：Tool 重命名、prompt 必填、授权变量迁移和报告层退出均为破坏性变更；规格允许发布准备时确定版本号。
- 只支持 Node 24.x，遵循 ADR 0025。不引入生产依赖，不新增启动硬阻断。
- 保留 npm 0.6.1 历史事实；本次不得覆盖旧版本。
- README、Cursor 按钮与模板迁移到 1.0.0 / MEDIA_*。JSON 模板可直接解析。
- 发布采用 ADR 0014 的版本 tag 与 Trusted Publishing，不使用 NPM_TOKEN。

## 最终审核

- 已审核 Node 24 变更：根锁信息之外无依赖升级，required-ci 与系统/安装门禁保留。
- 缓存只改中段的陈旧媒体、未知时长放行、模型计数/时间点不可靠仍是已声明限制。
- 本机 gh 认证失效，GitHub 连接器仍具仓库管理权限；提交/push 能否完成须实测。
- 独立 Luna 代码复核：通过，未发现证据充分的新代码发布阻塞。MP4/MOV 门禁使用原始 bigint 比较，展示取整不绕过时长门槛；Host 取消与分析器超时已区分。SSE 提前退出清理与极窄取消竞态留作后续健壮性优化，不在本轮扩大范围。

## 验证与发布状态

- 本地 1.0.0 全门禁：通过（Windows Node 24.18.0）；typecheck / lint / format / test / coverage / build；302 passed + 1 skipped，覆盖率 88.76% stmts / 82.48% branches / 91.18% funcs / 90.23% lines。生产依赖 audit 为 0 vulnerabilities。
- 独立打包安装与 stdio 握手：通过，38 files，唯一工具 analyze_media，字段 media/prompt；test:install 通过；CLI --version 为 1.0.0。JSON 模板解析与 Cursor 按钮 Base64 解码均通过。
- 发布准备已提交 d216a8a 并推送 codex/optimization-prep；正常通过提交与推送钩子，工作区提交后干净。PR：[#39](https://github.com/JaylanJerry/analyze-video-mcp/pull/39)。
- 首轮远程 CI：[36226038948](https://github.com/JaylanJerry/analyze-video-mcp/actions/runs/36226038948)。Linux test/coverage 在同一测试断言失败：公开 URL 必须保留，而旧断言又禁止其包含相同的 POSIX 路径子串；实际脱敏结果符合契约。已将矛盾断言改为完整预期文本相等，保留公开 URL 与两份答案一致的检查；修复后须重新通过全部 CI。Windows test、静态检查、构建、生产 audit、Linux 安装/打包/GitHub npx、macOS smoke 已通过；Windows 打包/GitHub npx 仍运行中。推送 Secret Scan 已通过。
- v1.0.0 tag / npm 发布 / registry 安装复验：待执行。

在远程 CI 通过前不推发布 tag；任何失败均记录真实状态，不把本地通过当成发布成功。

## 远程验收后的补修

- Linux CI 矛盾断言：test/tools.test.ts 不再禁止公开 URL 的合法 POSIX 路径子串，改为精确验证独立路径隐藏与链接保留。
- installed-smoke.ts 的 live 分支迁移到 media/prompt 及 request/media/usage/limitations，删除旧证据报告字段；任意文件授权开关改用 MEDIA_*。
- 新增假的 MCP 服务协议测试（视频/音频两种验收模式），验证实际 JSON-RPC 参数与结果读取，零上传、零服务商费用。

补修后本地门禁通过：304 passed + 1 skipped（19 文件）；typecheck / lint / format / coverage / build 全过，生产覆盖率未变。
