# 脚本用途与调用边界

## 日常开发与免费验证

- `dev.mjs`：本地开发入口。
- `prepare.mjs`：安装钩子；npm 安装场景按脚本条件处理。
- `check-secrets.mjs`：提交/推送时的密钥扫描，不得绕过。
- `install-e2e.ts`、`pack-install-e2e.ts`、`npx-github-e2e.ts`：安装、打包和 GitHub npx 验证；npm scripts 是维护入口。
- `installed-smoke.ts`：已安装 MCP 的协议验收；其 live 分支会调用服务商，须明确付费授权。

## 需要授权的真实探针

`live-boundary.ts` 与 `t09-e2e.ts` 是真实媒体边界/调用探针，可能上传文件并产生费用，不属于默认免费门禁。`t09-e2e.ts` 保留历史任务编号，但已经使用当前 `analyze_media` 契约，不因名称旧而删除。不要为补证重传被服务商拒绝的媒体。

## 历史研究

`research/` 保存本地音频信号与 FileHandle 输入实验。它们被 [ADR 0019](../docs/decisions/0019-v07-local-measurement.md) 和 [夹具说明](../test/fixtures/README.md) 引用，不是当前生产 FFmpeg 功能，也不属于默认测试。保留原路径以维持证据可复现性。

当前测试步骤见 [测试手册](../docs/TESTING_AND_VERIFICATION.md)。
