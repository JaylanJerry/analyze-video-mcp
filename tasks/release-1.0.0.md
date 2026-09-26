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
- 发布准备提交与分支推送：待执行（Git push dry-run 与钩子已通过）。
- Node 24 远程 CI 与 Secret Scan：待通过。
- v1.0.0 tag / npm 发布 / registry 安装复验：待执行。

在远程 CI 通过前不推发布 tag；任何失败均记录真实状态，不把本地通过当成发布成功。
