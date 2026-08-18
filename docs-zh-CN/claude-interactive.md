# Claude Code 无感交互集成（第一阶段）

该集成让用户直接运行 Claude Code，同时由项目 Hook、Tencent MemoryProxy 和
RepoMind Bridge 自动完成召回、L0 活动记录以及任务结束提交。它不使用
`repomind run`，也不要求 Claude 调用 `repo_session_start` 或
`repo_session_commit`。

## 组件边界

```text
Claude Code --Anthropic API--> MemoryProxy --turn events--+
     |                                                  |
     +--project hooks--> RepoMind Bridge <--------------+
                              |
                              +--> RepositoryMemoryCore / SQLite
```

- `MemoryProxy` 写回主对话的 user/assistant turn。
- Claude 项目 Hook 注册 `session_id` 与仓库路径，记录工具结果并管理任务边界。
- Bridge 是唯一能调用 RepoMind Core 和仓库数据库的组件。

## 构建与启动

先初始化目标仓库并构建 RepoMind：

```powershell
npm.cmd run build
node D:\path\to\repomind\dist\cli\entry.js init --repo D:\path\to\repository
```

启动本机 Bridge：

```powershell
node D:\path\to\repomind\dist\cli\entry.js bridge
```

Bridge 默认只监听 `127.0.0.1:7345`。需要 bearer token 时，在 Bridge、
MemoryProxy 和启动 Claude 的终端中设置相同的 `REPOMIND_BRIDGE_TOKEN`。

将 RepoMind Hook 合并到目标仓库现有 Claude 设置：

```powershell
node D:\path\to\repomind\dist\cli\entry.js claude-hook-install `
  --repo D:\path\to\repository `
  --bridge-url http://127.0.0.1:7345
```

安装器只追加 RepoMind 定义，并保留 `.claude/settings.local.json` 中已有的权限和
其他 Hook。重复执行具有幂等性。

## MemoryProxy

RepoMind 的第一阶段适配代码位于已检出的
`tmp/TencentDB-Agent-Memory/MemoryProxy/src/repomind/client.ts`。按 TencentDB
项目的安装文档配置并启动 MemoryProxy，同时设置：

```powershell
$env:REPOMIND_BRIDGE_URL = "http://127.0.0.1:7345"
```

也可以直接写入 MemoryProxy 的 `config.yaml`，避免后台启动脚本丢失环境变量：

```yaml
repomind:
  enabled: true
  bridgeUrl: http://127.0.0.1:7345
  bridgeToken: ""
  timeoutMs: 3000
```

启动日志出现 `repomind.bridge {"enabled":true,...}` 才表示回流已启用。

未设置该变量时，新增回流路径完全禁用，Proxy 保持原行为。Claude Code 继续按
MemoryProxy 文档将 Anthropic base URL 指向：

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8096/claude-code/default"
claude
```

## 生命周期

| Claude Hook | RepoMind 行为 |
| --- | --- |
| `SessionStart` | 注册 Claude Session 与当前仓库 |
| `UserPromptSubmit` | 创建 RepoMind Session、读取 Git baseline、注入 L1/L2/L3 |
| `PreToolUse` | 写入 L0 tool call |
| `PostToolUse` | 写入 L0 tool result；Shell/测试结果在 finish 时转为 Evidence |
| `PostToolUseFailure` | 写入失败活动，并使默认结果降为 `partial` |
| `Stop` | 保存最终回答、读取最终 Git 状态并自动 commit |
| `SessionEnd` | 放弃仍未结束的任务，保留已写 L0 |

每个 `UserPromptSubmit -> Stop` 是一个 RepoMind 任务。每个活动都有幂等事件 ID，
payload 在写入 SQLite 前经过 RepoMind 脱敏。Streaming Proxy 写入使用原项目的
pending-write、重试和 SIGTERM flush 机制。

## 当前阶段限制

- 第一阶段只接入 Claude Code；OpenCode/Codex Adapter 尚未接入。
- Bridge Session 到仓库的路由缓存在进程内；Claude Hook 会在每个事件前重新注册，
  但 Bridge 重启到下一个 Hook 事件之间到达的纯 Proxy 事件会被拒绝而不是跨仓库存储。
- `Stop` 后先提交确定性 Evidence 和 L1 Memory，再自动重建 L2 Module Narratives 与
  L3 Repository Profile。只有成功提交的任务会提升到 L2/L3；没有稳定 L1 时，
  对应阶段会返回 `skipped`。L2/L3 维护失败会记录在 `maintenance` 返回值中，
  不会回滚或阻断主任务提交。异步 LLM 候选 Pipeline 和 idle finalizer 尚未加入。
- 当前逻辑 export 不包含 `activity_events`；物理 backup 会包含完整 SQLite 数据。
