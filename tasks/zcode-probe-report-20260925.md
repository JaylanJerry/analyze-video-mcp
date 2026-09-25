# ZCode 会话三文件探针报告（2026-09-25）

**用途：** 把本会话（ZCode GUI）对三个媒体文件的真实 `analyze_media` 调用结果完整交接给原窗口修复用。本会话**没有改动任何源码**，只更新了 §7 的文档；所有结论按「已验证 / 未验证 / 需新授权」区分。调用均为用户明确要求后发起，未做自动重试。

**环境：** ZCode GUI 会话；MCP server `analyze_video_mcp` → `node dist/index.js`（cwd=仓库根，`MEDIA_ALLOW_ANY_LOCAL_FILE=on`、`MEDIA_ALLOWED_ROOTS` 含用户媒体目录、本会话未覆盖 `QWEN_MODEL` ⇒ 默认 `qwen3.8-omni-flash`、`timeoutMs=3600000`）。`dist/server.js` 只注册 `analyze_media`，与当前源码一致。本会话未查服务端 stderr、未核对账单。

## 1. 一览

| #   | 文件                        | 载体                | 结果                             | 关键字段                                                                                                                           | usage（prompt/completion/total） |
| --- | --------------------------- | ------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | `live-av.mov`（%TEMP%）     | 本地 MOV，3 秒      | **成功**                         | `ok=true`、`kind=video`、`container=mov`、`duration_seconds=3`、`audio_track_present=true`、`upload_reused=true`                   | 904 / 3212 / 4116                |
| 2   | `1_merged.mp4`（用户私片）  | 本地 MP4，889.95 秒 | **被服务商内容检查拒绝**         | `code=PROVIDER_CONTENT_REJECTED`、`stage=analyzing`、`http_status=400`、`retryable=false`、`request_id`、`inspection_side=unknown` | 无（无用量返回）                 |
| 3   | `probe-tones.mp3`（%TEMP%） | 本地 MP3，9.04 秒   | **成功，但模型段数与时间点错误** | `ok=true`、`kind=audio`、`container=mp3`、`duration_seconds=9.038`、`upload_reused=true`                                           | 274 / 1522 / 1796                |

## 2. 文件 1：`live-av.mov` —— 成功，ZCode 宿主 MOV 路径打通

**输入事实（本地核对）**：31,039 bytes；顶层 box `ftyp(20) wide(8) mdat(27647) moov(3364)`；`ftyp` brand `qt`；`mdat` 载荷 27,639 bytes，SHA-256 `4F8F8FC5405ACF5871C0EBAD088E5E6A…`。

**同一性核对（关键）**：与仓库公开夹具 `test/fixtures/live-av.mp4` 的 `mdat` 载荷**逐字节相同**（同 27,639 bytes、同 SHA-256），仅容器头不同（MP4 为 `ftyp isom` + `free`）。方法：node 遍历顶层 box，对 `mdat` 载荷做 SHA-256。⇒ 本次是同一码流的画面 + 内嵌声音真实读取，不是巧合答对。

**返回**：`ok=true`；`media={kind:video, container:mov, duration_seconds:3, audio_track_present:true}`；`request={provider:dashscope, model:qwen3.8-omni-flash, upload_reused:true}`；`limitations` 一条（本机未逐帧核验，本地探测不证明模型听到）；`usage=904/3212/4116`。

**模型回答要点**：画面是白底、居中黑色衬线体数字 `24`，三帧（0.0 / 1.0 / 2.0 秒）内容一致、无其它元素；声音是朗读数字的语音，转写 `3.1415926`；明确声明两条信息都获取到了，且两者不一致时如实分开报告。与夹具真值（README：on-screen `24`、spoken `3.1415926`）**一致**。

**观察（不算证据）**：模型自述其声音判断依据是“随视频提供的音频转写文本”。服务端只发 `video_url` 原始块，没有额外转写步骤，不能据此认为服务端做了 ASR，也不能据此认为模型一定听到了原始声波。

