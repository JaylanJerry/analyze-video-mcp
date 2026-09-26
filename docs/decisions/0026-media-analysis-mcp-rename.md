# ADR 0026：统一为 Media Analysis MCP

- Status: Accepted; npm 2.0.0 published, GitHub Release pending
- Date: 2026-09-26
- Authorized by: User（所有当前名称统一，并与仓库整理一起提交发布）
- Supersedes: ADR 0017 的新安装示例命名；历史版本不变

## Context

1.0.0 已支持 MP4/MOV/MP3，但包名、CLI、服务端标识和宿主示例仍带 video。用户确定产品名为 Media Analysis MCP，并要求所有当前名称统一。仓库整理已经准备完毕，本次合并为同一发布批次。

## Decision

1. 展示名和默认 MCP server name 使用 `Media Analysis MCP`；npm 包、CLI 和 GitHub 仓库 slug 使用 `media-analysis-mcp`，宿主示例键使用 `media_analysis_mcp`。
2. 按破坏性迁移准备 **2.0.0**，避免复用已经发布且不可变的 `v1.0.0`。Tool 仍只有 `analyze_media(media, prompt)`，请求格式、模型配置与授权环境变量不变。
3. 默认用户配置目录改为 `.media-analysis-mcp`，默认缓存目录与凭证指纹域改为 `media-analysis-mcp`。不自动读取旧配置或复用旧缓存；安装者迁移配置或显式提供 `--config`。迁移后第一次分析可能重新上传。
4. 当前源码、示例、安装探针、README、仓库元数据及发布说明统一。旧 npm 版本、tag、已接受 ADR、归档报告和已发布包原样保留，历史记录不重命名成新事实。
5. 新 npm 包不存在时，旧包的 Trusted Publisher 不会自动授权新包。须完成新包首次发布/建立发布权限，并将 publisher 绑定 `JaylanJerry/media-analysis-mcp` 与 `release.yml`；不添加长期 NPM_TOKEN，也不绕过登录、2FA 或发布门禁。新包首次建立需要用户完成 npm 身份验证与必要的 2FA；本次明确的发布授权覆盖首次发布，认证成功后可发布已验证包，后续 tag 发布继续走 Trusted Publishing。
6. 仓库更名不改变所有权或可见性；保留旧地址的 GitHub 重定向，更新本仓库 remote 与新安装回退示例。不擅自更名工作区目录、修改宿主本地配置或卸载全局旧包。

## Consequences

- npm 不会把旧包的安装自动升级到新包；用户须显式修改安装命令与宿主键并重启，避免两个条目重复加载。
- 默认配置路径与缓存域变化是明确的迁移成本，不扩大本地文件授权，也不添加生产依赖。
- GitHub 更名、npm 新包权限、CI、正式发布和 registry 安装分别记录真实状态。全部名称替换不代表发布已经完成。
- 免费回归验证包/锁文件/CLI/server/config/cache/宿主示例一致，真实媒体调用不属于这次更名验收。
