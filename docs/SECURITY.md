# 本地视频安全边界

## 目标

Agent 可以主动调用 MCP。恶意提示或错误推理可能诱导它读取本机文件，因此“扩展名是 MP4”不等于用户授权。未设置允许根时，服务器只读这次传入的绝对路径，不扫描磁盘；设置 `QWEN_ALLOWED_ROOTS` 后仍按根目录 containment 拒绝根外文件。

## 威胁模型

需要防御：

- Agent 请求上传允许根目录之外的私人视频；
- `..`、大小写、Unicode、短路径等路径绕过；
- symlink 或 Windows junction 从允许根跳到外部；
- 先检查 A、上传时路径已被换成 B 的 TOCTOU；
- 伪装扩展名、目录、设备、管道或空文件；
- 错误和日志泄露密钥、临时凭证、OSS URL 或绝对路径；
- 大文件触发内存耗尽；
- HTTP URL 降级或非预期 scheme。

不承诺完全防御：

- 已控制当前 Windows 用户、能修改进程内存或调试进程的攻击者；
- DashScope 服务端自身安全事件；
- 用户主动允许并传入的合法视频中的隐私内容。

## Allowed roots

配置：

```text
QWEN_ALLOWED_ROOTS=C:\Users\user\Videos;D:\Project\Media
```

使用 Node `path.delimiter` 分隔。规则：

- 未配置时，允许这次传入的本地绝对 MP4；HTTPS URL 不受影响。
- 已配置时，根外本地路径拒绝。
- 每个 root 必须为绝对路径、启动时存在且是目录。
- 启动时对 root 做 `realpath()` 并保存规范结果。
- 输入本地路径必须为绝对路径；不根据 cwd 猜测相对路径。
- containment 使用 `path.relative(root, candidate)`：结果不得为空目录外跳、不得以 `..` 开头、不得是绝对路径。不能用字符串 `startsWith()`。
- Windows 比较使用平台规范化后的真实路径，并加入大小写、UNC、盘符和 junction 测试。

## 授权与打开顺序

推荐顺序：

```text
validate absolute path and .mp4 extension
  -> realpath(requested)
  -> containment against real allowed roots
  -> stat identity snapshot
  -> open real path read-only
  -> fstat same handle: regular file, size, identity
  -> realpath + stat recheck
  -> read small header from same handle
  -> duration probe from same handle (box header + seek; not a full-file scan)
  -> upload from same handle
  -> close in finally
```

要求：

- pre-stat 与 fstat 可用时比较 `dev`、`ino`、size 和文件类型。
- 打开后再次解析路径并比较，发现变化立即拒绝。
- symlink/junction 最终目标位于 allowed root 内可以接受；最终目标越界必须拒绝。
- MP4 验证至少检查 ISO BMFF `ftyp` box；只读取固定小块，不推进上传流的起始位置或在上传前重置到 0。
- 本地时长探测必须用同一 FileHandle 的定位读：解析 32-bit size 与 64-bit largesize，以及 `mvhd` version 0/1。大于 3600 秒拒绝（`VIDEO_TOO_LONG`）；正好 3600 允许。不得为找 `mvhd` 顺序读完整文件，也不得引入 ffprobe。
- 大小同时满足：大于 0、≤用户配置上限（默认且硬顶 1024 MiB）、≤动态 policy 上限。
- 上传必须使用这个句柄；不得通过字符串路径重新 `createReadStream(path)`。

Node/Windows 无法提供完全可移植的 `openat + O_NOFOLLOW` 等价保证，因此同账户主动竞态仍是残余风险。v1 通过重复 realpath、身份比较和同句柄上传降低风险；Gate 3 必须在审计报告中明确这一点，不能宣称“完全无 TOCTOU”。

## URL 输入

- 只允许 `https:`。
- URL 必须能由标准 `URL` 解析，且不得包含用户名/密码。
- 拒绝 localhost 字面量和明显的 loopback/private IP 字面量；v1 不自行 DNS 解析，也不下载 URL。
- Provider 端 URL 抓取仍由 DashScope 安全边界控制，这是已记录的残余风险。
- URL query 不写日志。

## 时长探测残余

官方内容分析单视频上限 1 小时。本产品只对**本地 MP4**做轻量 `mvhd` probe；HTTPS 不下载、不探测。下列情况时长视为 unknown，**放行**（可能把超长文件交给 Provider）：

- fragmented MP4 / fMP4：时长在 `moof`/`tfdt` 里，`moov/mvhd` 可能缺失、为 0，或只覆盖初始化段；
- malformed box、非法 size、`timescale == 0`、探测字节或 box 数量触顶；
- `moov` 在超大 `mdat` 之后且 box 链无法安全跳过时。

这是有意残余，避免误杀合法 fMP4。未知时长不得报 `VIDEO_TOO_LONG`。

## 最小披露

- OSS 对象 key 使用随机 UUID，不包含原文件名。
- multipart `filename` 使用固定安全名 `video.mp4`。
- Agent 错误只包含稳定错误码和通用说明。
- stderr 中本地文件只记 `size_bytes`，必要时记不可逆短 hash，不记绝对路径。
- API Key 不做“首尾脱敏展示”；只允许布尔状态 `configured`，且不需要成为 Agent Tool。
- policy 所有 credential 字段为 secret 等级，不得持久化。

## stdout 与日志

- stdout 仅 MCP JSON-RPC。
- 诊断写 stderr 或 MCP logging。
- 日志对象必须由白名单字段构造，不能直接序列化 error detail、Request、Response、config 或 policy。
- 测试必须用 canary 值断言 Agent 结果与 stderr formatter 均不泄露敏感字段。

## 大文件拒绝服务

- 在网络传输前检查本地文件大小。
- policy 不足时不上传任何字节。
- 所有网络阶段都有 timeout 和 AbortSignal。
- 流必须尊重背压；禁止整文件缓冲。
- v1 一次进程只允许一个活跃视频任务；第二个调用快速返回 `VIDEO_ANALYSIS_BUSY`，不排队、不读取文件。

## 密钥操作

- 只读取进程环境变量 `DASHSCOPE_API_KEY`。
- 不读取仓库外的 `.key`、`.env` 或用户文档文件。
- 不在测试命令行参数中放 key，避免 shell history 和进程列表泄露。
- Live test 必须由用户在外部注入环境变量并明确授权。
- 发现密钥进入 diff、日志或 fixture 时立即停止，移除并通知用户轮换。

## 安全验收用例

至少包含：

- allowed root 内正常中文 MP4；
- sibling-prefix 绕过，如 root `C:\Media` 与目标 `C:\Media-private`；
- `..` 跳出；
- 允许根内 symlink/junction 指向外部；
- symlink/junction 指向允许根内部；
- 检查后替换路径的可控竞态测试；
- `.mp4` 文本文件、目录、空文件、超大文件；
- `file://`、`data:`、`http://`、带凭据 HTTPS；
- provider 错误含 canary secret、policy、OSS URL、绝对路径时的脱敏；
- 500 MiB 流式上传内存上限。
