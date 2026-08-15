# 测试与验证手册

## 原则

- 默认测试零网络、零费用、可重复。
- 先跑当前模块测试，再跑完整质量门。
- Live test 只有用户明确授权后运行。
- 缺少 key、fixture 或必要环境时，live 命令必须非零退出；不得“全部 skipped → green”。
- 每个真实请求保存 request id、状态、耗时和语义结果，但不保存 key、policy、OSS URL 或绝对路径。

## 已完成的协议基线

验证日期：2026-08-15。

验证对象：仓库外测试视频 `..\text\8月15日.mp4`，未复制进仓库。

实测文件：536,266 bytes，2.581 秒，MP4/H.264，内含 PCM s16le 音轨。

已知语义：画面为红色数字 `24`，音频朗读 `3.1415926`。

真实链路结果：

| 阶段                                  | 结果                                                        |
| ------------------------------------- | ----------------------------------------------------------- |
| `getPolicy(model=qwen3.5-omni-flash)` | HTTP 200，`max_file_size_mb=1024`，credential 有效期 300 秒 |
| multipart 临时上传                    | HTTP 200                                                    |
| HTTP Omni 推理                        | HTTP 200，`text/event-stream`                               |
| SSE                                   | 21 个数据 chunk 被聚合                                      |
| 模型回答                              | 同时返回 `画面数字：24` 与 `音频朗读：3.1415926`            |
| policy request id                     | `ef2c1786-7f4a-96a0-aab6-cde5adc224ea`                      |
| model request id                      | `chatcmpl-88ca6267-aac9-9ff0-853d-dc411eab945a`             |

该基线证明“临时上传 + Qwen3.5-Omni-Flash + SSE + 音视频联合理解”协议可行；不证明仓库实现已完成，也不覆盖大文件、Windows MCP Host 和故障路径。

## 测试层级

### 1. 单元测试

#### Config

- 默认模型准确为 `qwen3.5-omni-flash`。
- allowed roots 按平台 delimiter 解析、去重并 realpath。
- 缺 key、非法 URL、非法上限、非法 timeout/retry 快速失败。
- 错误中不出现环境变量值。

#### Media authorization

- HTTPS 和本地绝对路径正确分类。
- 拒绝相对路径、非 HTTPS scheme、URL credentials。
- allowed root containment 不受 sibling prefix 欺骗。
- MP4 magic、普通文件、空文件、500 MiB 边界。
- symlink/junction 内部目标允许、外部目标拒绝。
- 校验和上传共享同一 FileHandle。

#### Upload policy

- 正常 policy 解析。
- 缺字段、错误类型、非 HTTPS host、过期/负数值拒绝。
- 文件大于 `max_file_size_mb` 时 POST 调用次数为 0。
- policy 原始 secret 不进入异常 message。

#### Multipart streaming

- 字段名和值准确，`file` 最后。
- boundary 和 CRLF 正确。
- 随机对象名不包含原文件名。
- mock server 收到的文件 bytes 与输入 hash 相同。
- abort 后流与句柄关闭。
- 500 MiB mock 上传无整文件内存副本。

#### SSE

fixture 至少包含：

- 一个 event 一个 chunk；
- 一个 event 被拆成每字节一个 chunk；
- 多个 event 在同一 chunk；
- `\r\n`；
- 中文 UTF-8 跨块；
- role-only、empty delta、finish-only、usage-only；
- `[DONE]`；
- 非 JSON event；
- 中途 EOF；
- 正常结束但无文本。

#### Error mapping

- 401/403、429、502/503、timeout、network、parse、empty。
- canary API key、signature、OSS URL、本地路径不出现在 Agent message。
- 只有 429/502/503/首字节前网络错误进入有限重试。

### 2. Mock HTTP 集成

用现有 MSW 或本地 Node HTTP server 模拟：

```text
MCP handler
 -> authorize fixture
 -> GET policy
 -> streaming multipart POST
 -> POST chat/completions
 -> fragmented SSE
 -> plain text result
```

