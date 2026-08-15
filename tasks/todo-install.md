# 安装形态任务

规格：[`../docs/SPEC_INSTALL.md`](../docs/SPEC_INSTALL.md)。一次只做一项。

## I01：可选允许目录

- [x] 未设 `QWEN_ALLOWED_ROOTS` 时，本地绝对 MP4 可分析。
- [x] 已设允许根时，根外仍拒绝。
- [x] ADR 0010 Accepted。

## I02：问句说明

- [x] Tool 描述与 server instructions 要求转发或整理 `question`。

## I03：npx 安装入口

- [x] git 根 `bin` + prepare 能产出 `dist`。
- [x] 三份 Host 模板改为 `npx`，Key 必需，目录可选。
- [x] README 主安装路径是 `npx`，不是本机 `dist`。

## I04：安装冒烟与门禁

- [x] `npm run test:install` 验证 initialize / listTools。
- [x] 根目录 CI 拆开，格式失败不挡住测试。
- [x] 根目录 Gitleaks。
- [x] README 写明建议填写 `QWEN_ALLOWED_ROOTS`。
