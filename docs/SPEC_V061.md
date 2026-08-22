# v0.6.1：宿主配置同源与可验证证据热修

状态：已实施（用户 2026-08-22 综合优化需求，第一批 P0）。不发 npm、不推 tag，除非另说。

结论：在 `0.6.0` 上先修宿主 Key 继承、`doctor` 与运行时不同源、以及把推断写成实测 / 无法证明的绝对审核结论。不在本版增加新 Tool、不引入 FFmpeg。纯音频与交叉审核见 [`SPEC_V07.md`](SPEC_V07.md)。

## 1. 保持不变

- 唯一 Tool：`analyze_video(video, question?)`。不得增加 `api_key`、`model`、`start_seconds`、`max_tokens` 或 CLI `--api-key`（会进进程列表）。
- 不增加生产依赖。不抽帧、不取音频、不做响度/真峰值测量。
- Agent 错误仍禁止路径、Key、`oss://`、policy、signature。变量**名**可以出现在 `CONFIG_MISSING` 中。
- npm 包名不变。模板钉 `analyze-video-mcp@0.6.1`。示例 Host 键 `analyze_video_mcp`（见 [ADR 0017](decisions/0017-host-config-key-analyze-video-mcp.md)）。不改 Tool 名 `analyze_video`，不改默认 `initialize.name`。

## 2. P0-1 配置源与 doctor 同源

`doctor` 与 `loadConfig()` / `analyze_video` 必须走同一解析模块。

优先级（高 → 低）：

```text
--config <file> 或 QWEN_CONFIG_FILE 指向的 env 文件
> process.env（含 MCP server 配置里的 env；Node 无法区分二者）
> 用户配置文件 ~/.analyze-video-mcp/config.env
> Windows 用户级环境变量（HKCU / User scope）
```

不把 cwd `.env` 当作配置源（保持 0.5 起的约定）。不把 Key 做成 Tool 字段。

启动与 `--doctor --json` 记录来源，只记布尔与枚举，永不记值：

```json
{
  "api_key": { "configured": true, "source": "process.env" }
}
```

`source` 枚举：`cli_file` | `process.env` | `user_file` | `windows_user_env` | `unset`。

`CONFIG_MISSING` 的 Agent 文本与 `structuredContent` 必须含缺失变量名和修复建议，例如：

```json
{
  "ok": false,
  "code": "CONFIG_MISSING",
  "stage": "received",
  "retryable": false,
  "missing": ["DASHSCOPE_API_KEY"],
  "suggestion": "请在 MCP server 的 env 配置或宿主进程环境中提供该变量",
  "error": {
    "code": "CONFIG_MISSING",
    "message": "缺少 DASHSCOPE_API_KEY",
    "missing": ["DASHSCOPE_API_KEY"],
    "suggestion": "请在 MCP server 的 env 配置或宿主进程环境中提供该变量"
  }
}
```

Windows 集成测试（可用注入的 lookup，不写真实 HKCU）：系统/用户环境存在但子进程未继承、宿主显式 `env`、`--config`、中文路径、路径含空格、stdio 启动。

## 3. P0-2 证据类型

观察 `evidence`：

```text
seen | heard | measured | inferred | cross_validated | uncertain
```

- `seen`：画面像素可直接确认。身份、职业、关系、地点专名不得仅凭服装或队形写入 `seen`。
- `heard`：音轨里实际可听。
- `measured`：本版没有确定性测量器；模型若标 `measured`，降为 `inferred`。
- `inferred`：身份、关系、主题、原因。
- `cross_validated`：须同时有画面与声音观察；否则降为 `inferred`。
- `uncertain`：吃不准。

人物身份证据不足时进入 `uncertainties`，不得用确定语气。观察带 `confidence`（0–1，缺省 0.5）和时间码。`heard`/`seen` 仍不得带「可能/似乎」。

## 4. P0-3 禁止无证明的绝对结论

本版不做 OCR、字幕轨解析或逐条对齐。因此 `subtitle_audit.complete_verification` 恒为 `false`，`mode` 为 `sampled`。

禁止（出现则纠错一次，仍在则改写）：全部正确、完全同步、没有任何错误、逐帧确认、逐段核对、所有对白都准确、不存在漏句，以及同义「完整字幕审核通过」。

每次成功调用附带 `coverage` 与 `subtitle_audit`。覆盖策略写 `sampled_multimodal`；`ocr_performed: false`。不得把抽样理解写成逐帧观看。

## 5. 明确不做（0.7.0）

- 新 Tool：`analyze_audio`、`audit_media`
- FFmpeg / LUFS / True Peak / 静音削波测量
- 字幕 OCR 与逐条对齐
- 长任务可查询状态机、隐私模式、分析正文缓存

## 6. 测试

- Key：process.env、`--config`、用户文件、Windows user env 注入、缺失、doctor 与 loadConfig 同源。
- 子进程不继承父进程 Key 时 `CONFIG_MISSING`；显式 env 或 `--config` 可恢复。
- 中文路径、路径空格的 `--config`。
- 人群/`士兵`：`seen` 不得保留军人身份。
- 绝对结论：sampled 模式不得输出「所有字幕完全正确」。
- 日志与错误无 Key 值。

## 7. 发布卫生

版本 `0.6.1`。不补打 `v0.5.1` / `v0.5.2` / `v0.6.0`。本版发布仍须另授权 tag。

## 8. 完成标准

- `doctor` 与 `analyze_video` 同一解析器。
- 缺 Key 时错误能指出 `DASHSCOPE_API_KEY`。
- 观察含证据类型与置信度；身份词不得停在 `seen`/`heard`。
- 成功结果披露抽样覆盖；未完整验证时不得声称全部字幕正确。
- 质量门全绿。不默认 `LIVE=1`。不本机 publish。
