# Claude Code 无感交互集成

该集成让用户直接运行 Claude Code，由项目 Hook 和本机 RepoMind Bridge 自动完成
召回、L0 活动记录以及任务结束提交。它不使用 `repomind run`，不要求 Claude 调用
`repo_session_start` 或 `repo_session_commit`，也不代理 Claude 的模型流量。

## 组件边界

```text
Claude Code --项目 Hook--> RepoMind Bridge --> RepositoryMemoryCore / SQLite
     |
     +--Anthropic API（不变：使用你自己的 endpoint 和凭据）
```

- Claude 项目 Hook 注册 `session_id` 与仓库路径，召回上下文，记录工具结果并管理任务边界。
- Bridge 是唯一能调用 RepoMind Core 和仓库数据库的组件。

## 日常使用

在 RepoMind 源码目录执行一次（可重复执行），完成仓库初始化、Hook 安装或修复，并启动
本机 Bridge：

```powershell
repomind claude setup --repo D:\path\to\repository
```

然后在目标仓库中正常运行 Claude Code：

```powershell
claude
```

只检查、不修改：

```powershell
repomind doctor claude --repo D:\path\to\repository
```

## 从 MemoryProxy 路由升级

旧版本会在仓库的 `.claude/settings.local.json` 中写入
`ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/...`，让 Claude 经过
MemoryProxy。重新执行 `repomind claude setup` 会移除这个由 RepoMind 写入的值，并在
`status.warnings` 中说明；`doctor claude` 会提示仍带有该值的仓库。其他
`ANTHROPIC_BASE_URL` 不会被改动。

移除后 Claude 使用你用户级的 endpoint。如果 MemoryProxy 之前转发到自定义上游
（其 `config.yaml` 的 `upstream.url`），请在你自己的 Claude 设置或终端中把
`ANTHROPIC_BASE_URL` 设为该上游。MemoryProxy 的回流只把原始 user/assistant 文本
写入 L0；召回、Evidence 和记忆一直来自 Hook，因此不会丢失任何能力。

如果确实要继续经过 MemoryProxy，请显式指定：
`repomind claude setup --proxy-url http://127.0.0.1:8096/claude-code/default`。
该模式会同时启动两个服务，并需要 MemoryProxy 自身的配置和依赖
（见 [`services/README.md`](../services/README.md)）。

## 手动配置

```powershell
npm.cmd run build
node D:\path\to\repomind\dist\cli\entry.js init --repo D:\path\to\repository
node D:\path\to\repomind\dist\cli\entry.js bridge
node D:\path\to\repomind\dist\cli\entry.js claude-hook-install `
  --repo D:\path\to\repository `
  --bridge-url http://127.0.0.1:7345
```

安装器只追加 RepoMind 定义，保留 `.claude/settings.local.json` 中已有的权限和其他
Hook，重复执行具有幂等性。Hook 命令写入了 Node 和 RepoMind CLI 的绝对路径，移动
源码目录后需要重新执行 setup。

Bridge 只监听 `127.0.0.1:7345`，并始终要求 bearer token。首次启动时会生成随机
token，保存到 `REPOMIND_DATA_DIR/bridge.token`（默认 `~/.repomind/bridge.token`），
权限仅限当前用户；Hook 读取同一个文件，同一台机器上无需额外配置。如果设置了
`REPOMIND_DATA_DIR`，启动 Claude 的终端也需要设置同样的值，或者为 Bridge 和 Claude
设置相同的 `REPOMIND_BRIDGE_TOKEN`，环境变量优先于文件。此外，Bridge 会拒绝浏览器
请求（带 `Origin` 头）、非 JSON 写入，以及 `Host` 头不是 loopback 的请求。

## 生命周期

