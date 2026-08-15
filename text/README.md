# 本地 fixture（不入库）

此目录只放本机 live 测试材料，根目录 `.gitignore` 会忽略其中的媒体和密钥。

- 小型语义视频：`8月15日.mp4`（画面红色数字 `24`，音频 `3.1415926`）
- API Key 只允许出现在调用进程的环境变量 `DASHSCOPE_API_KEY` 中
- 不要把 `*.key`、`.env` 或视频复制进 `qwen-omni-mcp/`