**记录局限**：成功路径的 `structuredContent` 不含 `request_id`（`src/server.ts` 只在错误对象与 stderr 诊断行输出该字段），故本项没有可记录的 request id。

**它关掉的未验证项**：ZCode GUI 新会话一次确认、ZCode 宿主 MOV 输入、以及“附件以本地路径进入会话”的拖入路径（宿主因当前模型不支持视频输入而只把本地路径交给 Agent，会话显示 `Media omitted from provider request`；MCP 直接读该路径成功）。

## 3. 文件 2：`1_merged.mp4` —— 内容检查拒绝（新证据，勿重复上传）

**输入事实**：112,544,441 bytes；889.95 秒；HEVC `hvc1` 1280×720 + AAC（`ffprobe` `codec_tag_string=hvc1`）。本地门禁先放行，失败发生在服务商推理阶段 ⇒ 拦截来自服务商，不是本机。

**Agent 可见错误全量字段**：

```json
{
  "ok": false,
  "code": "PROVIDER_CONTENT_REJECTED",
  "stage": "analyzing",
  "retryable": false,
  "http_status": 400,
  "request_id": "41ba2c43-28b3-95b2-8dfd-ce5655b61ab4",
  "diagnostics": {
    "parse_reason": "provider_error",
    "error_code": "data_inspection_failed",
    "inspection_side": "unknown"
  }
}
```

**形态归属（代码核对）**：`src/bailian.ts:253-267` 的 `!res.ok` 分支 → `mapProviderError`（`src/provider-error.ts:62-84`）。diagnostics 有 `http_status`、无 `received_sse_events` ⇒ 这是 **HTTP 400 错误正文**形态，不是 SSE 错误事件形态。

**为什么重要**：ADR 0023 的「验证边界」此前记录修复后的真实样本都在**首个 SSE 事件**里，而正文形态只有 mock 覆盖（修复前正文被直接丢弃）。本次是该形态的**首个真实现场**。带回的 Request ID 是 UUID 形态、不是 `chatcmpl-…` 补全 ID ⇒ 修正后的来源规则在正文路径上生效；但它来自响应头还是 JSON 字段，无法从 Agent 可见结果区分，**SSE 路径在修正后仍未复验**。

**行为核对**：`retryable=false`，未自动重试（按 Tool 提示与 ADR 0023 也没有人工重试同一媒体）；无 `usage`、无 SSE 事件 ⇒ 没有 token 计量证据，是否计费未知。请求已进入分析阶段 ⇒ 上传已完成或命中上传缓存；对象会在百炼临时存储保留约 48 小时（见 `AGENTS.md`）。Agent 可见错误文本中无路径、`oss://` 或密钥。

**关联疑点（未证实，勿当结论）**：同一部 890 秒源视频派生的“无视频轨音频-only MP4”当年两次得到**裸 400**（无识别错误码，见 `AGENTS.md` 1c），当时实现丢弃了正文，真实原因不可回溯；既然同源源文件如今明确返回 `data_inspection_failed`，内容检查是那些 400 的候选原因之一。**要分辨只能在获得新授权后重跑那个音频-only 文件**——本会话没有做。

## 4. 文件 3：`probe-tones.mp3` —— 成功，但段数与切换点错误

**输入事实**：72,559 bytes；SHA-256 `f47b19d9c0c4eb01a0e880c6a1b3c974dbad985282f6e8002cc1b0a47c4545cb`；单声道 44.1 kHz；`ffprobe` 9.0 秒，工具报 `duration_seconds=9.038367`；`bit_rate≈64,496`。

**同一性论证**：`docs/PROVIDER_PROTOCOL.md` §3b 记录的样本为「9.04 秒、**440 / 880 / 1760 Hz** 三段递增音调、**72,559 B**」——大小一致；本次 `upload_reused=true`，而缓存键是 `路径|大小|mtime`（`src/media.ts:98-101` + `src/upload-cache.ts:48-58`，**不是内容哈希**）⇒ 该路径/大小/mtime 先前已上传过。两者合计高度可能即同一样本，但不能据此断言逐字节同一。

