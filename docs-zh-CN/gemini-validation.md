# Gemini CLI 原生接入验收记录

## 新服务器收尾验收

日期：2026-10-28。环境为用户更换后的 Debian 13.7 x86_64 服务器，
测试目录 `/home/debian/repomind-validation`，Node.js 22.23.4、Gemini CLI 0.66.0。

本次以 `npm pack` 生成安装包，在隔离 npm 全局前缀下安装，再通过
`global/bin/repomind` 符号链接执行 setup 和服务管理。模型仍使用用户指定的
`gpt-6.1-sol`；临时 loopback 转换器将 Gemini 请求转换为真实上游请求。
转换器不属于 RepoMind 产品功能，未修改 Gemini 客户端源码。

### 修复与检查

- Gemini 模型 Hook 按实际包目录定位，支持 npm 全局入口与符号链接。
- Bridge 生命周期使用规范化入口路径识别同一安装，同时保留实际进程命令核对。
  修复自动恢复后全局 `services stop` 误判非托管服务的问题；其他安装的进程仍被拒绝停止。
- 完成、放弃或替换回合时清理事件去重记录，保留时间戳和未返回工具关联，
  防止清理后重放或迟到结果混入新任务。会话 SQLite 文件保留，不做自动过期删除。
- build、typecheck 通过；全量回归 75 个文件、901 项通过、2 项 Windows 专项跳过。
  Gemini 专项 9 项、Pi/Codex 专项 9 项、服务管理专项 3 项均通过。

### 原生 Gemini TUI 实测

| 场景 | 结果 |
| --- | --- |
| 全局安装、重复 setup | 模型 Hook 路径有效，setup 幂等，doctor ready |
| 工作区信任 | 通过 Gemini 原生信任界面批准隔离测试仓库，随后 Hooks 正常执行 |
| 首轮自动召回 | 不调用工具、不读文件，返回只存在于记忆库的标记 `WILLOW-9306` |
| 同会话多轮 | 两轮分别 committed，绑定同一 Gemini 会话 ID |
| 取消 Shell | 实际执行 `sleep 45` 时按 Escape，旧任务在下一次提问时 abandoned |
| 取消后继续 | 下一轮自动召回并 committed；取消任务没有完成时的测试/命令证据 |
| 强杀 Bridge | 对隔离测试 Bridge 发送 SIGKILL，下一轮自动恢复到新 PID 并 committed |
| 原生恢复会话 | 退出后通过 `gemini --resume <session-id>` 恢复，沿用原 ID 并正常完成下一轮 |
| 恢复后的服务管理 | 全局 doctor 识别 Bridge 为 owned，`services stop` 返回 stopped |
| 状态清理 | 最终版本的已关闭测试会话 receipts 为 0，防重放状态文件保留 |

最终一轮共 6 个任务：5 个 committed、1 个 abandoned。实际客户端已退出，
测试 Bridge 与临时转换器已停止，临时 API Key 文件已删除。
服务器保留 `tui-validation.json`、`closeout-audit.json`、`global-setup-final.json`、
`doctor-after-recovery.json`、`stop-final.json` 和最终构建/测试日志供复核。

本次覆盖 Linux 本地 Gemini CLI；Windows 原生运行和 Gemini 官方模型端点未实测。
临时转换器用真实上游完整响应生成 SSE，未验证上游逐 token 流式延迟或断线行为。

## 首次接入验收（原服务器）

日期：2026-10-28。测试运行于用户指定的 Debian 服务器隔离目录 `/tmp/repomind-gemini`。

- Gemini CLI 0.66.0、Node.js 22.23.4；`repomind gemini setup/status` 通过。
- RepoMind 专项 7 项测试通过；Pi/Codex 专项 9 项通过。
- 全量回归：75 个测试文件、898 项通过、2 项 Windows 专项跳过。
- 使用临时本地 Gemini → OpenAI Chat Completions 协议转换器，实际上游调用用户指定的 `gpt-6.1-sol`；Key 未写入源码或产物，测试结束已删除。
- Gemini 真实 Hook 调用覆盖了工作区信任、BeforeAgent/BeforeModel/AfterModel/AfterAgent、文件编辑、任务提交和 SessionEnd。
- Gemini 自动保存的记忆被 Pi 在不读文件的情况下召回；审计库中的来源为 `gemini-hook`。

已确认的接口限制：Gemini 0.66 没有稳定回合 ID，也不提供成功 Shell 的退出码；输出文本中的 `Exit Code: 0` 不会产生验证证据。取消没有专用 Hook，未完成回合在下一次提问、恢复或尽力执行的 SessionEnd 清理。工作区必须在 Gemini 中信任，且 `hooksConfig.enabled` 不能关闭。
