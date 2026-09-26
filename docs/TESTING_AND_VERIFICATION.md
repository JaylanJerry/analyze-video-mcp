# 测试与验证手册

当前正式支持 Node 24.x（[ADR 0025](decisions/0025-next-major-node24-support.md)）。1.0.0 本地与远程验收已通过；后续修改须重新验证，不能沿用旧版绿灯。详细发布证据见 [发布记录](../tasks/release-1.0.0.md)。

## 免费质量门

默认单元与 mocked e2e 使用 msw，不调用真实服务商。先跑相关模块测试，再按改动范围运行完整门禁：

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

共享行为变化还需运行 `npm run coverage` 并满足仓库阈值。验证重点包括本地授权及句柄生命周期、MP4/MOV/MP3 有界解析、时长边界、上传与取消、SSE、缓存身份与内容指纹、脱敏、唯一 Tool 契约和宿主结果交付。

只使用合成夹具（`test/mp4-fixtures.ts`、`test/mp3-fixtures.ts`）；默认套件不依赖 FFmpeg。真实媒体样本与测量说明见 [夹具说明](../test/fixtures/README.md)。

## 安装与协议

- `npm run test:pack-install`：本地打包、独立安装与 stdio 握手。
- `npm run test:install`：安装入口验证。
- `npm run test:npx-github`：GitHub 安装路径专项；需要网络。
- `node dist/index.js --doctor`：检查配置与失效变量，输出必须脱敏。
- 安装后 `listTools()` 应只有 `analyze_media`，字段只有 `media` 与必填 `prompt`，版本应与安装包一致。

Windows 含空格路径使用仓库现有脚本，不自行拼 shell 命令。打包脚本的环境前提与已验证平台见发布记录；本地成功不替代远程 CI。

## 真实服务商与宿主

真实调用会上传媒体并可能产生费用，须用户明确授权，密钥须已注入。不要为补证重复上传被服务商拒绝的私人媒体。

Live 入口为 `test/live.test.ts`；设置 `LIVE=1` 后以适合当前 shell 的方式运行。缺少密钥、夹具或必要环境必须失败，不能将全部跳过当作通过。默认 `npm test` 不启用 live。

记录状态、耗时、request id（若服务商提供）、model、usage、upload reuse 与语义结果；不保存密钥、policy、完整 OSS URL 或本地绝对路径。宿主验收分别核对 Tool 加载、拖入路径、调用结果与长答案交付。

真实调用的结论只适用于样本和模型；回答符合样本不证明内部模态路径，也不保证计数或时间码正确。费用以账单为准。当前记录见 [Codex 验收](../tasks/archive/1.0/codex-acceptance-20260926.md)、[ZCode 探针](../tasks/archive/1.0/zcode-probe-report-20260925.md) 与 [Provider 协议](PROVIDER_PROTOCOL.md)。

## 历史证据

整理前的完整手册（含 2026-08 基线及旧运行时矩阵）保存在 [历史快照](archive/snapshots/20260926-TESTING_AND_VERIFICATION.md)，不作为当前测试指令。
