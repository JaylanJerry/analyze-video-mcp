> **历史归档（2026-09-26）：** 本文保留当时的计划、结论和未验证项，不作为当前实施指令或发布状态。当前入口见 [开发交接](../../../DEVELOPMENT_HANDOFF.md)，发布事实见 [1.0.0 发布记录](../../../tasks/release-1.0.0.md)。

# 下一阶段开发基线（2026-09-22）

## 仓库同步

- 远端 `origin/main`：`f2debdf`。本地 `codex/optimization-prep` 从该提交创建，用作后续开发基线；未推送。
- 原本地工作分支 `docs/v061-published`：`422620d`。远端同名分支已不存在。它与远端 `f3b15fd` 的文件树完全相同，发布记录已经进入 `main`，无需重放或合并该提交。
- 原本地 `main`：`698086a`，与现行远端 `main` 各有独有提交。保留作历史，不用它作为新功能基线，不对其执行 reset 或强推。
- 远端在 v0.6.1 后主要更新了依赖与锁文件、GitHub Actions 版本，并调整了两处测试和 `src/doctor.ts`。公开 Tool 契约没有因此变化。

## 开发前检查

1. 已获准按锁文件运行 `npm ci`；`npm ls --depth=0` 现已通过。安装过程提示无法重写 `.git/config`，核对后现有 `core.hooksPath=.husky/_`，hook 文件存在。
2. `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm test`、`npm run build`、`npm run coverage` 已通过。默认测试为 175 通过、6 跳过；总体行覆盖率 88.29%、分支覆盖率 79.43%，满足 `vitest.config.ts` 的门槛。未触发付费 live API。
3. 握手、doctor 和单 Tool 列表已有默认自动化测试覆盖。后续若需人工 Host 验证，只记录脱敏结果，不读取或展示 Key。
4. 开发时以 `origin/main` 为上游，先在当前工作分支做小范围变更；推送、PR、发布另行确认。

## 下一阶段范围门槛

- 已批准的 v0.6.1 行为与 `analyze_video(video, question?)` 契约继续有效。先修复基线验证中实际出现的回归。
- [`docs/archive/specs/SPEC_V07.md`](../../../docs/archive/specs/SPEC_V07.md) 只记录了纯音频、确定性测量、交叉审核的方向，明确写着“尚未实施”，且要求另批 ADR。实施新 Tool、FFmpeg 或新生产依赖前，应先补齐可执行规格、兼容边界、测试夹具与决策记录并取得批准。
- 若下一轮优先做现有视频分析的稳定性或体验优化，应先提出具体问题和可复现证据，再按现有 Tool 契约拆成可验证的小任务。

## 已验证与限制

- 已以实时远端提交重新比较 Git 历史和文件差异，并将本地新分支对齐 `origin/main`。
- 新锁文件依赖已安装，默认质量门通过。Windows 上首次格式检查因工作文件换行符失败；Prettier 写入 LF 后通过，Git 对应文件哈希与 `HEAD` 相同，没有产生跟踪文件的内容差异。
- 未运行付费 live 测试，也未验证真实宿主配置或实际服务调用。
- v0.7 规格细化为待审阅的 [`SPEC_V07_PROPOSAL.md`](../../../docs/archive/specs/SPEC_V07_PROPOSAL.md)，并提出 ADR 0018（Tool 表面）与 ADR 0019（FFmpeg 外部运行时）。两份 ADR 尚未批准，未开始功能实现。
- 用户新增“从任意文件夹拖入 Agent 即分析”的体验目标；已提出 [ADR 0020](../../../docs/decisions/0020-user-granted-local-media.md)。下一步先验证首选宿主是否向 MCP 提供可信附件引用或流，再决定单文件授权实现；当前 `QWEN_ALLOWED_ROOTS` 行为未变。
