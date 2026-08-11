# RepoMind v0.13 质量与跨 Agent Evidence

## 覆盖率

完整 144 测试套件使用 Vitest 3.2.7 和匹配 V8 提供方测量。覆盖率仅包含 `src/**/*.ts`，因此 benchmark fixture 和生成的测试仓库不会稀释或抬高产品代码结果。

| 指标 | 本地基线 | 强制下限 |
| --- | ---: | ---: |
| Statements | 83.00% | 80% |
| Branches | 77.14% | 75% |
| Functions | 94.33% | 90% |
| Lines | 83.00% | 80% |

`npm run test:coverage` 生成文本、HTML、JSON summary 和 LCOV 报告。CI 构建包、在 Ubuntu 上运行相同命令并上传完整 `coverage/` 目录。这些下限是初始回归守卫，不代表每条关键路径均已获得充分测试。

## macOS

主 CI 验证矩阵除 Ubuntu 和 Windows 外还包含 `macos-latest`。GitHub Actions [CI run 30358584725](https://github.com/Nei-Xin/repomind/actions/runs/30358584725) 于 2026-07-28 为 commit `fd8093c` 通过全部五个 job。macOS job 用时 1 分 24 秒，通过安装、typecheck、build、全部 144 个测试和可重建八任务 Agent fixture 验证。Ubuntu、Windows、coverage 和 comparison benchmark job 也通过。Coverage artifact 为 690 KB，digest 为 `sha256:ab379442663256d35a4c5fde2e62a124ac90ac9fdad71c2a88d4a1b91c176a2b`。

## 第二个真实 Coding Agent

验收目标是由真实 OpenCode 运行创建的现有 v0.10 仓库和数据目录。验收使用 Claude Code 2.1.220，以及隔离的 `--mcp-config` 和 `--strict-mcp-config`；它没有修改 OpenCode 或 Codex 配置。Claude Code 使用其配置的 `gpt-5.6-luna` 模型，因此这里证明的是第二个真实 Agent 宿主和 MCP 客户端，而不是 Anthropic 模型对比。

第一次尝试在 MCP 前因 OAuth Session 过期而阻塞。恢复认证后，2026-07-28 的正式运行通过：

- Claude Code 发现全部 18 个 RepoMind 工具，并报告 MCP 服务器已连接。
- `repo_memory_search` 读取早期 OpenCode 运行创建的四条 Memory，包括同一条 active 已验证命令 Memory 和两条过期警告。
- `repo_memory_inspect` 返回 Memory `mem_fecf31ac-3e60-424d-9bfa-2723e78b6811`、一项 `test_result` Evidence、commit `2e0a80822d00aa387995131c58079288ec0ebd04` 和三个相关文件。
- `repo_profile_rebuild` 从合格的 OpenCode 创建 L1 来源生成 current L3 Profile `l3_41d61e91-a4bd-4282-8a7b-d80d63947c67` 版本 1。
- `repo_session_start` 注入该 current Profile。独立 Claude Code 进程为 `ses_0ad277d1-fa45-4aef-8e62-9be530378fef` 调用 `repo_session_abandon`。
- 新 Claude Code Session 独立重复 Memory 搜索，并通过 `repo_profile_get` 检索到同一持久 L3 Profile。
- CLI 验证报告四条 Memory、一个 Repository Profile、无 open Session、无 running Host Run，目标 Git worktree 干净。

隔离配置、提示、初始认证失败和最终验收 summary 保存在：

```text
D:\data\code\project\repomind-test\v0.13-cross-agent-claude-20260728
```

结果：**通过验收**。这证明 OpenCode 和 Claude Code 可在独立进程中访问同一个 repository-scoped RepoMind 数据库。它不评估相对模型质量或远程 LLM 提取。
