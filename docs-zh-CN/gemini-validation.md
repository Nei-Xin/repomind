# Gemini CLI 原生接入验收记录

日期：2026-10-28。测试运行于用户指定的 Debian 服务器隔离目录 `/tmp/repomind-gemini`。

- Gemini CLI 0.66.0、Node.js 22.23.4；`repomind gemini setup/status` 通过。
- RepoMind 专项 7 项测试通过；Pi/Codex 专项 9 项通过。
- 全量回归：75 个测试文件、898 项通过、2 项 Windows 专项跳过。
- 使用临时本地 Gemini → OpenAI Chat Completions 协议转换器，实际上游调用用户指定的 `gpt-6.1-sol`；Key 未写入源码或产物，测试结束已删除。
- Gemini 真实 Hook 调用覆盖了工作区信任、BeforeAgent/BeforeModel/AfterModel/AfterAgent、文件编辑、任务提交和 SessionEnd。
- Gemini 自动保存的记忆被 Pi 在不读文件的情况下召回；审计库中的来源为 `gemini-hook`。

已确认的接口限制：Gemini 0.66 没有稳定回合 ID，也不提供成功 Shell 的退出码；输出文本中的 `Exit Code: 0` 不会产生验证证据。取消没有专用 Hook，未完成回合在下一次提问、恢复或尽力执行的 SessionEnd 清理。工作区必须在 Gemini 中信任，且 `hooksConfig.enabled` 不能关闭。
