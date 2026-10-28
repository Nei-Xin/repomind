# Gemini CLI 原生接入

RepoMind 通过 Gemini CLI 原生项目 Hooks 接入。进入 Git 仓库后执行一次：

```sh
repomind init
repomind gemini setup --repo .
repomind gemini status --repo .
```

之后照常运行 `gemini`。`BeforeAgent` 自动召回相关仓库记忆；`BeforeTool`、`AfterTool` 记录活动；`AfterAgent` 在模型回合结束后保存任务。`BeforeModel` 与 `AfterModel` 会跨流式模型分片记录最终模型状态。

Gemini 首次询问时必须信任工作区，并在 `/hooks` 中检查 RepoMind 定义。未信任工作区时 Gemini 会关闭项目设置和项目 Hooks。保持 `hooksConfig.enabled` 为 true，不要把 `repomind-*` 加入 `hooksConfig.disabled`。setup 会保留已有设置和用户 Hooks。

首个验证版本为 **Gemini CLI 0.66.0**。`repomind doctor gemini` 检查仓库、安装、版本和 Bridge。模型提供商与凭据仍由 Gemini 自己配置，RepoMind 不修改模型路由。

Gemini 0.66 没有稳定的回合 ID，也不会为成功 Shell 返回退出码。RepoMind 在私有 SQLite 状态文件中只保存哈希、时间戳和关联 ID，用于拒绝迟到或歧义事件。输出文本中的“Exit Code: 0”不会被当成验证证据；没有结构化退出码的任务会保持 partial。Gemini 没有专用取消 Hook，未完成任务会在下一次提问、恢复会话或尽力执行的 SessionEnd 中清理。

模型中转服务必须支持 Gemini 协议。如果测试中转只接受 OpenAI 请求，应在临时测试环境使用外部协议转换器；RepoMind 本身不代理或改写模型流量。
