# Pi 原生接入

支持 Pi coding agent，首个验证版本为 **1.4.0**
（`@earendil-works/pi-coding-agent`）。RepoMind 需要 Node.js 22.5+。

```bash
repomind pi setup --repo /path/to/repository
repomind doctor pi --repo /path/to/repository
cd /path/to/repository
pi
```

安装命令初始化记忆、生成 `.pi/extensions/repomind.ts` 并启动本机 Bridge。
在 Pi 中信任项目扩展；已经运行的会话需要重启或执行 `/reload`。
移动 RepoMind 后重新运行 setup。安装会保留其他扩展，不覆盖同名的非托管文件。
`repomind pi status` 检查安装、版本和 Bridge，不能确认客户端的信任选择或模型是否使用了记忆。

模型、中转地址和 API Key 继续由 Pi 配置。RepoMind 不修改模型路由。
自定义 `REPOMIND_DATA_DIR` 时，setup 与 Pi 必须使用相同的目录。
不要同时启用另一套由模型调用的 RepoMind MCP 会话生命周期。

每轮运行前自动召回 L1–L3 记忆，以隐藏消息注入；工具调用及结果自动记录。
Shell 退出码使用客户端提供的结构化数据，缺失时保留为未知，不从输出文字推断成功。
最终以 `agent_settled` 收尾，避免在内部重试、压缩或后续运行之前提前提交。
取消任务记为 abandoned；最终模型错误记为 failed；截断回答记为 partial。
退出、重载、切换、分叉或导航会话分支时，未完成任务会被放弃。

默认 Bridge 停止后会尝试自动恢复；其他错误提示后允许 Pi 继续工作。
没有离线补写队列，强杀进程不能保证收尾。沿用现有敏感信息过滤和记忆质量规则。
Pi 生成的记忆可以被同仓库、同数据目录下的 Claude、OpenCode 和 Codex 召回。

验证范围为本地 Pi CLI，包括原生交互模式；未新增 `repomind run --runner pi`，
第三方子 Agent 扩展的独立生命周期不在本次保证范围内。

详见 [英文说明](../docs/pi-integration.md) 和 [Pi 扩展文档](https://pi.dev/docs/latest/extensions)。
