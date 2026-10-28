# Codex 原生接入

支持本地 Codex 项目 Hooks，首个验证版本为 **Codex CLI 0.165.0**。
RepoMind 需要 Node.js 22.5+。

```bash
repomind codex setup --repo /path/to/repository
repomind doctor codex --repo /path/to/repository
cd /path/to/repository
codex
```

setup 初始化记忆、将 RepoMind 处理器合并到 `.codex/hooks.json` 并启动本机 Bridge。
保留其他 Hooks 和模型配置；重复安装不会重复添加，移动 RepoMind 后重新运行即可修复路径。

**在 Codex 中信任项目，并通过 `/hooks` 审阅和信任 RepoMind Hooks。**
修改 Hook 定义后需要重新审阅；RepoMind 不替你修改信任数据库或关闭检查。
安装后重启已运行的 Codex 会话。status 的 `ready` 表示安装、版本和服务检查通过，
不代表客户端已信任 Hooks 或模型已使用记忆。

模型、中转地址和 API Key 仍由 Codex 配置。自定义 `REPOMIND_DATA_DIR` 时，
setup 与 Codex 必须保持一致。不要同时开启另一套 RepoMind MCP 会话生命周期。

每轮提问自动召回记忆，工具前后记录活动，Stop 保存回答并结束任务，Interrupt
放弃当前回合，SessionEnd 清理未完成任务。会话和回合标识校验防止旧事件误写新任务。
带子 Agent 标识的事件不会结束或污染主任务。

**当前 Codex 0.165 的 Bash Hook 只有 stdout，没有退出码，命令失败也一样。**
因此会保存命令活动，但不能凭输出或模型自述生成“已验证命令”。
测试、构建或 lint 缺少明确退出码时，任务记为 partial，不生成成功任务记忆。
没有未解决验证步骤的文件修改任务，仍可按现有质量规则生成记忆。
客户端若提供明确的结构化退出码，可正常转为命令证据。
可以正常召回 Pi、Claude 或 OpenCode 已验证并保存的命令。

正常请求可自动恢复已停止的默认 Bridge。中断和退出 Hooks 最长只有 3 秒，
只执行短请求，不启动恢复流程。失败会提示并允许继续工作，没有离线补写队列。
不解析 Codex 未稳定的 transcript 格式，不改写或重复执行命令来补造证据。

本次验证范围为本地 Codex CLI；桌面端及云端需要分别验证。
未新增 `repomind run --runner codex`。

详见 [英文说明](../docs/codex-integration.md) 和 [Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)。