| Claude Hook | RepoMind 行为 |
| --- | --- |
| `SessionStart` | 注册 Claude Session 与当前仓库 |
| `UserPromptSubmit` | 创建 RepoMind Session、读取 Git baseline、注入 L1/L2/L3 |
| `PreToolUse` | 写入 L0 tool call |
| `PostToolUse` | 写入 L0 tool result |
| `PostToolUseFailure` | 写入失败活动；提交时仍未解决的验证失败使任务成为 `partial` |
| `Stop` | 保存最终回答、读取最终 Git 状态并自动 commit |
| `SessionEnd` | 放弃仍未结束的任务，保留已写 L0 |

每个 `UserPromptSubmit -> Stop` 是一个 RepoMind 任务。每个活动都有幂等事件 ID，
写入 SQLite 前经过 RepoMind 脱敏。

Claude Code 不为 Shell 命令报告退出码：非零退出会触发 `PostToolUseFailure` 而不是
`PostToolUse`。因此 RepoMind 把已完成、前台、未中断的 `Bash`/`PowerShell`
`PostToolUse` 记为观察到的退出码 0，通过的测试才能成为已验证的 `command` 记忆。
被中断或后台运行（`run_in_background`）的命令保持未知；如果属于已识别的验证步骤，
并且后续没有可信的通过记录，任务以 `partial` 提交。
如果测试之后还有可能覆盖退出码的命令（`npm test | tail`、`npm test; echo`、
`npm test || true`），只记为普通命令证据，不算已验证的测试。

`Stop` 后先提交确定性 Evidence 和 L1 Memory，再自动重建 L2 Module Narratives 与
L3 Repository Profile。只有成功提交的任务会提升到 L2/L3；没有稳定来源时对应阶段
返回 `skipped`；维护失败记录在返回值中，不会回滚已提交的任务。

## 交互任务会记住什么

以下规则适用于所有交互任务（Claude Hook 和 OpenCode 插件）。显式的
`repomind commit` / MCP 提交以及 `repomind run` 保持各自原有行为。

- **solution 需要仓库成果。** 成功任务相对开始基线有文件变更，或存在工具观测／
  Host 验证的测试通过证据，才保存 solution；调用方自报通过不满足条件。标题取首个
  有实际内容的句子，跳过 Markdown 标题、代码块和冒号引导句，过长时使用完整的兜底标题。
- **可信通过的命令复用原记忆。** 追加证据、刷新验证时间、文件指纹和全文索引，记录
  `memory_revalidated`；不自动复活旧记录，但新的可信通过可创建关联旧历史的新记录，
  后续通过只更新新记录。工作目录、环境步骤、引号
  内参数保留在命令身份中，只移除引号外的输出重定向。
- **恢复必须有同一检查的可信通过结果。** 组合命令中的测试、构建、类型检查和 lint
  逐项跟踪；其他目录的测试不能抵消失败。管道、后台执行和 `npm test || true` 不证明
  测试通过。被掩盖的 Shell 结果本身不导致 partial，也不能解除先前失败；缺失、
  中断或后台结果仍使验证保持未完成。`ls test`、`cat` 等探索不当作测试。识别支持已知 runner
  和简单 shell 语法，不等同于完整 shell 解释器，也不推断任意别名或自定义脚本。
- **召回审计对应最终文本。** 首条用户活动记录脱敏后的上下文快照、SHA-256、实际保留
  的 L1/L2/L3 ID、派生层版本、字符数及部分截断信息；`repomind sessions --json`
  显示首次 `recall`。后续独立召回及恢复开始请求各写一条 `kind: recall` 的 L0 活动。
  阶段为 `generated`，不声称宿主已经投递或模型已经消费。已完成的任务开始事件被重放
  时会拒绝请求，不创建新的孤立 Session。

## 当前限制

- Bridge Session 到仓库的路由缓存在进程内；Hook 会在每个事件前重新注册。
- 逻辑 export 不包含 L0 `activity_events`；物理 backup 包含完整 SQLite 数据。
- 异步 LLM 提取和 idle finalizer 尚未加入。