断言请求：

- policy 和推理使用完全相同 model id；
- 本地 `oss://` 推理有 `X-DashScope-OssResourceResolve: enable`；
- HTTPS 输入没有该 header，且没有 policy/upload 请求；
- payload 有 `stream:true`、`stream_options.include_usage:true`、`modalities:["text"]`；
- payload 无 `thinking_budget`；
- provider 失败时 MCP `isError:true`。

### 3. MCP 内存传输 E2E

复用现有 SDK `Client + InMemoryTransport`：

- 初始化 instructions 明确联合分析画面和声音。
- `listTools()` 恰好一个工具。
- schema 恰好 `video`、`question`。
- 默认 prompt 和 token 生效。
- 成功返回一个纯 text content。
- 所有稳定错误码能穿过 MCP 边界。

### 4. Live 验证

Live 测试必须与默认测试隔离。建议变量：

```text
LIVE=1
QWEN_LIVE_VIDEO=<small semantic AV fixture>
QWEN_LIVE_EXPECT_VISUAL=24
QWEN_LIVE_EXPECT_AUDIO=3.1415926
```

PowerShell 示例仅在用户已安全注入 key 并明确授权后执行：

```powershell
$env:LIVE = "1"
$env:QWEN_LIVE_VIDEO = "C:\path\to\av-proof.mp4"
$env:QWEN_LIVE_EXPECT_VISUAL = "24"
$env:QWEN_LIVE_EXPECT_AUDIO = "3.1415926"
npm run test:live
```

禁止在命令、文档或测试中写 key。Live test 必须断言两个语义 token 都出现，而非只断言回答非空。

## 大文件验证

### 50–100 MiB

目的：尽早发现 multipart、timeout、背压和 server 限制问题。通过标准：上传与推理成功，RSS 无明显随文件大小线性增长。

### 450–500 MiB

目的：目标容量发布验收。可由用户提供真实 7 分钟 MP4，或经用户同意使用 FFmpeg 生成。生成样例只作容量/内存测试，不替代小型语义 AV 测试：

```powershell
ffmpeg -f lavfi -i "testsrc2=size=1920x1080:rate=30" -f lavfi -i "sine=frequency=1000:sample_rate=48000" -t 420 -c:v libx264 -b:v 9M -minrate 9M -maxrate 9M -bufsize 18M -c:a aac -b:a 128k -pix_fmt yuv420p target-7m.mp4
```

生成前需确认磁盘空间；生成文件不得自动加入 git。

### 内存测量

- 上传前记录稳定 baseline RSS。
- 上传期间每 100 ms 采样 `process.memoryUsage().rss`。
- 报告 peak、delta、文件大小和 Node 版本。
- 设计目标：delta ≤128 MiB；发布硬上限：delta ≤192 MiB。
- 还需比较 50 MiB 与 500 MiB；若内存近似按文件大小增长，即使暂时低于硬上限也失败。

## Windows 验收矩阵

Gate 4 至少执行：

| 环境/场景              | 必需         |
| ---------------------- | ------------ |
| Windows 11 + Node 22   | 是           |
| 中文目录和文件名       | 是           |
| 路径含空格             | 是           |
| `C:\` 绝对路径         | 是           |
| allowed root 外文件    | 是，必须拒绝 |
| junction 越界          | 是，必须拒绝 |
| 500 MiB 流式上传       | 是           |
| 实际 MCP Host 调用     | 是           |
| Ctrl+C / Host 退出中止 | 是           |

Node 22/24 由 CI 做单元与 mock 支持；Bun/Windows exe 不属于 v1 验收。

## 完整质量门

依赖获批并安装后，每个 Review Gate 都跑：

```powershell
npm run typecheck
npm run lint
npm run format:check
npm test
npm run coverage
npm run build
npm audit --omit=dev
git diff --check
```

`npm audit` 的发现单独报告；不得为了绿灯擅自升级依赖。