**模型回答要点（原话）**：纯音调、像电子生成的测试信号；**一共 4 段**；各段依次升高；切换点大约在 `00:02`、`00:05`、`00:08`；各段均为单一正弦音、无明显泛音或噪声；**没有语音**；不确定具体频率数值与毫秒级切换位置。

**本地独立测量（真值）**：

```bash
ffprobe -v error -f lavfi -i "amovie=probe-tones.mp3,aspectralstats=measure=centroid:win_size=8192" \
  -show_entries frame=pts_time -show_entries frame_tags=lavfi.aspectralstats.1.centroid -of csv
```

97 帧、跨度 8.94 秒。结果：**3 个平台区** —— `461 / 900 / 1778 Hz`，各约 **2.79 秒**；两处过渡帧位于 ≈2.88–3.07 秒与 ≈5.76–5.95 秒；末帧 1786.93 属尾部。⇒ **3 段**，切换点 **≈2.9 秒**与 **≈5.9 秒**。质心略高于基频（纯音的 centroid ≈ 基频 + 窗泄漏），与文档记录的 440 / 880 / 1760 Hz 吻合。

**逐项对照**：

| 维度         | 模型                 | 本地实测            | 判定 |
| ------------ | -------------------- | ------------------- | ---- |
| 模态/音色    | 纯正弦音、无泛音噪声 | 三平台区，纯音      | ✅   |
| 有无语音     | 无语音               | 无语音结构          | ✅   |
| 顺序         | 依次升高             | 461 → 900 → 1778 Hz | ✅   |
| **段数**     | **4 段**             | **3 段**            | ❌   |
| **切换时间** | **2 / 5 / 8 秒**     | **≈2.9 / ≈5.9 秒**  | ❌   |

**结论与影响**：模型确实读到了音频（模态、音色、顺序都要真听才对），**但它的段数与时间戳不可靠**；两个切换点各早约 0.9 秒，并多报了一个 8 秒的切换。**同一文件先前两次答“三段”并被记入文档为“正确”，本次答“4 段” ⇒ 先前结论只是当时的单次结果，不能当作模型的稳定行为。** 这与 `tasks/todo-next-major-media-gateway.md` 里“模型静默忽略音频的防误报”直接相关：服务端既不能把“答出了音频内容”当作已核验事实，也不能拿模型报的段数/时间点当真值去纠正或过滤。

**它关掉的未验证项**：ZCode 宿主 MP3 调用。

## 5. 复现材料

三次调用的 `media` 与 `prompt`（逐字）：

1. `live-av.mov`：
   > 请同时分析这段视频的画面与内嵌声音，分三部分回答：1) 画面：出现了什么（场景、颜色、物体、人物或动作）？如果画面上有任何可见文字或数字，请照抄。2) 声音：音频里是什么——说话、音乐、纯音调、噪声还是静音？若是语音请转写；若是音调，描述其高低与变化（例如是否有连续的上行/下行音阶、共几段）。3) 依据：分别说明你判断画面内容和声音内容的依据，并明确指出这两条信息是否都真的获取到了；如果只拿到了其中一条，请直说。
2. `1_merged.mp4`：
   > 请同时分析这段视频的画面与内嵌声音，分四部分回答：1) 内容概括：整段视频讲的是什么，按时间顺序列出关键节点（尽量给大致时间点）。2) 画面：主要场景、人物或角色、动作与镜头变化；如果画面有字幕、标题或其他可见文字，请照抄关键部分。3) 声音：有人声吗（说话、对白或旁白）？请转写要点；有音乐吗（类型、情绪）？有环境音或音效吗？如果某段是静音，请直接说明是哪段。4) 依据与不确定处：分别说明你判断画面内容和声音内容的依据；明确说明这两条信息是否都真的获取到了，以及你不能确认的部分是什么。不要编造你没有实际观察到的细节。
