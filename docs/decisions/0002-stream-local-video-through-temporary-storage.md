# ADR 0002：本地大视频通过临时存储流式上传

- Status: Accepted
- Date: 2026-08-15

## Context

上游把本地媒体完整读入内存、Base64 编码后放入 JSON，并限制 25 MiB。目标文件可达 500 MiB；Base64 会增加约三分之一体积并产生多份内存表示。Qwen3.5-Omni 官方又要求 Base64 字符串小于 10 MB，而 URL 视频支持到 2 GB/1 小时。

DashScope 北京区提供临时上传，返回 48 小时有效的 `oss://` URL。2026-08-15 已真实验证目标模型 policy 上限为 1024 MB，上传与推理成功。

## Decision

本地 MP4 主路径为：

```text
authorized FileHandle -> streaming multipart -> oss:// -> model
```

v1 使用 `DashScopeTemporaryUploader`，每次动态获取 policy，并在发送任何文件字节前检查上限。禁止 Base64、整文件 Buffer/Blob 和 `readFile()`。临时对象依赖 48 小时自动删除，不实现不存在的远程删除。

上传器通过内部接口隔离，未来可替换为正式 OSS 预签名上传而不改变 Tool。

## Alternatives

1. 把上游 25 MiB 常量改成 500 MiB：拒绝；内存不可接受且违反 provider Base64 限制。
2. 要求用户自行上传公网 URL：拒绝；破坏“像原生能力一样”的体验。
3. 立即建设正式 OSS：暂缓；超出个人 v1 范围，需要额外账户、生命周期和生产配置。
4. 客户端转码压缩：拒绝；改变输入、耗时高且用户没有要求。

## Consequences

- 500 MiB 在协议上可行，内存可与文件大小解耦。
- 受北京区、临时上传限流、48 小时生命周期约束。
- 上传失败会消耗带宽，v1 不自动重传。
- Node multipart 实现必须经过专门的内存和 Windows 审核。
