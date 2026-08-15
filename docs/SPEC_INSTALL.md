# Video MCP 安装规格

状态：已批准并实施。公开仓库：`JaylanJerry/analyze-video-mcp`。未发 npm。

本规格在 V2 之上，只改「别人怎么装」和「本地路径默许这次传入的文件」。不改 `analyze_video` 名称与字段。图片、独立音频后做。

完整产品行为仍以 [`SPEC_V2.md`](SPEC_V2.md) 为准；和本文件冲突时，以本文件的安装与目录规则为准。

---

## 1. 目标

在 Cursor、Claude Code、Codex 里加上这个 MCP，填好百炼 Key，就能分析这次对话带上的视频。

用户不必自己 `npm run build`，也不必先填视频目录。推到 GitHub 之后，用 `npx` 安装。

---

## 2. 给用户的安装

Host 配置只要求：

| 项                                                   | 必需   | 说明                                                                                   |
| ---------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `npx -y github:JaylanJerry/analyze-video-mcp#v0.4.0` | 是     | 默认钉发布标签。跟最新提交用 `#main`。不发 npm。                                       |
| Node.js                                              | 视轨道 | `#main` / 即将发布的 v0.5.0 需要 22+。稳定安装 `#v0.4.0` 以该标签当时说明为准（20+）。 |
| `DASHSCOPE_API_KEY`                                  | 是     | 用户自己的百炼 Key，不要提交                                                           |
| `QWEN_ALLOWED_ROOTS`                                 | 否     | 要收紧本地可读范围时再填                                                               |
| Base / Upload URL                                    | 否     | 默认北京区                                                                             |

模板：[`../examples/mcp.cursor.json`](../examples/mcp.cursor.json)、[`../examples/mcp.claude-code.json`](../examples/mcp.claude-code.json)、[`../examples/mcp.codex.toml`](../examples/mcp.codex.toml)。

本机开发仍可用 `node dist/index.js`。`text/*.key` 脚本不是产品安装方式。

---

## 3. 本地路径

工具不会扫描磁盘。它只读这次 `video` 参数里的那一条路径。

| 条件                                    | 行为                     |
| --------------------------------------- | ------------------------ |
| 未设 `QWEN_ALLOWED_ROOTS`，本地绝对 MP4 | 校验类型、大小后直接分析 |
| 已设允许根，路径在根内                  | 与 V2 相同               |
| 已设允许根，路径在根外或越界 junction   | `VIDEO_PATH_NOT_ALLOWED` |
| 相对路径、非 MP4、空文件、超上限        | 仍拒绝                   |

不把进程 cwd 当成默认允许根。Host 的当前目录对用户级 MCP 不可靠。

---

## 4. 问句

公开字段仍是 `question?`。默认句不变：`画面里发生了什么？音频说了什么？`

发给视频模型前仍包一层音视频约束。

给 Host Agent 的说明：

1. 用户说得具体，就尽量把原话写入 `question`。
2. 用户只说「分析一下」这类空话，先整理成具体的画面与声音问题再调用。可补切点、节奏、配音是否统一、声画是否对上、哪些好、哪些要改。
3. 不要编造视频里没有的内容；没有可用声音要写明。

---

## 5. 不做

- 现在不加图片、独立音频 Tool。
- 不发 npm、不推送，除非用户另说。
- 不加生产依赖、不做 GUI、不测速、不自动重传。
- 不把 Key 写进仓库或 Tool。

---

## 6. 完成标准

- 模板用 `npx`，默认钉 `#v0.4.0`；跟最新提交用 `#main`。普通人只填 Key 就能分析本地绝对 MP4。建议填写 `QWEN_ALLOWED_ROOTS`。
- 根 package 声明运行时依赖，用 `files` 白名单带上完整 `dist`，并用 `.npmignore` 避免 `dist/` 被 gitignore 滤掉。
- `npm run test:pack-install` 对 `npm pack` 产物做 initialize 与 `listTools`，且只有 `analyze_video`。
- CI 在全新 npm cache 上对 `npx github:<仓库>#<SHA>` 再做一次握手。
- 设置了 `QWEN_ALLOWED_ROOTS` 时，根外路径仍拒绝。
- Tool 描述要求转发或整理 `question`。
- 质量门保持现有门槛。
- 未发 npm。