3. `probe-tones.mp3`：
   > 请分析这段音频（只处理声音，分四部分回答）：1) 音频里是什么——纯音调、音乐、语音、噪声还是静音？2) 如果有音调：一共有几段？各段的相对高低如何（例如依次升高、依次降低、保持不变）？大约在什么时间点发生切换？各段的音色是单一正弦音还是包含多个音？3) 如果有语音，请转写要点。4) 依据与不确定处：说明你判断的依据；明确哪些部分你不能确认。不要编造你没有实际观察到的细节。

本地测量方法与边界：`ffprobe` 只是本机读元数据/频谱统计，不联网、不改动媒体、不经 MCP 服务端；服务端本身不做解码或转码（`AGENTS.md` 明令）。盒级比对同样是本机只读，逻辑为：按 32 位大端长度遍历顶层 box，对 `mdat` 载荷做 SHA-256 后比较。

## 6. 建议原窗口处理的事项

1. **防误报设计**：把“模型可能答对模态但数字错误”纳入方案（本次已把证据写入 `AGENTS.md` 1d、`docs/PROVIDER_PROTOCOL.md` §3b 结论段、tracker D4）。是否调整 `limitations` 文案或增加任何本地核验，需要决定——本会话未改任何源码。
2. **内容检查**：正文形态已有真实现场；SSE 形态修复后未复验；`inspection_side` 仍无真实判定（只有 `unknown`）。
3. **音频-only 400 疑点**：需新授权才能分辨（重跑那个音频-only 文件）。
4. **文档里的过期数字**：tracker 首部门禁行仍写 `npm test（258 passed / 1 skipped / 16 files）`，而本次在 HEAD `43584e1` 上实测为 **264 passed / 1 skipped / 17 files**。该行未改，属既有记录。
5. **未验证清单现状**：Codex 新会话拖入、Codex 宿主 MOV/MP3 仍未验收；ZCode 侧（GUI 会话 / 拖入 / MOV / MP3）本次已通过，不能反向推定 Codex 侧。
6. **提交**：本会话共 **6 个已跟踪文档改动 + 本报告（新增文件）未提交**；门禁全绿（`typecheck` / `lint` / `format:check` / `test` 264+1 / `build`）。

## 7. 本会话改动的文件（全部未提交）

- `tasks/zcode-probe-report-20260925.md`：本报告（新增）。
- `AGENTS.md`：1c 补“音频-only 裸 400 可能与内容检查同因”的候选说明（标注不可回溯）；1d 补两次宿主通过的事实与“听到也可能报错数字”的结论。
- `DEVELOPMENT_HANDOFF.md`：宿主状态行、内容检查段追加修复后现场、“仍属未验证”列表更新。
- `docs/PROVIDER_PROTOCOL.md`：§3b 追加 MP3 第三次调用与本地实测对照、仍未验证清单、模型能力结论补“计数/时间戳不可信”、音频-only 负例补交叉引用。
- `docs/decisions/0023-provider-inspection-errors.md`：验证边界追加正文形态真实现场，并修正“修正后来源未再验证”的表述。
- `tasks/deepseek-next-major-handoff.md`：状态行、剩余事项（含反例可作防误报素材）、可转交任务提示。
- `tasks/todo-next-major-media-gateway.md`：D4 三条新证据（ZCode GUI MOV、内容检查拒绝、宿主 MP3 反例）、表内“三段递增音调描述正确”的适用范围更正、A-P 段同步更正、仍未做/状态行/完成标准更新、样本处理更正（`probe-tones.mp3` 未被回收）。

## 8. 未做的事与局限

- 未改源码；未跑 `LIVE=1` 测试；未查账单；未查服务端 stderr；未重试被拒媒体。
- 未逐字节证明 `probe-tones.mp3` 与 §3b 样本同一（缓存键非内容哈希，只有大小/时长/缓存命中三重旁证）。
- “正确/错误”判定只覆盖本地可验证的维度（模态、顺序、段数、切换点）；模型回答的其它措辞未逐条核验。
